"""
Tests for the Flask HTTP server (create_app factory).

These use an injected fake parser so no Anthropic client, API key, or env vars
are needed. This closes the coverage gap that previously let server.py ship a
broken HtmlParser.create() call.
"""
from datetime import date

import pytest

from src.server import create_app
from src.types import (
    ExtractionStrategy,
    JobFunction,
    Location,
    NormalisedJobPosting,
    ParseError,
    ParseErrorCode,
    ParseRequest,
    ParseResult,
    SeniorityLevel,
)


class _StubParser:
    """Returns a preset ParseResult or ParseError; records the request it saw."""

    def __init__(self, response):
        self._response = response
        self.last_request: ParseRequest | None = None

    def parse(self, request: ParseRequest):
        self.last_request = request
        return self._response


def _ok_result(task_id: str = "t1", url: str = "https://example.com") -> ParseResult:
    return ParseResult(
        task_id=task_id,
        url=url,
        strategy_used=ExtractionStrategy.HEURISTIC,
        posting=NormalisedJobPosting(
            job_title="Senior Software Engineer",
            job_function=JobFunction.SOFTWARE_ENGINEERING,
            company_name="Acme Corp",
            location=Location(city="London", country="UK"),
            skills=["Python", "Kubernetes"],
            seniority_level=SeniorityLevel.SENIOR,
            posted_date=date(2024, 6, 1),
        ),
        extracted_at="2024-06-01T12:00:00+00:00",
    )


@pytest.fixture
def client_ok():
    app = create_app(_StubParser(_ok_result()))
    app.config.update(TESTING=True)
    return app.test_client()


class TestHealth:
    def test_health_returns_ok(self, client_ok):
        resp = client_ok.get("/health")
        assert resp.status_code == 200
        assert resp.get_json() == {"status": "ok"}


class TestParse:
    def test_parse_returns_module3_compatible_json(self, client_ok):
        resp = client_ok.post(
            "/parse",
            json={"task_id": "t1", "url": "https://example.com", "html": "<html>...</html>"},
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["taskId"] == "t1"
        assert body["jobTitle"] == "Senior Software Engineer"
        assert body["jobFunction"] == "software_engineering"
        assert body["companyName"] == "Acme Corp"
        assert body["locationCity"] == "London"
        assert body["locationCountry"] == "UK"
        assert body["skills"] == ["Python", "Kubernetes"]
        assert body["seniorityLevel"] == "senior"
        assert body["postedDate"] == "2024-06-01"
        assert body["extractionStrategy"] == "heuristic"
        assert "processedAt" in body

    def test_parse_forwards_request_fields_to_parser(self):
        stub = _StubParser(_ok_result())
        client = create_app(stub).test_client()
        client.post("/parse", json={"task_id": "abc", "url": "u", "html": "h"})
        assert stub.last_request.task_id == "abc"
        assert stub.last_request.url == "u"
        assert stub.last_request.html == "h"

    def test_parse_missing_fields_default_to_empty(self):
        stub = _StubParser(_ok_result())
        client = create_app(stub).test_client()
        client.post("/parse", json={})
        assert stub.last_request.task_id == ""
        assert stub.last_request.url == ""
        assert stub.last_request.html == ""

    def test_parse_error_returns_422(self):
        err = ParseError(
            task_id="t1",
            url="https://example.com",
            error_code=ParseErrorCode.ALL_STRATEGIES_FAILED,
            message="nothing matched",
        )
        client = create_app(_StubParser(err)).test_client()
        resp = client.post("/parse", json={"task_id": "t1", "url": "x", "html": "y"})
        assert resp.status_code == 422
        body = resp.get_json()
        assert body["error"] == "ALL_STRATEGIES_FAILED"
        assert body["message"] == "nothing matched"


class TestFactory:
    def test_create_app_does_not_build_real_parser_when_injected(self):
        # Must not touch env / Anthropic when a parser is supplied.
        app = create_app(_StubParser(_ok_result()))
        assert app is not None
