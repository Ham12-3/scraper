"""Tests for the output sinks (LoggingSink, PostgresSink, create_sink)."""
import sys

import pytest

from helpers import make_record

from src.logger import Logger
from src.sink import LoggingSink, PostgresSink, _rows_from_result, create_sink
from src.types import (
    DeduplicationResult,
    DuplicateCluster,
    PipelineStats,
)


def _result(unique_ids, clusters):
    return DeduplicationResult(
        batch_id="batch-0001",
        unique_record_ids=unique_ids,
        duplicate_clusters=clusters,
        decisions=[],
        stats=PipelineStats(
            input_record_count=0,
            candidate_pair_count=0,
            comparison_count=0,
            duplicate_pair_count=0,
            unique_record_count=len(unique_ids),
            cluster_count=len(clusters),
            processing_time_ms=1.0,
        ),
    )


# ---------------------------------------------------------------------------
# _rows_from_result
# ---------------------------------------------------------------------------


class TestRowsFromResult:
    def test_unique_records_are_canonical_with_no_parent(self):
        recs = {rid: make_record(rid) for rid in ("a", "b")}
        rows = _rows_from_result(_result(["a", "b"], []), recs)
        flat = {(r.record_id, is_c, canon) for r, is_c, canon in rows}
        assert flat == {("a", True, None), ("b", True, None)}

    def test_cluster_canonical_and_duplicates(self):
        recs = {rid: make_record(rid) for rid in ("a", "b", "c")}
        cluster = DuplicateCluster(canonical_id="a", member_ids=["a", "b", "c"])
        rows = _rows_from_result(_result([], [cluster]), recs)
        flat = {(r.record_id, is_c, canon) for r, is_c, canon in rows}
        assert flat == {
            ("a", True, None),
            ("b", False, "a"),
            ("c", False, "a"),
        }

    def test_mixed_unique_and_cluster(self):
        recs = {rid: make_record(rid) for rid in ("a", "b", "c", "d")}
        cluster = DuplicateCluster(canonical_id="a", member_ids=["a", "b"])
        rows = _rows_from_result(_result(["c", "d"], [cluster]), recs)
        assert len(rows) == 4
        canonical = sum(1 for _, is_c, _ in rows if is_c)
        assert canonical == 3  # c, d, a

    def test_records_missing_from_map_are_skipped(self):
        recs = {"a": make_record("a")}  # "b" intentionally absent
        cluster = DuplicateCluster(canonical_id="a", member_ids=["a", "b"])
        rows = _rows_from_result(_result([], [cluster]), recs)
        assert {r.record_id for r, _, _ in rows} == {"a"}


# ---------------------------------------------------------------------------
# LoggingSink
# ---------------------------------------------------------------------------


class TestLoggingSink:
    def test_write_does_not_raise(self):
        recs = {"a": make_record("a")}
        LoggingSink(Logger()).write(_result(["a"], []), recs)

    def test_close_is_noop(self):
        LoggingSink(Logger()).close()  # must not raise


# ---------------------------------------------------------------------------
# Fake psycopg2 for PostgresSink
# ---------------------------------------------------------------------------


class _FakeCursor:
    def __init__(self, store):
        self._store = store

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self._store.append((sql, params))


class _FakeConn:
    def __init__(self):
        self.autocommit = None
        self.executed: list = []
        self.commits = 0
        self.rollbacks = 0
        self.closed = False
        self.fail_on_execute = False

    def cursor(self):
        if self.fail_on_execute:
            raise RuntimeError("boom")
        return _FakeCursor(self.executed)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


class _FakePsycopg2:
    def __init__(self, conn):
        self._conn = conn

    def connect(self, dsn):
        return self._conn


@pytest.fixture
def fake_conn(monkeypatch):
    conn = _FakeConn()
    monkeypatch.setitem(sys.modules, "psycopg2", _FakePsycopg2(conn))
    return conn


# ---------------------------------------------------------------------------
# PostgresSink (with fake driver)
# ---------------------------------------------------------------------------


class TestPostgresSink:
    def test_ensure_schema_runs_on_construction(self, fake_conn):
        PostgresSink("dsn", Logger())
        assert len(fake_conn.executed) == 1  # schema DDL
        assert "CREATE TABLE" in fake_conn.executed[0][0]
        assert fake_conn.commits == 1

    def test_write_upserts_every_row_and_commits(self, fake_conn):
        sink = PostgresSink("dsn", Logger())
        recs = {rid: make_record(rid) for rid in ("a", "b", "c")}
        cluster = DuplicateCluster(canonical_id="a", member_ids=["a", "b"])
        sink.write(_result(["c"], [cluster]), recs)

        upserts = [e for e in fake_conn.executed if "INSERT INTO job_postings" in e[0]]
        assert len(upserts) == 3
        assert fake_conn.commits == 2  # schema + write

    def test_write_with_no_rows_is_noop(self, fake_conn):
        sink = PostgresSink("dsn", Logger())
        commits_before = fake_conn.commits
        sink.write(_result([], []), {})
        assert fake_conn.commits == commits_before  # nothing written

    def test_write_failure_rolls_back(self, fake_conn):
        sink = PostgresSink("dsn", Logger())
        fake_conn.fail_on_execute = True
        sink.write(_result(["a"], []), {"a": make_record("a")})
        assert fake_conn.rollbacks == 1

    def test_close_closes_connection(self, fake_conn):
        sink = PostgresSink("dsn", Logger())
        sink.close()
        assert fake_conn.closed is True


# ---------------------------------------------------------------------------
# create_sink factory
# ---------------------------------------------------------------------------


class TestCreateSink:
    def test_returns_logging_sink_when_no_dsn(self, monkeypatch):
        monkeypatch.delenv("DEDUP_POSTGRES_DSN", raising=False)
        assert isinstance(create_sink(Logger()), LoggingSink)

    def test_returns_postgres_sink_when_dsn_set(self, monkeypatch, fake_conn):
        monkeypatch.setenv("DEDUP_POSTGRES_DSN", "postgresql://x/y")
        assert isinstance(create_sink(Logger()), PostgresSink)
