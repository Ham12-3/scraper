import json
import pytest
from src.config_loader import load_config
from src.types import BlockingStrategy, ClassifierType


def _base_env() -> dict[str, str]:
    fields = [
        {"field": "job_title_tokens", "metric": "jaro_winkler", "weight": 0.5, "field_match_threshold": 0.85},
        {"field": "company_name_normalized", "metric": "jaro_winkler", "weight": 0.5, "field_match_threshold": 0.9},
    ]
    return {
        "DEDUP_BLOCKING_STRATEGIES": "company_title",
        "DEDUP_BLOCKING_MAX_PAIRS": "10000",
        "DEDUP_COMPARISON_FIELDS": json.dumps(fields),
        "DEDUP_CLASSIFIER_TYPE": "threshold",
        "DEDUP_MATCH_THRESHOLD": "0.8",
        "DEDUP_UNMATCH_THRESHOLD": "0.3",
        "DEDUP_BATCH_SIZE": "500",
    }


class TestLoadConfig:
    def test_loads_valid_config(self, monkeypatch):
        for k, v in _base_env().items():
            monkeypatch.setenv(k, v)
        cfg = load_config()
        assert cfg.blocking.strategies == [BlockingStrategy.COMPANY_TITLE]
        assert cfg.blocking.max_pairs == 10000
        assert len(cfg.comparison_fields) == 2
        assert cfg.classifier.type == ClassifierType.THRESHOLD
        assert cfg.classifier.match_threshold == 0.8
        assert cfg.batch_size == 500

    def test_multiple_blocking_strategies(self, monkeypatch):
        env = _base_env()
        env["DEDUP_BLOCKING_STRATEGIES"] = "company_title,title_function"
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        cfg = load_config()
        assert BlockingStrategy.TITLE_FUNCTION in cfg.blocking.strategies

    def test_missing_required_var_raises(self, monkeypatch):
        env = _base_env()
        env.pop("DEDUP_BLOCKING_STRATEGIES")
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        monkeypatch.delenv("DEDUP_BLOCKING_STRATEGIES", raising=False)
        with pytest.raises(EnvironmentError, match="DEDUP_BLOCKING_STRATEGIES"):
            load_config()

    def test_unknown_blocking_strategy_raises(self, monkeypatch):
        env = {**_base_env(), "DEDUP_BLOCKING_STRATEGIES": "company_title,banana"}
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(ValueError, match="banana"):
            load_config()

    def test_invalid_comparison_fields_json_raises(self, monkeypatch):
        env = {**_base_env(), "DEDUP_COMPARISON_FIELDS": "not-json"}
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(ValueError, match="DEDUP_COMPARISON_FIELDS"):
            load_config()

    def test_unknown_classifier_type_raises(self, monkeypatch):
        env = {**_base_env(), "DEDUP_CLASSIFIER_TYPE": "neural"}
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(ValueError, match="neural"):
            load_config()

    def test_non_integer_batch_size_raises(self, monkeypatch):
        env = {**_base_env(), "DEDUP_BATCH_SIZE": "big"}
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(ValueError, match="DEDUP_BATCH_SIZE"):
            load_config()
