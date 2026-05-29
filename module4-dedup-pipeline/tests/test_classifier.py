import pytest
from src.classifier import Classifier, _threshold_decision
from src.types import (
    ClassifierConfig,
    ClassifierType,
    ComparableField,
    ComparisonVector,
    DedupStatus,
    FieldScore,
    SimilarityMetric,
)


def _cfg(
    match_threshold: float = 0.8,
    unmatch_threshold: float = 0.3,
    classifier_type: ClassifierType = ClassifierType.THRESHOLD,
) -> ClassifierConfig:
    return ClassifierConfig(
        type=classifier_type,
        match_threshold=match_threshold,
        unmatch_threshold=unmatch_threshold,
    )


def _vector(
    left: str = "r1",
    right: str = "r2",
    composite_score: float = 0.9,
) -> ComparisonVector:
    return ComparisonVector(
        left_id=left,
        right_id=right,
        field_scores=[
            FieldScore(
                field=ComparableField.JOB_TITLE,
                score=composite_score,
                metric=SimilarityMetric.JARO_WINKLER,
            )
        ],
        composite_score=composite_score,
    )


class TestThresholdDecision:
    def test_above_match_threshold_is_duplicate(self):
        d = _threshold_decision(_vector(composite_score=0.9), 0.8, 0.3)
        assert d.status == DedupStatus.DUPLICATE

    def test_below_unmatch_threshold_is_unique(self):
        d = _threshold_decision(_vector(composite_score=0.2), 0.8, 0.3)
        assert d.status == DedupStatus.UNIQUE

    def test_in_band_is_uncertain(self):
        d = _threshold_decision(_vector(composite_score=0.5), 0.8, 0.3)
        assert d.status == DedupStatus.UNCERTAIN

    def test_at_match_threshold_is_duplicate(self):
        d = _threshold_decision(_vector(composite_score=0.8), 0.8, 0.3)
        assert d.status == DedupStatus.DUPLICATE

    def test_at_unmatch_threshold_is_unique(self):
        d = _threshold_decision(_vector(composite_score=0.3), 0.8, 0.3)
        assert d.status == DedupStatus.UNIQUE

    def test_confidence_in_range(self):
        for score in [0.0, 0.2, 0.5, 0.8, 1.0]:
            d = _threshold_decision(_vector(composite_score=score), 0.8, 0.3)
            assert 0.0 <= d.confidence <= 1.0

    def test_duplicate_confidence_at_1_when_perfect(self):
        d = _threshold_decision(_vector(composite_score=1.0), 0.8, 0.3)
        assert d.confidence == pytest.approx(1.0)

    def test_duplicate_confidence_at_half_at_threshold(self):
        d = _threshold_decision(_vector(composite_score=0.8), 0.8, 0.3)
        assert d.confidence == pytest.approx(0.5)

    def test_unique_confidence_at_half_at_unmatch_threshold(self):
        d = _threshold_decision(_vector(composite_score=0.3), 0.8, 0.3)
        assert d.confidence == pytest.approx(0.5)


class TestClassifier:
    def test_empty_vectors_returns_empty(self):
        assert Classifier().classify([], _cfg()) == []

    def test_threshold_duplicate(self):
        decisions = Classifier().classify([_vector(composite_score=0.9)], _cfg())
        assert decisions[0].status == DedupStatus.DUPLICATE

    def test_threshold_unique(self):
        decisions = Classifier().classify([_vector(composite_score=0.1)], _cfg())
        assert decisions[0].status == DedupStatus.UNIQUE

    def test_threshold_uncertain(self):
        decisions = Classifier().classify([_vector(composite_score=0.55)], _cfg())
        assert decisions[0].status == DedupStatus.UNCERTAIN

    def test_threshold_preserves_ids(self):
        decisions = Classifier().classify(
            [_vector("left", "right", 0.9)], _cfg()
        )
        assert decisions[0].left_id == "left"
        assert decisions[0].right_id == "right"

    def test_ecm_with_single_vector_falls_back_to_threshold(self):
        cfg = _cfg(classifier_type=ClassifierType.ECM)
        decisions = Classifier().classify([_vector(composite_score=0.9)], cfg)
        assert decisions[0].status == DedupStatus.DUPLICATE

    def test_ecm_with_two_vectors_returns_decisions(self):
        cfg = _cfg(classifier_type=ClassifierType.ECM)
        vectors = [
            _vector("r1", "r2", 0.95),
            _vector("r3", "r4", 0.1),
        ]
        decisions = Classifier().classify(vectors, cfg)
        assert len(decisions) == 2

    def test_ecm_output_count_matches_input(self):
        cfg = _cfg(classifier_type=ClassifierType.ECM)
        vectors = [_vector(f"r{i}", f"r{i+1}", 0.5) for i in range(5)]
        decisions = Classifier().classify(vectors, cfg)
        assert len(decisions) == 5

    def test_threshold_batch_of_three(self):
        vectors = [
            _vector("r1", "r2", 0.9),
            _vector("r3", "r4", 0.2),
            _vector("r5", "r6", 0.55),
        ]
        decisions = Classifier().classify(vectors, _cfg())
        statuses = {d.left_id: d.status for d in decisions}
        assert statuses["r1"] == DedupStatus.DUPLICATE
        assert statuses["r3"] == DedupStatus.UNIQUE
        assert statuses["r5"] == DedupStatus.UNCERTAIN
