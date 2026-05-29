"""
Full deduplication pipeline orchestrator.
Never raises — all failure paths return DeduplicationError.
"""
from __future__ import annotations

import time

from .blocker import Blocker
from .classifier import Classifier
from .comparator import Comparator
from .logger import Logger
from .preprocessor import Preprocessor
from .types import (
    DeduplicationError,
    DeduplicationRequest,
    DeduplicationResult,
    DedupDecision,
    DedupStatus,
    DuplicateCluster,
    IBlocker,
    IClassifier,
    IComparator,
    IPreprocessor,
    PipelineConfig,
    PipelineErrorCode,
    PipelineStats,
)


# ---------------------------------------------------------------------------
# Union-Find for cluster building
# ---------------------------------------------------------------------------

class _UnionFind:
    def __init__(self) -> None:
        self._parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        if x not in self._parent:
            self._parent[x] = x
        if self._parent[x] != x:
            self._parent[x] = self.find(self._parent[x])
        return self._parent[x]

    def union(self, x: str, y: str) -> None:
        px, py = self.find(x), self.find(y)
        if px != py:
            # Smaller ID lexicographically becomes root (stable canonical choice)
            if px < py:
                self._parent[py] = px
            else:
                self._parent[px] = py

    def groups(self) -> dict[str, list[str]]:
        result: dict[str, list[str]] = {}
        for node in self._parent:
            root = self.find(node)
            result.setdefault(root, []).append(node)
        return result


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

class DedupPipeline:
    """
    Implements IPipeline. Wire up via DedupPipeline.create() for production
    or inject custom implementations for testing.
    """

    def __init__(
        self,
        config: PipelineConfig,
        preprocessor: IPreprocessor,
        blocker: IBlocker,
        comparator: IComparator,
        classifier: IClassifier,
        logger: Logger,
    ) -> None:
        self._config = config
        self._preprocessor = preprocessor
        self._blocker = blocker
        self._comparator = comparator
        self._classifier = classifier
        self._logger = logger

    @classmethod
    def create(cls, config: PipelineConfig) -> "DedupPipeline":
        logger = Logger()
        return cls(
            config=config,
            preprocessor=Preprocessor(),
            blocker=Blocker(),
            comparator=Comparator(),
            classifier=Classifier(),
            logger=logger,
        )

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def deduplicate(
        self, request: DeduplicationRequest
    ) -> DeduplicationResult | DeduplicationError:
        cfg = request.config or self._config
        start = time.monotonic()
        batch_id = request.batch_id

        self._logger.info("pipeline.started", batch_id, record_count=len(request.records))

        # Short-circuit: nothing to deduplicate
        if len(request.records) < 2:
            self._logger.info("pipeline.trivial", batch_id)
            return DeduplicationResult(
                batch_id=batch_id,
                unique_record_ids=[r.record_id for r in request.records],
                duplicate_clusters=[],
                decisions=[],
                stats=PipelineStats(
                    input_record_count=len(request.records),
                    candidate_pair_count=0,
                    comparison_count=0,
                    duplicate_pair_count=0,
                    unique_record_count=len(request.records),
                    cluster_count=0,
                    processing_time_ms=0.0,
                ),
            )

        # Step 1 — Preprocess
        try:
            processed = self._preprocessor.preprocess(request.records)
        except Exception as exc:
            return self._error(batch_id, PipelineErrorCode.PREPROCESSING_FAILED, exc)

        if not processed:
            return self._error(
                batch_id,
                PipelineErrorCode.PREPROCESSING_FAILED,
                Exception("Preprocessing produced no output records"),
            )

        # Step 2 — Block (generate candidate pairs)
        try:
            pairs = self._blocker.generate_pairs(processed, cfg.blocking)
        except Exception as exc:
            return self._error(batch_id, PipelineErrorCode.BLOCKING_FAILED, exc)

        self._logger.debug("pipeline.blocked", batch_id, pair_count=len(pairs))

        if not pairs:
            all_ids = [r.record_id for r in request.records]
            elapsed = (time.monotonic() - start) * 1000
            self._logger.info("pipeline.no_pairs", batch_id)
            return DeduplicationResult(
                batch_id=batch_id,
                unique_record_ids=all_ids,
                duplicate_clusters=[],
                decisions=[],
                stats=PipelineStats(
                    input_record_count=len(request.records),
                    candidate_pair_count=0,
                    comparison_count=0,
                    duplicate_pair_count=0,
                    unique_record_count=len(all_ids),
                    cluster_count=0,
                    processing_time_ms=round(elapsed, 1),
                ),
            )

        # Step 3 — Compare
        try:
            vectors = self._comparator.compare(
                processed, pairs, cfg.comparison_fields
            )
        except Exception as exc:
            return self._error(batch_id, PipelineErrorCode.COMPARISON_FAILED, exc)

        # Step 4 — Classify
        try:
            decisions = self._classifier.classify(vectors, cfg.classifier)
        except Exception as exc:
            return self._error(batch_id, PipelineErrorCode.CLASSIFICATION_FAILED, exc)

        # Step 5 — Build clusters and unique set
        result = self._build_result(batch_id, request, decisions, pairs, start)
        self._logger.info(
            "pipeline.completed",
            batch_id,
            unique=result.stats.unique_record_count,
            clusters=result.stats.cluster_count,
            duration_ms=result.stats.processing_time_ms,
        )
        return result

    # ------------------------------------------------------------------
    # Cluster building
    # ------------------------------------------------------------------

    def _build_result(
        self,
        batch_id: str,
        request: DeduplicationRequest,
        decisions: list[DedupDecision],
        pairs: list,
        start: float,
    ) -> DeduplicationResult:
        uf = _UnionFind()

        dup_count = 0
        for dec in decisions:
            if dec.status == DedupStatus.DUPLICATE:
                uf.union(dec.left_id, dec.right_id)
                dup_count += 1

        # Identify all record IDs that appeared in a duplicate decision
        all_input_ids = {r.record_id for r in request.records}
        grouped = uf.groups()

        clusters: list[DuplicateCluster] = []
        duplicated_ids: set[str] = set()

        for canonical_id, members in grouped.items():
            if len(members) < 2:
                continue
            # Only include members that are in our input batch
            batch_members = [m for m in members if m in all_input_ids]
            if len(batch_members) < 2:
                continue
            clusters.append(
                DuplicateCluster(
                    canonical_id=canonical_id,
                    member_ids=sorted(batch_members),
                )
            )
            # Non-canonical members are considered duplicates
            for m in batch_members:
                if m != canonical_id:
                    duplicated_ids.add(m)

        unique_ids = sorted(all_input_ids - duplicated_ids)
        elapsed = (time.monotonic() - start) * 1000

        return DeduplicationResult(
            batch_id=batch_id,
            unique_record_ids=unique_ids,
            duplicate_clusters=clusters,
            decisions=decisions,
            stats=PipelineStats(
                input_record_count=len(request.records),
                candidate_pair_count=len(pairs),
                comparison_count=len(decisions),
                duplicate_pair_count=dup_count,
                unique_record_count=len(unique_ids),
                cluster_count=len(clusters),
                processing_time_ms=round(elapsed, 1),
            ),
        )

    def _error(
        self,
        batch_id: str,
        code: PipelineErrorCode,
        exc: Exception,
    ) -> DeduplicationError:
        self._logger.error("pipeline.failed", batch_id, error_code=code, exc=exc)
        return DeduplicationError(
            batch_id=batch_id,
            error_code=code,
            message=str(exc),
        )
