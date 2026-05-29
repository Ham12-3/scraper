import json
import os

from .types import (
    BlockingConfig,
    BlockingStrategy,
    ClassifierConfig,
    ClassifierType,
    ComparableField,
    ComparisonFieldConfig,
    PipelineConfig,
    SimilarityMetric,
)


def _require(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise EnvironmentError(
            f"Required environment variable '{name}' is not set or is empty"
        )
    return val


def _require_int(name: str) -> int:
    raw = _require(name)
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"Environment variable '{name}' must be an integer, got: '{raw}'")


def _require_float(name: str) -> float:
    raw = _require(name)
    try:
        return float(raw)
    except ValueError:
        raise ValueError(f"Environment variable '{name}' must be a float, got: '{raw}'")


def _load_blocking_config() -> BlockingConfig:
    raw = _require("DEDUP_BLOCKING_STRATEGIES")
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    valid = {e.value for e in BlockingStrategy}
    strategies: list[BlockingStrategy] = []
    for part in parts:
        if part not in valid:
            raise ValueError(
                f"Unknown blocking strategy '{part}' in DEDUP_BLOCKING_STRATEGIES. "
                f"Valid values: {', '.join(sorted(valid))}"
            )
        strategies.append(BlockingStrategy(part))
    return BlockingConfig(
        strategies=strategies,
        max_pairs=_require_int("DEDUP_BLOCKING_MAX_PAIRS"),
    )


def _load_comparison_fields() -> list[ComparisonFieldConfig]:
    raw = _require("DEDUP_COMPARISON_FIELDS")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"DEDUP_COMPARISON_FIELDS is not valid JSON: {exc}") from exc
    if not isinstance(data, list):
        raise ValueError("DEDUP_COMPARISON_FIELDS must be a JSON array")
    return [ComparisonFieldConfig.model_validate(item) for item in data]


def _load_classifier_config() -> ClassifierConfig:
    raw_type = _require("DEDUP_CLASSIFIER_TYPE")
    valid = {e.value for e in ClassifierType}
    if raw_type not in valid:
        raise ValueError(
            f"Unknown classifier type '{raw_type}' in DEDUP_CLASSIFIER_TYPE. "
            f"Valid values: {', '.join(sorted(valid))}"
        )
    return ClassifierConfig(
        type=ClassifierType(raw_type),
        match_threshold=_require_float("DEDUP_MATCH_THRESHOLD"),
        unmatch_threshold=_require_float("DEDUP_UNMATCH_THRESHOLD"),
    )


def load_config() -> PipelineConfig:
    """
    Reads all required environment variables and returns a fully validated
    PipelineConfig. Raises descriptively on the first missing or malformed var.
    """
    return PipelineConfig(
        blocking=_load_blocking_config(),
        comparison_fields=_load_comparison_fields(),
        classifier=_load_classifier_config(),
        batch_size=_require_int("DEDUP_BATCH_SIZE"),
    )
