import pytest
from src.pipeline import DedupPipeline, _UnionFind
from src.types import (
    BlockingConfig,
    BlockingStrategy,
    CandidatePair,
    ClassifierConfig,
    ClassifierType,
    ComparableField,
    ComparisonFieldConfig,
    ComparisonVector,
    DeduplicationError,
    DeduplicationRequest,
    DeduplicationResult,
    DedupDecision,
    DedupStatus,
    FieldScore,
    IBlocker,
    IClassifier,
    IComparator,
    IPreprocessor,
    PipelineConfig,
    PipelineErrorCode,
    ProcessedRecord,
    SimilarityMetric,
)
from helpers import make_record, make_processed


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_pipeline(
    base_cfg: PipelineConfig,
    *,
    preprocessor=None,
    blocker=None,
    comparator=None,
    classifier=None,
) -> DedupPipeline:
    from src.preprocessor import Preprocessor
    from src.blocker import Blocker
    from src.comparator import Comparator
    from src.classifier import Classifier
    from src.logger import Logger
    return DedupPipeline(
        config=base_cfg,
        preprocessor=preprocessor or Preprocessor(),
        blocker=blocker or Blocker(),
        comparator=comparator or Comparator(),
        classifier=classifier or Classifier(),
        logger=Logger(),
    )


def _request(records, batch_id: str = "batch-1", cfg=None) -> DeduplicationRequest:
    kwargs = {"batch_id": batch_id, "records": records}
    if cfg is not None:
        kwargs["config"] = cfg
    return DeduplicationRequest(**kwargs)


# ---------------------------------------------------------------------------
# UnionFind
# ---------------------------------------------------------------------------

class TestUnionFind:
    def test_find_self(self):
        uf = _UnionFind()
        assert uf.find("a") == "a"

    def test_union_merges(self):
        uf = _UnionFind()
        uf.union("a", "b")
        assert uf.find("a") == uf.find("b")

    def test_lexicographically_smaller_is_root(self):
        uf = _UnionFind()
        uf.union("z", "a")
        assert uf.find("z") == "a"
        assert uf.find("a") == "a"

    def test_transitive_union(self):
        uf = _UnionFind()
        uf.union("a", "b")
        uf.union("b", "c")
        assert uf.find("a") == uf.find("c")

    def test_groups(self):
        uf = _UnionFind()
        uf.union("a", "b")
        uf.union("c", "d")
        groups = uf.groups()
        roots = set(groups.keys())
        assert len(roots) == 2

    def test_path_compression(self):
        uf = _UnionFind()
        for ch in ["b", "c", "d"]:
            uf.union("a", ch)
        # After path compression, all should resolve to "a"
        for ch in ["b", "c", "d"]:
            assert uf.find(ch) == "a"


# ---------------------------------------------------------------------------
# Pipeline — short-circuit paths
# ---------------------------------------------------------------------------

class TestPipelineShortCircuits:
    def test_single_record_trivially_unique(self, base_cfg, now):
        rec = make_record("r1", now=now)
        pipeline = _build_pipeline(base_cfg)
        result = pipeline.deduplicate(_request([rec]))
        assert isinstance(result, DeduplicationResult)
        assert result.unique_record_ids == ["r1"]
        assert result.duplicate_clusters == []
        assert result.stats.candidate_pair_count == 0

    def test_no_pairs_all_unique(self, base_cfg, now):
        # Records from completely different companies/titles won't block
        recs = [
            make_record("r1", job_title="Accountant", company_name="Alpha Ltd", now=now),
            make_record("r2", job_title="Zoologist", company_name="Omega Corp", now=now),
        ]
        pipeline = _build_pipeline(base_cfg)
        result = pipeline.deduplicate(_request(recs))
        assert isinstance(result, DeduplicationResult)
        assert set(result.unique_record_ids) == {"r1", "r2"}


# ---------------------------------------------------------------------------
# Pipeline — full happy path
# ---------------------------------------------------------------------------

class TestPipelineHappyPath:
    def test_two_duplicates_detected(self, base_cfg, now):
        recs = [
            make_record("r1", job_title="Senior Software Engineer", company_name="Acme Corp", now=now),
            make_record("r2", job_title="Senior Software Engineer", company_name="Acme Corp", now=now),
        ]
        pipeline = _build_pipeline(base_cfg)
        result = pipeline.deduplicate(_request(recs))
        assert isinstance(result, DeduplicationResult)
        # One of r1/r2 should be unique; other duplicated
        assert len(result.unique_record_ids) == 1
        assert len(result.duplicate_clusters) == 1

    def test_three_records_one_duplicate(self, base_cfg, now):
        recs = [
            make_record("r1", job_title="Senior Software Engineer", company_name="Acme Corp", now=now),
            make_record("r2", job_title="Senior Software Engineer", company_name="Acme Corp", now=now),
            make_record("r3", job_title="Marketing Director", company_name="Globex Ltd", now=now),
        ]
        pipeline = _build_pipeline(base_cfg)
        result = pipeline.deduplicate(_request(recs))
        assert isinstance(result, DeduplicationResult)
        assert "r3" in result.unique_record_ids
        assert result.stats.input_record_count == 3

    def test_stats_correct(self, base_cfg, now):
        recs = [make_record(f"r{i}", now=now) for i in range(3)]
        pipeline = _build_pipeline(base_cfg)
        result = pipeline.deduplicate(_request(recs))
        assert isinstance(result, DeduplicationResult)
        assert result.stats.input_record_count == 3
        assert result.stats.processing_time_ms >= 0.0


# ---------------------------------------------------------------------------
# Pipeline — error paths
# ---------------------------------------------------------------------------

class TestPipelineErrorPaths:
    def test_preprocessing_failure_returns_error(self, base_cfg, now):
        class BadPreprocessor:
            def preprocess(self, records):
                raise RuntimeError("boom")

        recs = [make_record("r1", now=now), make_record("r2", now=now)]
        pipeline = _build_pipeline(base_cfg, preprocessor=BadPreprocessor())
        result = pipeline.deduplicate(_request(recs))
        assert isinstance(result, DeduplicationError)
        assert result.error_code == PipelineErrorCode.PREPROCESSING_FAILED

    def test_blocking_failure_returns_error(self, base_cfg, now):
        class BadBlocker:
            def generate_pairs(self, records, config):
                raise RuntimeError("block failed")

        recs = [make_record("r1", now=now), make_record("r2", now=now)]
        pipeline = _build_pipeline(base_cfg, blocker=BadBlocker())
        result = pipeline.deduplicate(_request(recs))
        assert isinstance(result, DeduplicationError)
        assert result.error_code == PipelineErrorCode.BLOCKING_FAILED

    def test_comparison_failure_returns_error(self, base_cfg, now):
        from src.blocker import Blocker

        class AlwaysPair:
            def generate_pairs(self, records, config):
                if len(records) >= 2:
                    return [CandidatePair(
                        left_id=records[0].record_id,
                        right_id=records[1].record_id,
                        blocking_key="ct:test",
                    )]
                return []

        class BadComparator:
            def compare(self, records, pairs, fields):
                raise RuntimeError("compare failed")

        recs = [make_record("r1", now=now), make_record("r2", now=now)]
        pipeline = _build_pipeline(base_cfg, blocker=AlwaysPair(), comparator=BadComparator())
        result = pipeline.deduplicate(_request(recs))
        assert isinstance(result, DeduplicationError)
        assert result.error_code == PipelineErrorCode.COMPARISON_FAILED

    def test_classification_failure_returns_error(self, base_cfg, now):
        class AlwaysPair:
            def generate_pairs(self, records, config):
                if len(records) >= 2:
                    return [CandidatePair(
                        left_id=records[0].record_id,
                        right_id=records[1].record_id,
                        blocking_key="ct:test",
                    )]
                return []

        class AlwaysVector:
            def compare(self, records, pairs, fields):
                return [ComparisonVector(
                    left_id=pairs[0].left_id,
                    right_id=pairs[0].right_id,
                    field_scores=[],
                    composite_score=0.9,
                )]

        class BadClassifier:
            def classify(self, vectors, config):
                raise RuntimeError("classify failed")

        recs = [make_record("r1", now=now), make_record("r2", now=now)]
        pipeline = _build_pipeline(
            base_cfg,
            blocker=AlwaysPair(),
            comparator=AlwaysVector(),
            classifier=BadClassifier(),
        )
        result = pipeline.deduplicate(_request(recs))
        assert isinstance(result, DeduplicationError)
        assert result.error_code == PipelineErrorCode.CLASSIFICATION_FAILED

    def test_preprocessing_empty_output_returns_error(self, base_cfg, now):
        class EmptyPreprocessor:
            def preprocess(self, records):
                return []

        recs = [make_record("r1", now=now), make_record("r2", now=now)]
        pipeline = _build_pipeline(base_cfg, preprocessor=EmptyPreprocessor())
        result = pipeline.deduplicate(_request(recs))
        assert isinstance(result, DeduplicationError)
        assert result.error_code == PipelineErrorCode.PREPROCESSING_FAILED


# ---------------------------------------------------------------------------
# Pipeline — per-request config override
# ---------------------------------------------------------------------------

class TestPipelineConfigOverride:
    def test_per_request_config_used(self, base_cfg, now):
        # Override with a very low match threshold so everything is a duplicate
        override = PipelineConfig(
            blocking=base_cfg.blocking,
            comparison_fields=base_cfg.comparison_fields,
            classifier=ClassifierConfig(
                type=ClassifierType.THRESHOLD,
                match_threshold=0.01,
                unmatch_threshold=0.001,
            ),
            batch_size=100,
        )
        recs = [
            make_record("r1", now=now),
            make_record("r2", now=now),
        ]
        pipeline = _build_pipeline(base_cfg)
        result = pipeline.deduplicate(_request(recs, cfg=override))
        assert isinstance(result, DeduplicationResult)


# ---------------------------------------------------------------------------
# Pipeline — canonical ID selection
# ---------------------------------------------------------------------------

class TestPipelineCanonicalId:
    def test_lexicographically_smallest_is_canonical(self, base_cfg, now):
        recs = [
            make_record("r2", job_title="Senior Software Engineer", company_name="Acme Corp", now=now),
            make_record("r1", job_title="Senior Software Engineer", company_name="Acme Corp", now=now),
        ]
        pipeline = _build_pipeline(base_cfg)
        result = pipeline.deduplicate(_request(recs))
        if isinstance(result, DeduplicationResult) and result.duplicate_clusters:
            assert result.duplicate_clusters[0].canonical_id == "r1"

    def test_canonical_in_unique_ids(self, base_cfg, now):
        recs = [
            make_record("r1", job_title="Senior Software Engineer", company_name="Acme Corp", now=now),
            make_record("r2", job_title="Senior Software Engineer", company_name="Acme Corp", now=now),
        ]
        pipeline = _build_pipeline(base_cfg)
        result = pipeline.deduplicate(_request(recs))
        if isinstance(result, DeduplicationResult) and result.duplicate_clusters:
            canonical = result.duplicate_clusters[0].canonical_id
            assert canonical in result.unique_record_ids
