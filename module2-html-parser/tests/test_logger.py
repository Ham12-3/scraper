"""Tests for structured JSON logger output."""
import json

import pytest

from src.logger import Logger
from src.types import ExtractionStrategy, ParseErrorCode


def _parse(out: str) -> dict:  # type: ignore[type-arg]
    lines = [l for l in out.splitlines() if l.strip()]
    return json.loads(lines[-1])


class TestLogger:
    def test_info_writes_valid_json(self, capsys: pytest.CaptureFixture[str]) -> None:
        Logger().info("test.event", task_id="t1")
        entry = _parse(capsys.readouterr().out)
        assert entry["event"] == "test.event"
        assert entry["task_id"] == "t1"
        assert entry["level"] == "info"

    def test_debug_level(self, capsys: pytest.CaptureFixture[str]) -> None:
        Logger().debug("dbg")
        assert _parse(capsys.readouterr().out)["level"] == "debug"

    def test_warn_level(self, capsys: pytest.CaptureFixture[str]) -> None:
        Logger().warn("wrn")
        assert _parse(capsys.readouterr().out)["level"] == "warn"

    def test_error_includes_error_code(self, capsys: pytest.CaptureFixture[str]) -> None:
        Logger().error("err.event", error_code=ParseErrorCode.HTML_TOO_SHORT)
        entry = _parse(capsys.readouterr().out)
        assert entry["error_code"] == ParseErrorCode.HTML_TOO_SHORT.value

    def test_error_includes_strategy(self, capsys: pytest.CaptureFixture[str]) -> None:
        Logger().error("err.event", strategy=ExtractionStrategy.LLM)
        assert _parse(capsys.readouterr().out)["strategy"] == ExtractionStrategy.LLM.value

    def test_error_includes_exception_message(self, capsys: pytest.CaptureFixture[str]) -> None:
        Logger().error("err.event", exc=ValueError("boom"))
        entry = _parse(capsys.readouterr().out)
        assert entry["message"] == "boom"
        assert entry["exc_type"] == "ValueError"

    def test_none_fields_excluded(self, capsys: pytest.CaptureFixture[str]) -> None:
        Logger().info("evt")
        entry = _parse(capsys.readouterr().out)
        assert "task_id" not in entry
        assert "strategy" not in entry

    def test_module_field_present(self, capsys: pytest.CaptureFixture[str]) -> None:
        Logger(module="test-mod").info("evt")
        assert _parse(capsys.readouterr().out)["module"] == "test-mod"

    def test_timestamp_is_iso8601(self, capsys: pytest.CaptureFixture[str]) -> None:
        from datetime import datetime
        Logger().info("evt")
        ts = _parse(capsys.readouterr().out)["timestamp"]
        datetime.fromisoformat(ts)

    def test_extra_kwargs_passed_through(self, capsys: pytest.CaptureFixture[str]) -> None:
        Logger().info("evt", extra_field="hello")
        assert _parse(capsys.readouterr().out)["extra_field"] == "hello"
