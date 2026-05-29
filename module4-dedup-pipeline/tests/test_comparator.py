import pytest
from src.comparator import Comparator, _safe
from src.types import (
    CandidatePair,
    ComparableField,
    ComparisonFieldConfig,
    SimilarityMetric,
)
from helpers import make_processed


def _pair(left: str, right: str) -> CandidatePair:
    return CandidatePair(left_id=left, right_id=right, blocking_key="ct:test")


def _field(
    field: ComparableField = ComparableField.JOB_TITLE,
    metric: SimilarityMetric = SimilarityMetric.JARO_WINKLER,
    weight: float = 1.0,
) -> ComparisonFieldConfig:
    return ComparisonFieldConfig(
        field=field,
        metric=metric,
        weight=weight,
        field_match_threshold=0.85,
    )


class TestSafe:
    def test_nan_returns_zero(self):
        import math
        assert _safe(float("nan")) == 0.0

    def test_inf_returns_zero(self):
        assert _safe(float("inf")) == 0.0

    def test_negative_inf_returns_zero(self):
        assert _safe(float("-inf")) == 0.0

    def test_clips_above_one(self):
        assert _safe(1.5) == 1.0

    def test_clips_below_zero(self):
        assert _safe(-0.5) == 0.0

    def test_valid_value_unchanged(self):
        assert _safe(0.7) == pytest.approx(0.7)

    def test_none_returns_zero(self):
        assert _safe(None) == 0.0  # type: ignore[arg-type]


class TestComparator:
    def test_identical_records_score_near_one(self):
        records = [
            make_processed("r1", job_title_tokens="software engineer"),
            make_processed("r2", job_title_tokens="software engineer"),
        ]
        fields = [_field(ComparableField.JOB_TITLE, SimilarityMetric.JARO_WINKLER, 1.0)]
        vectors = Comparator().compare(records, [_pair("r1", "r2")], fields)
        assert len(vectors) == 1
        assert vectors[0].composite_score > 0.95

    def test_different_titles_score_lower(self):
        records = [
            make_processed("r1", job_title_tokens="software engineer"),
            make_processed("r2", job_title_tokens="accountant"),
        ]
        fields = [_field(ComparableField.JOB_TITLE, SimilarityMetric.JARO_WINKLER, 1.0)]
        vectors = Comparator().compare(records, [_pair("r1", "r2")], fields)
        assert vectors[0].composite_score < 0.8

    def test_exact_metric_identical(self):
        records = [
            make_processed("r1", job_function="engineering"),
            make_processed("r2", job_function="engineering"),
        ]
        fields = [_field(ComparableField.JOB_FUNCTION, SimilarityMetric.EXACT, 1.0)]
        vectors = Comparator().compare(records, [_pair("r1", "r2")], fields)
        assert vectors[0].composite_score == pytest.approx(1.0)

    def test_exact_metric_different(self):
        records = [
            make_processed("r1", job_function="engineering"),
            make_processed("r2", job_function="sales"),
        ]
        fields = [_field(ComparableField.JOB_FUNCTION, SimilarityMetric.EXACT, 1.0)]
        vectors = Comparator().compare(records, [_pair("r1", "r2")], fields)
        assert vectors[0].composite_score == pytest.approx(0.0)

    def test_multiple_fields_weighted(self):
        records = [
            make_processed("r1", job_title_tokens="engineer", company_name_normalized="acme"),
            make_processed("r2", job_title_tokens="engineer", company_name_normalized="globex"),
        ]
        fields = [
            _field(ComparableField.JOB_TITLE, SimilarityMetric.JARO_WINKLER, 0.5),
            _field(ComparableField.COMPANY_NAME, SimilarityMetric.JARO_WINKLER, 0.5),
        ]
        vectors = Comparator().compare(records, [_pair("r1", "r2")], fields)
        assert 0.0 < vectors[0].composite_score < 1.0

    def test_unknown_record_id_skipped(self):
        records = [make_processed("r1")]
        pair = _pair("r1", "unknown")
        fields = [_field()]
        vectors = Comparator().compare(records, [pair], fields)
        assert vectors == []

    def test_empty_records_returns_empty(self):
        assert Comparator().compare([], [_pair("r1", "r2")], [_field()]) == []

    def test_empty_pairs_returns_empty(self):
        records = [make_processed("r1"), make_processed("r2")]
        assert Comparator().compare(records, [], [_field()]) == []

    def test_empty_fields_returns_empty(self):
        records = [make_processed("r1"), make_processed("r2")]
        assert Comparator().compare(records, [_pair("r1", "r2")], []) == []

    def test_field_scores_count_matches_fields(self):
        records = [
            make_processed("r1"),
            make_processed("r2"),
        ]
        fields = [
            _field(ComparableField.JOB_TITLE, SimilarityMetric.JARO_WINKLER, 0.5),
            _field(ComparableField.COMPANY_NAME, SimilarityMetric.JARO_WINKLER, 0.5),
        ]
        vectors = Comparator().compare(records, [_pair("r1", "r2")], fields)
        assert len(vectors[0].field_scores) == 2

    def test_composite_score_in_range(self):
        records = [make_processed("r1"), make_processed("r2")]
        fields = [_field()]
        vectors = Comparator().compare(records, [_pair("r1", "r2")], fields)
        assert 0.0 <= vectors[0].composite_score <= 1.0

    def test_left_right_ids_preserved(self):
        records = [make_processed("r1"), make_processed("r2")]
        fields = [_field()]
        vectors = Comparator().compare(records, [_pair("r1", "r2")], fields)
        assert vectors[0].left_id == "r1"
        assert vectors[0].right_id == "r2"
