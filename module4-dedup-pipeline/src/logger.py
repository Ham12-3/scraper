import json
import sys
from datetime import datetime, timezone
from typing import Any

from .types import LogLevel, PipelineErrorCode, StructuredLogEntry


class Logger:
    def __init__(self, module: str = "dedup-pipeline") -> None:
        self._module = module

    def _write(
        self,
        level: LogLevel,
        event: str,
        batch_id: str | None = None,
        **kwargs: Any,
    ) -> None:
        entry = StructuredLogEntry(
            timestamp=datetime.now(tz=timezone.utc).isoformat(),
            level=level,
            module=self._module,
            batch_id=batch_id,
            event=event,
            **{k: v for k, v in kwargs.items() if v is not None},
        )
        sys.stdout.write(json.dumps(entry.model_dump(exclude_none=True)) + "\n")
        sys.stdout.flush()

    def debug(self, event: str, batch_id: str | None = None, **kwargs: Any) -> None:
        self._write(LogLevel.DEBUG, event, batch_id, **kwargs)

    def info(self, event: str, batch_id: str | None = None, **kwargs: Any) -> None:
        self._write(LogLevel.INFO, event, batch_id, **kwargs)

    def warn(self, event: str, batch_id: str | None = None, **kwargs: Any) -> None:
        self._write(LogLevel.WARN, event, batch_id, **kwargs)

    def error(
        self,
        event: str,
        batch_id: str | None = None,
        error_code: PipelineErrorCode | None = None,
        exc: BaseException | None = None,
        **kwargs: Any,
    ) -> None:
        extra: dict[str, Any] = {}
        if error_code:
            extra["error_code"] = error_code
        if exc:
            extra["message"] = str(exc)
            extra["exc_type"] = type(exc).__name__
        self._write(LogLevel.ERROR, event, batch_id, **extra, **kwargs)
