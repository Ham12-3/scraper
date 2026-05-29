import json
import sys
from datetime import datetime, timezone
from typing import Any

from .types import ExtractionStrategy, LogLevel, ParseErrorCode, StructuredLogEntry


class Logger:
    def __init__(self, module: str = "html-parser") -> None:
        self._module = module

    def _write(
        self,
        level: LogLevel,
        event: str,
        task_id: str | None = None,
        **kwargs: Any,
    ) -> None:
        entry = StructuredLogEntry(
            timestamp=datetime.now(tz=timezone.utc).isoformat(),
            level=level,
            module=self._module,
            task_id=task_id,
            event=event,
            **{k: v for k, v in kwargs.items() if v is not None},
        )
        sys.stdout.write(
            json.dumps(entry.model_dump(exclude_none=True)) + "\n"
        )
        sys.stdout.flush()

    def debug(
        self,
        event: str,
        task_id: str | None = None,
        **kwargs: Any,
    ) -> None:
        self._write(LogLevel.DEBUG, event, task_id, **kwargs)

    def info(
        self,
        event: str,
        task_id: str | None = None,
        **kwargs: Any,
    ) -> None:
        self._write(LogLevel.INFO, event, task_id, **kwargs)

    def warn(
        self,
        event: str,
        task_id: str | None = None,
        **kwargs: Any,
    ) -> None:
        self._write(LogLevel.WARN, event, task_id, **kwargs)

    def error(
        self,
        event: str,
        task_id: str | None = None,
        error_code: ParseErrorCode | None = None,
        strategy: ExtractionStrategy | None = None,
        exc: BaseException | None = None,
        **kwargs: Any,
    ) -> None:
        extra: dict[str, Any] = {}
        if error_code:
            extra["error_code"] = error_code
        if strategy:
            extra["strategy"] = strategy
        if exc:
            extra["message"] = str(exc)
            extra["exc_type"] = type(exc).__name__
        self._write(LogLevel.ERROR, event, task_id, **extra, **kwargs)
