"""
Output sinks for the dedup pipeline.

The pipeline itself only emits IDs and clusters (DeduplicationResult). A sink is
what actually *persists* the deduplicated job postings downstream so the data
isn't thrown away after a batch is processed.

- ``PostgresSink`` upserts every record in a batch into a ``job_postings`` table,
  tagging each row as canonical or as a duplicate of its cluster's canonical id.
- ``LoggingSink`` is the no-database fallback (the original log-only behaviour),
  used automatically when ``DEDUP_POSTGRES_DSN`` is not configured.

``psycopg2`` is imported lazily so the module (and the unit tests) load fine in
environments where the Postgres driver isn't installed.
"""
from __future__ import annotations

import json
import os
import time
from typing import Protocol, runtime_checkable

from .logger import Logger
from .types import DeduplicationResult, JobPostingRecord


@runtime_checkable
class ISink(Protocol):
    """Persists the deduplicated postings produced for one batch."""

    def write(
        self,
        result: DeduplicationResult,
        records_by_id: dict[str, JobPostingRecord],
    ) -> None: ...

    def close(self) -> None: ...


# ---------------------------------------------------------------------------
# Result → flat rows
# ---------------------------------------------------------------------------


def _rows_from_result(
    result: DeduplicationResult,
    records_by_id: dict[str, JobPostingRecord],
) -> list[tuple[JobPostingRecord, bool, str | None]]:
    """
    Flatten a DeduplicationResult into ``(record, is_canonical, canonical_id)``
    tuples — one per record that survives to the sink.

    - Unique records: canonical, no parent.
    - Cluster members: the cluster's ``canonical_id`` is canonical; every other
      member points at it.
    Records missing from ``records_by_id`` are skipped (defensive — the batch
    map should always contain them).
    """
    rows: list[tuple[JobPostingRecord, bool, str | None]] = []

    for rid in result.unique_record_ids:
        rec = records_by_id.get(rid)
        if rec is not None:
            rows.append((rec, True, None))

    for cluster in result.duplicate_clusters:
        for member_id in cluster.member_ids:
            rec = records_by_id.get(member_id)
            if rec is None:
                continue
            is_canonical = member_id == cluster.canonical_id
            canonical_id = None if is_canonical else cluster.canonical_id
            rows.append((rec, is_canonical, canonical_id))

    return rows


# ---------------------------------------------------------------------------
# Logging sink (fallback / local-dev default)
# ---------------------------------------------------------------------------


class LoggingSink:
    """No-database sink: logs what *would* have been persisted."""

    def __init__(self, logger: Logger) -> None:
        self._logger = logger

    def write(
        self,
        result: DeduplicationResult,
        records_by_id: dict[str, JobPostingRecord],
    ) -> None:
        rows = _rows_from_result(result, records_by_id)
        canonical = sum(1 for _, is_canon, _ in rows if is_canon)
        self._logger.info(
            "dedup.sink.logged",
            batch_id=result.batch_id,
            record_count=len(rows),
            message=f"canonical={canonical} duplicates={len(rows) - canonical} (no DB configured)",
        )

    def close(self) -> None:  # nothing to release
        pass


# ---------------------------------------------------------------------------
# Postgres sink
# ---------------------------------------------------------------------------


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS job_postings (
    record_id        TEXT PRIMARY KEY,
    job_title        TEXT NOT NULL,
    job_function     TEXT NOT NULL,
    company_name     TEXT NOT NULL,
    location_city    TEXT,
    location_country TEXT,
    skills           JSONB NOT NULL DEFAULT '[]'::jsonb,
    seniority_level  TEXT NOT NULL,
    source_url       TEXT NOT NULL,
    posted_date      DATE,
    ingested_at      TIMESTAMPTZ NOT NULL,
    is_canonical     BOOLEAN NOT NULL,
    canonical_id     TEXT,
    batch_id         TEXT NOT NULL,
    written_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_postings_canonical ON job_postings (canonical_id);
CREATE INDEX IF NOT EXISTS idx_job_postings_company   ON job_postings (company_name);
"""

_UPSERT_SQL = """
INSERT INTO job_postings (
    record_id, job_title, job_function, company_name,
    location_city, location_country, skills, seniority_level,
    source_url, posted_date, ingested_at, is_canonical, canonical_id, batch_id
) VALUES (
    %(record_id)s, %(job_title)s, %(job_function)s, %(company_name)s,
    %(location_city)s, %(location_country)s, %(skills)s, %(seniority_level)s,
    %(source_url)s, %(posted_date)s, %(ingested_at)s, %(is_canonical)s,
    %(canonical_id)s, %(batch_id)s
)
ON CONFLICT (record_id) DO UPDATE SET
    job_title        = EXCLUDED.job_title,
    job_function     = EXCLUDED.job_function,
    company_name     = EXCLUDED.company_name,
    location_city    = EXCLUDED.location_city,
    location_country = EXCLUDED.location_country,
    skills           = EXCLUDED.skills,
    seniority_level  = EXCLUDED.seniority_level,
    source_url       = EXCLUDED.source_url,
    posted_date      = EXCLUDED.posted_date,
    ingested_at      = EXCLUDED.ingested_at,
    is_canonical     = EXCLUDED.is_canonical,
    canonical_id     = EXCLUDED.canonical_id,
    batch_id         = EXCLUDED.batch_id,
    written_at       = now();
"""


class PostgresSink:
    """Upserts deduplicated postings into a Postgres ``job_postings`` table."""

    def __init__(
        self,
        dsn: str,
        logger: Logger,
        connect_retries: int = 10,
        retry_delay_s: float = 3.0,
    ) -> None:
        import psycopg2  # lazy: only required when a DSN is configured

        self._psycopg2 = psycopg2
        self._logger = logger
        self._conn = self._connect(dsn, connect_retries, retry_delay_s)
        self._ensure_schema()

    def _connect(self, dsn: str, retries: int, delay_s: float):
        last_exc: Exception | None = None
        for attempt in range(1, retries + 1):
            try:
                conn = self._psycopg2.connect(dsn)
                conn.autocommit = False
                self._logger.info("dedup.sink.connected", message=f"attempt={attempt}")
                return conn
            except Exception as exc:  # OperationalError etc. — Postgres may still be booting
                last_exc = exc
                self._logger.warn(
                    "dedup.sink.connect_retry",
                    message=f"attempt={attempt}/{retries}: {exc}",
                )
                time.sleep(delay_s)
        raise RuntimeError(f"Could not connect to Postgres after {retries} attempts: {last_exc}")

    def _ensure_schema(self) -> None:
        with self._conn.cursor() as cur:
            cur.execute(_SCHEMA_SQL)
        self._conn.commit()
        self._logger.info("dedup.sink.schema_ready")

    def write(
        self,
        result: DeduplicationResult,
        records_by_id: dict[str, JobPostingRecord],
    ) -> None:
        rows = _rows_from_result(result, records_by_id)
        if not rows:
            return

        try:
            with self._conn.cursor() as cur:
                for rec, is_canonical, canonical_id in rows:
                    cur.execute(
                        _UPSERT_SQL,
                        {
                            "record_id": rec.record_id,
                            "job_title": rec.job_title,
                            "job_function": rec.job_function,
                            "company_name": rec.company_name,
                            "location_city": rec.location_city,
                            "location_country": rec.location_country,
                            "skills": json.dumps(rec.skills),
                            "seniority_level": rec.seniority_level,
                            "source_url": rec.source_url,
                            "posted_date": rec.posted_date,
                            "ingested_at": rec.ingested_at,
                            "is_canonical": is_canonical,
                            "canonical_id": canonical_id,
                            "batch_id": result.batch_id,
                        },
                    )
            self._conn.commit()
            canonical = sum(1 for _, is_canon, _ in rows if is_canon)
            self._logger.info(
                "dedup.sink.persisted",
                batch_id=result.batch_id,
                record_count=len(rows),
                message=f"canonical={canonical} duplicates={len(rows) - canonical}",
            )
        except Exception as exc:
            self._conn.rollback()
            self._logger.error(
                "dedup.sink.write_failed",
                batch_id=result.batch_id,
                message=str(exc),
            )

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def create_sink(logger: Logger) -> ISink:
    """
    Build a sink from the environment. Returns a ``PostgresSink`` when
    ``DEDUP_POSTGRES_DSN`` is set, otherwise the log-only ``LoggingSink``.
    """
    dsn = os.environ.get("DEDUP_POSTGRES_DSN", "").strip()
    if not dsn:
        logger.info("dedup.sink.logging_only", message="DEDUP_POSTGRES_DSN not set")
        return LoggingSink(logger)
    return PostgresSink(dsn, logger)
