"""Tests for config_loader.py — env-var loading and validation."""
import json
import os

import pytest

from src.config_loader import load_config
from src.types import ExtractionStrategy


def _base_env() -> dict[str, str]:
    return {
        "LLM_MODEL": "claude-haiku-4-5",
        "LLM_MAX_TOKENS": "512",
        "LLM_TEMPERATURE": "0.0",
        "LLM_TIMEOUT_SECONDS": "10.0",
        "LLM_MAX_HTML_CHARS": "50000",
        "PARSER_MIN_HTML_LENGTH": "200",
        "PARSER_STRATEGY_ORDER": "css_selectors,heuristic,llm",
        "PARSER_SELECTOR_SETS": "[]",
    }


class TestLoadConfig:
    def test_loads_valid_config(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for k, v in _base_env().items():
            monkeypatch.setenv(k, v)
        cfg = load_config()
        assert cfg.llm.model == "claude-haiku-4-5"
        assert cfg.llm.max_tokens == 512
        assert cfg.llm.temperature == 0.0
        assert cfg.min_html_length == 200
        assert cfg.strategy_order == [
            ExtractionStrategy.CSS_SELECTORS,
            ExtractionStrategy.HEURISTIC,
            ExtractionStrategy.LLM,
        ]

    def test_missing_required_var_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        env = _base_env()
        env.pop("LLM_MODEL")
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        monkeypatch.delenv("LLM_MODEL", raising=False)
        with pytest.raises(EnvironmentError, match="LLM_MODEL"):
            load_config()

    def test_non_integer_max_tokens_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        env = _base_env()
        env["LLM_MAX_TOKENS"] = "abc"
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(ValueError, match="LLM_MAX_TOKENS"):
            load_config()

    def test_non_float_temperature_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        env = _base_env()
        env["LLM_TEMPERATURE"] = "hot"
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(ValueError, match="LLM_TEMPERATURE"):
            load_config()

    def test_unknown_strategy_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        env = _base_env()
        env["PARSER_STRATEGY_ORDER"] = "css_selectors,banana"
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(ValueError, match="banana"):
            load_config()

    def test_invalid_selector_sets_json_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        env = _base_env()
        env["PARSER_SELECTOR_SETS"] = "not-json"
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(ValueError, match="PARSER_SELECTOR_SETS"):
            load_config()

    def test_selector_sets_non_array_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        env = _base_env()
        env["PARSER_SELECTOR_SETS"] = '{"key": "val"}'
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(ValueError, match="JSON array"):
            load_config()

    def test_valid_selector_set_parsed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        env = _base_env()
        selector_set = [
            {
                "name": "linkedin",
                "job_title": ["h1.title"],
                "company_name": [".company"],
                "location": [".location"],
            }
        ]
        env["PARSER_SELECTOR_SETS"] = json.dumps(selector_set)
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        cfg = load_config()
        assert len(cfg.selector_sets) == 1
        assert cfg.selector_sets[0].name == "linkedin"

    def test_empty_strategy_order_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        env = _base_env()
        env["PARSER_STRATEGY_ORDER"] = "   "
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        with pytest.raises((ValueError, EnvironmentError)):
            load_config()
