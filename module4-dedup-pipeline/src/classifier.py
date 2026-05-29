import pandas as pd

from .types import (
    ClassifierConfig,
    ClassifierType,
    ComparisonVector,
    DedupDecision,
    DedupStatus,
)


def _threshold_decision(
    v: ComparisonVector,
    match_t: float,
    unmatch_t: float,
) -> DedupDecision:
    score = v.composite_score
    if score >= match_t:
        status = DedupStatus.DUPLICATE
        # Confidence scales linearly from 0.5 at the threshold to 1.0 at score=1
        span = 1.0 - match_t
        confidence = 0.5 + 0.5 * ((score - match_t) / span) if span > 0 else 1.0
    elif score <= unmatch_t:
        status = DedupStatus.UNIQUE
        span = unmatch_t
        confidence = 0.5 + 0.5 * ((unmatch_t - score) / span) if span > 0 else 1.0
    else:
        status = DedupStatus.UNCERTAIN
        # Closest to either boundary → highest confidence
        band = match_t - unmatch_t
        mid = unmatch_t + band / 2
        confidence = 1.0 - abs(score - mid) / (band / 2) if band > 0 else 0.5

    return DedupDecision(
        left_id=v.left_id,
        right_id=v.right_id,
        status=status,
        composite_score=score,
        confidence=max(0.0, min(1.0, confidence)),
    )


class Classifier:
    """
    Implements IClassifier.

    THRESHOLD mode: pure score thresholding — fast, deterministic, no training.
    ECM mode: fits an unsupervised Expectation-Conditional-Maximization model on
    the feature matrix, then falls back to threshold for uncertain cases.
    Never raises — ECM failures gracefully degrade to threshold.
    """

    def classify(
        self,
        vectors: list[ComparisonVector],
        config: ClassifierConfig,
    ) -> list[DedupDecision]:
        if not vectors:
            return []
        if config.type == ClassifierType.THRESHOLD:
            return self._threshold(vectors, config)
        return self._ecm(vectors, config)

    def _threshold(
        self,
        vectors: list[ComparisonVector],
        config: ClassifierConfig,
    ) -> list[DedupDecision]:
        return [
            _threshold_decision(v, config.match_threshold, config.unmatch_threshold)
            for v in vectors
        ]

    def _ecm(
        self,
        vectors: list[ComparisonVector],
        config: ClassifierConfig,
    ) -> list[DedupDecision]:
        # Need at least 2 vectors and at least one field score to use ECM
        if len(vectors) < 2 or not vectors[0].field_scores:
            return self._threshold(vectors, config)

        field_names = [fs.field.name for fs in vectors[0].field_scores]
        rows = [{fs.field.name: fs.score for fs in v.field_scores} for v in vectors]
        features = pd.DataFrame(rows, columns=field_names)
        features.index = pd.MultiIndex.from_tuples(
            [(v.left_id, v.right_id) for v in vectors]
        )

        try:
            from recordlinkage.classifiers import ECMClassifier
            clf = ECMClassifier(binarize=0.5)
            clf.fit(features)
            match_index: pd.MultiIndex = clf.predict(features)
            match_set = set(match_index.tolist())
        except Exception:
            return self._threshold(vectors, config)

        decisions: list[DedupDecision] = []
        for v in vectors:
            key = (v.left_id, v.right_id)
            score = v.composite_score
            if key in match_set:
                # ECM called it a match; use composite score as confidence proxy
                decisions.append(
                    DedupDecision(
                        left_id=v.left_id,
                        right_id=v.right_id,
                        status=DedupStatus.DUPLICATE,
                        composite_score=score,
                        confidence=max(0.5, min(1.0, score)),
                    )
                )
            else:
                # ECM called it a non-match; still apply threshold guard for clarity
                decisions.append(
                    _threshold_decision(v, config.match_threshold, config.unmatch_threshold)
                )

        return decisions
