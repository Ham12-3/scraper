import json
import pytest
from src.logger import Logger
from src.types import PipelineErrorCode


def _parse(capsys: pytest.CaptureFixture[str]) -> dict:
    lines = [l for l in capsys.readouterr().out.splitlines() if l.strip()]
    return json.loads(lines[-1])


class TestLogger:
    def test_info_writes_valid_json(self, capsys):
        Logger().info("test.event", batch_id="b1")
        entry = _parse(capsys)
        assert entry["event"] == "test.event"
        assert entry["batch_id"] == "b1"
        assert entry["level"] == "info"
        assert entry["module"] == "dedup-pipeline"

    def test_debug_level(self, capsys):
        Logger().debug("d")
        assert _parse(capsys)["level"] == "debug"

    def test_warn_level(self, capsys):
        Logger().warn("w")
        assert _parse(capsys)["level"] == "warn"

    def test_error_includes_error_code(self, capsys):
        Logger().error("e", error_code=PipelineErrorCode.BLOCKING_FAILED)
        assert _parse(capsys)["error_code"] == PipelineErrorCode.BLOCKING_FAILED.value

    def test_error_includes_exception(self, capsys):
        Logger().error("e", exc=ValueError("boom"))
        entry = _parse(capsys)
        assert entry["message"] == "boom"
        assert entry["exc_type"] == "ValueError"

    def test_none_fields_excluded(self, capsys):
        Logger().info("evt")
        entry = _parse(capsys)
        assert "batch_id" not in entry

    def test_extra_kwargs_included(self, capsys):
        Logger().info("evt", record_count=42)
        assert _parse(capsys)["record_count"] == 42

    def test_timestamp_is_iso8601(self, capsys):
        from datetime import datetime
        Logger().info("evt")
        datetime.fromisoformat(_parse(capsys)["timestamp"])
