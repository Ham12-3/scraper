import json
import os

from .types import (
    CssSelectorSet,
    ExtractionStrategy,
    LLMConfig,
    ParserConfig,
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
        raise ValueError(
            f"Environment variable '{name}' must be an integer, got: '{raw}'"
        )


def _require_float(name: str) -> float:
    raw = _require(name)
    try:
        return float(raw)
    except ValueError:
        raise ValueError(
            f"Environment variable '{name}' must be a float, got: '{raw}'"
        )


def _load_selector_sets() -> list[CssSelectorSet]:
    """
    PARSER_SELECTOR_SETS must be a JSON array of CssSelectorSet objects.
    An empty array is valid — the CSS strategy will always miss and fall through.
    """
    raw = os.environ.get("PARSER_SELECTOR_SETS", "[]").strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"PARSER_SELECTOR_SETS is not valid JSON: {exc}"
        )
    if not isinstance(data, list):
        raise ValueError("PARSER_SELECTOR_SETS must be a JSON array")
    return [CssSelectorSet.model_validate(item) for item in data]


def _load_strategy_order() -> list[ExtractionStrategy]:
    """
    PARSER_STRATEGY_ORDER is a comma-separated list of strategy names.
    E.g. "css_selectors,heuristic,llm"
    """
    raw = _require("PARSER_STRATEGY_ORDER")
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    valid = {e.value for e in ExtractionStrategy}
    for part in parts:
        if part not in valid:
            raise ValueError(
                f"Unknown strategy '{part}' in PARSER_STRATEGY_ORDER. "
                f"Valid values: {', '.join(sorted(valid))}"
            )
    return [ExtractionStrategy(p) for p in parts]


def load_config() -> ParserConfig:
    """
    Reads all required environment variables and returns a fully validated
    ParserConfig. Raises descriptively on the first missing or malformed var.
    """
    llm = LLMConfig(
        model=_require("LLM_MODEL"),
        max_tokens=_require_int("LLM_MAX_TOKENS"),
        temperature=_require_float("LLM_TEMPERATURE"),
        timeout_seconds=_require_float("LLM_TIMEOUT_SECONDS"),
        max_html_chars=_require_int("LLM_MAX_HTML_CHARS"),
    )
    return ParserConfig(
        selector_sets=_load_selector_sets(),
        llm=llm,
        min_html_length=_require_int("PARSER_MIN_HTML_LENGTH"),
        strategy_order=_load_strategy_order(),
    )
