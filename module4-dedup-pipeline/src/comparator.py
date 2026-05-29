import math

import pandas as pd
import recordlinkage

from .types import (
    CandidatePair,
    ComparableField,
    ComparisonFieldConfig,
    ComparisonVector,
    FieldScore,
    ProcessedRecord,
    SimilarityMetric,
)

_METRIC_METHOD: dict[SimilarityMetric, str] = {
    SimilarityMetric.JARO_WINKLER: "jarowinkler",
    SimilarityMetric.COSINE: "cosine",
    SimilarityMetric.LEVENSHTEIN: "levenshtein",
}


def _safe(val: float | None) -> float:
    if val is None or math.isnan(val) or math.isinf(val):
        return 0.0
    return max(0.0, min(1.0, float(val)))


class Comparator:
    """
    Implements IComparator using recordlinkage's Compare engine backed by
    pandas DataFrames. Pairs referencing unknown record_ids are silently
    dropped. Field-level NaN scores (e.g. both strings empty) are clamped to 0.
    """

    def compare(
        self,
        records: list[ProcessedRecord],
        pairs: list[CandidatePair],
        fields: list[ComparisonFieldConfig],
    ) -> list[ComparisonVector]:
        if not records or not pairs or not fields:
            return []

        # Build lookup and DataFrame indexed by record_id
        valid_ids = {r.record_id for r in records}
        valid_pairs = [
            p for p in pairs
            if p.left_id in valid_ids and p.right_id in valid_ids
        ]
        if not valid_pairs:
            return []

        columns = [f.field.value for f in fields]
        df = pd.DataFrame(
            [
                {col: getattr(r, col, "") for col in ["record_id"] + columns}
                for r in records
            ]
        ).set_index("record_id")

        pair_index = pd.MultiIndex.from_tuples(
            [(p.left_id, p.right_id) for p in valid_pairs],
            names=["left_id", "right_id"],
        )

        cmp = recordlinkage.Compare()
        for field_cfg in fields:
            col = field_cfg.field.value
            label = field_cfg.field.name
            if field_cfg.metric == SimilarityMetric.EXACT:
                cmp.exact(col, col, label=label)
            else:
                method = _METRIC_METHOD.get(field_cfg.metric, "jarowinkler")
                cmp.string(col, col, method=method, label=label)

        try:
            features: pd.DataFrame = cmp.compute(pair_index, df)
        except Exception:
            return []

        results: list[ComparisonVector] = []
        for (left_id, right_id), row in features.iterrows():
            field_scores: list[FieldScore] = []
            composite = 0.0
            for field_cfg in fields:
                raw = row.get(field_cfg.field.name)
                score = _safe(float(raw) if raw is not None else None)
                field_scores.append(
                    FieldScore(
                        field=field_cfg.field,
                        score=score,
                        metric=field_cfg.metric,
                    )
                )
                composite += score * field_cfg.weight

            results.append(
                ComparisonVector(
                    left_id=str(left_id),
                    right_id=str(right_id),
                    field_scores=field_scores,
                    composite_score=_safe(composite),
                )
            )

        return results
