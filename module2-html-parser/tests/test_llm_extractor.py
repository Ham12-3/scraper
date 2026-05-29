"""Tests for LLMExtractor — uses a mocked Anthropic client."""
import json
from unittest.mock import MagicMock, patch

import pytest

from src.llm_extractor import LLMExtractor
from src.logger import Logger
from src.types import ExtractionStrategy, LLMConfig, ParserConfig, SeniorityLevel


def _config() -> ParserConfig:
    return ParserConfig(
        llm=LLMConfig(
            model="claude-haiku-4-5",
            max_tokens=512,
            temperature=0.0,
            timeout_seconds=10.0,
            max_html_chars=500,
        ),
        min_html_length=10,
        strategy_order=[ExtractionStrategy.LLM],
    )


def _make_response(json_str: str) -> MagicMock:
    block = MagicMock()
    block.type = "text"
    block.text = json_str
    response = MagicMock()
    response.content = [block]
    return response


_VALID_JSON = json.dumps({
    "job_title": "Senior Data Engineer",
    "company_name": "Databricks",
    "location": {"city": "San Francisco", "country": "United States"},
    "skills": ["Spark", "Python"],
    "seniority_level": "senior",
})

_HTML = "<html><body><h1>Senior Data Engineer</h1><p>Databricks</p></body></html>"


class TestLLMExtractor:
    def test_strategy_name(self) -> None:
        client = MagicMock()
        assert LLMExtractor(client=client, logger=Logger()).strategy_name == ExtractionStrategy.LLM

    def test_successful_extraction(self) -> None:
        client = MagicMock()
        client.messages.create.return_value = _make_response(_VALID_JSON)
        result = LLMExtractor(client=client, logger=Logger()).extract(_HTML, _config())
        assert result is not None
        assert result.job_title == "Senior Data Engineer"
        assert result.company_name == "Databricks"
        assert "Spark" in result.skills_raw
        assert result.seniority_raw == SeniorityLevel.SENIOR.value

    def test_returns_none_on_empty_html(self) -> None:
        client = MagicMock()
        result = LLMExtractor(client=client, logger=Logger()).extract("", _config())
        assert result is None
        client.messages.create.assert_not_called()

    def test_returns_none_on_api_connection_error(self) -> None:
        import anthropic
        client = MagicMock()
        client.messages.create.side_effect = anthropic.APIConnectionError(request=MagicMock())
        result = LLMExtractor(client=client, logger=Logger()).extract(_HTML, _config())
        assert result is None

    def test_returns_none_on_rate_limit_error(self) -> None:
        import anthropic
        client = MagicMock()
        client.messages.create.side_effect = anthropic.RateLimitError(
            message="rate limited", response=MagicMock(), body={}
        )
        result = LLMExtractor(client=client, logger=Logger()).extract(_HTML, _config())
        assert result is None

    def test_returns_none_on_malformed_json(self) -> None:
        client = MagicMock()
        client.messages.create.return_value = _make_response("not valid json {{")
        result = LLMExtractor(client=client, logger=Logger()).extract(_HTML, _config())
        assert result is None

    def test_returns_none_on_schema_mismatch(self) -> None:
        client = MagicMock()
        # Missing required fields
        client.messages.create.return_value = _make_response('{"job_title": "Dev"}')
        result = LLMExtractor(client=client, logger=Logger()).extract(_HTML, _config())
        assert result is None

    def test_strips_markdown_code_fences(self) -> None:
        client = MagicMock()
        fenced = f"```json\n{_VALID_JSON}\n```"
        client.messages.create.return_value = _make_response(fenced)
        result = LLMExtractor(client=client, logger=Logger()).extract(_HTML, _config())
        assert result is not None
        assert result.job_title == "Senior Data Engineer"

    def test_html_truncated_to_max_chars(self) -> None:
        client = MagicMock()
        client.messages.create.return_value = _make_response(_VALID_JSON)
        long_html = "<html><body>" + "x " * 10_000 + "</body></html>"
        LLMExtractor(client=client, logger=Logger()).extract(long_html, _config())
        call_kwargs = client.messages.create.call_args
        user_content = call_kwargs.kwargs["messages"][0]["content"]
        # The stripped text passed to the LLM must be <= max_html_chars (500)
        assert len(user_content) <= 600  # allow for prompt prefix

    def test_returns_none_on_empty_response_content(self) -> None:
        client = MagicMock()
        response = MagicMock()
        response.content = []
        client.messages.create.return_value = response
        result = LLMExtractor(client=client, logger=Logger()).extract(_HTML, _config())
        assert result is None
