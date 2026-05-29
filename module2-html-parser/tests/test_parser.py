"""Tests for HtmlParser — full strategy cascade, error paths, force_strategy."""
import json
from unittest.mock import MagicMock

import pytest

from src.css_extractor import CssExtractor
from src.heuristic_extractor import HeuristicExtractor
from src.llm_extractor import LLMExtractor
from src.logger import Logger
from src.normaliser import Normaliser
from src.parser import HtmlParser
from src.types import (
    CssSelectorSet,
    ExtractionStrategy,
    LLMConfig,
    ParseError,
    ParseErrorCode,
    ParseRequest,
    ParseResult,
    ParserConfig,
)


def _config(strategy_order: list[ExtractionStrategy] | None = None) -> ParserConfig:
    return ParserConfig(
        selector_sets=[
            CssSelectorSet(
                name="test",
                job_title=["h1.title"],
                company_name=[".company"],
                location=[".location"],
            )
        ],
        llm=LLMConfig(
            model="claude-haiku-4-5",
            max_tokens=512,
            temperature=0.0,
            timeout_seconds=10.0,
            max_html_chars=50_000,
        ),
        min_html_length=50,
        strategy_order=strategy_order or [
            ExtractionStrategy.CSS_SELECTORS,
            ExtractionStrategy.HEURISTIC,
            ExtractionStrategy.LLM,
        ],
    )


def _request(html: str, force: ExtractionStrategy | None = None) -> ParseRequest:
    return ParseRequest(
        task_id="test-task-1",
        url="https://example.com/job/123",
        html=html,
        force_strategy=force,
    )


def _make_parser(config: ParserConfig | None = None, anthropic_client: MagicMock | None = None) -> HtmlParser:
    cfg = config or _config()
    client = anthropic_client or MagicMock()
    return HtmlParser(
        config=cfg,
        strategies={
            ExtractionStrategy.CSS_SELECTORS: CssExtractor(),
            ExtractionStrategy.HEURISTIC: HeuristicExtractor(),
            ExtractionStrategy.LLM: LLMExtractor(client=client, logger=Logger()),
        },
        normaliser=Normaliser(),
        logger=Logger(),
    )


_CSS_HTML = """
<html><body>
  <h1 class="title">Staff Engineer</h1>
  <div class="company">Acme Corp</div>
  <div class="location">London, UK</div>
</body></html>
"""


class TestHtmlParserCssHit:
    def test_returns_parse_result_on_css_hit(self) -> None:
        parser = _make_parser()
        result = parser.parse(_request(_CSS_HTML))
        assert isinstance(result, ParseResult)
        assert result.strategy_used == ExtractionStrategy.CSS_SELECTORS
        assert result.posting.job_title == "Staff Engineer"
        assert result.posting.company_name == "Acme Corp"
        assert result.task_id == "test-task-1"
        assert result.extracted_at  # non-empty ISO timestamp

    def test_extracted_at_is_iso8601(self) -> None:
        from datetime import datetime
        parser = _make_parser()
        result = parser.parse(_request(_CSS_HTML))
        assert isinstance(result, ParseResult)
        datetime.fromisoformat(result.extracted_at)


class TestHtmlParserHeuristicFallback:
    def test_falls_through_to_heuristic(self) -> None:
        # No CSS selectors configured — CSS will always miss
        cfg = _config()
        cfg = ParserConfig(
            selector_sets=[],  # empty selector sets → CSS always misses
            llm=cfg.llm,
            min_html_length=cfg.min_html_length,
            strategy_order=cfg.strategy_order,
        )
        ld_data = json.dumps({
            "@type": "JobPosting",
            "title": "Backend Engineer",
            "hiringOrganization": {"name": "Stripe"},
            "jobLocation": {"address": {"addressLocality": "Dublin", "addressCountry": "Ireland"}},
        })
        html = f"<html><head><script type='application/ld+json'>{ld_data}</script></head><body>extra content to pass min length check</body></html>"
        parser = _make_parser(config=cfg)
        result = parser.parse(_request(html))
        assert isinstance(result, ParseResult)
        assert result.strategy_used == ExtractionStrategy.HEURISTIC
        assert result.posting.company_name == "Stripe"


class TestHtmlParserLLMFallback:
    def test_falls_through_to_llm(self) -> None:
        client = MagicMock()
        valid_json = json.dumps({
            "job_title": "Principal Engineer",
            "company_name": "DeepMind",
            "location": {"city": "London", "country": "United Kingdom"},
            "skills": ["Python"],
            "seniority_level": "principal",
        })
        block = MagicMock()
        block.type = "text"
        block.text = valid_json
        response = MagicMock()
        response.content = [block]
        client.messages.create.return_value = response

        cfg = ParserConfig(
            selector_sets=[],
            llm=_config().llm,
            min_html_length=10,
            strategy_order=[ExtractionStrategy.LLM],
        )
        html = "<html><body>No structured data here at all</body></html>"
        parser = _make_parser(config=cfg, anthropic_client=client)
        result = parser.parse(_request(html))
        assert isinstance(result, ParseResult)
        assert result.strategy_used == ExtractionStrategy.LLM
        assert result.posting.job_title == "Principal Engineer"


class TestHtmlParserErrorPaths:
    def test_returns_parse_error_on_html_too_short(self) -> None:
        parser = _make_parser()
        result = parser.parse(_request("<html></html>"))
        assert isinstance(result, ParseError)
        assert result.error_code == ParseErrorCode.HTML_TOO_SHORT
        assert result.strategies_attempted == []

    def test_returns_parse_error_when_all_strategies_fail(self) -> None:
        client = MagicMock()
        client.messages.create.return_value = MagicMock(content=[])
        cfg = ParserConfig(
            selector_sets=[],
            llm=_config().llm,
            min_html_length=10,
            strategy_order=[
                ExtractionStrategy.CSS_SELECTORS,
                ExtractionStrategy.HEURISTIC,
                ExtractionStrategy.LLM,
            ],
        )
        html = "<html><body>No data here whatsoever</body></html>"
        parser = _make_parser(config=cfg, anthropic_client=client)
        result = parser.parse(_request(html))
        assert isinstance(result, ParseError)
        assert result.error_code == ParseErrorCode.ALL_STRATEGIES_FAILED
        assert ExtractionStrategy.HEURISTIC in result.strategies_attempted

    def test_returns_parse_error_on_normalisation_failure(self) -> None:
        # CSS selects something but company_name is missing → normaliser raises
        html = "<html><body><h1 class='title'>Engineer</h1>lots of text here to pass min length</body></html>"
        cfg = ParserConfig(
            selector_sets=[
                CssSelectorSet(
                    name="partial",
                    job_title=["h1.title"],
                    company_name=[".no-company"],  # won't match → None
                    location=[".location"],
                )
            ],
            llm=_config().llm,
            min_html_length=10,
            strategy_order=[ExtractionStrategy.CSS_SELECTORS],
        )
        parser = _make_parser(config=cfg)
        result = parser.parse(_request(html))
        assert isinstance(result, ParseError)
        assert result.error_code == ParseErrorCode.NORMALISATION_ERROR


class TestHtmlParserForceStrategy:
    def test_force_strategy_skips_others(self) -> None:
        ld_data = json.dumps({
            "@type": "JobPosting",
            "title": "Heuristic Title",
            "hiringOrganization": {"name": "Heuristic Corp"},
        })
        html = f"""<html><head><script type='application/ld+json'>{ld_data}</script></head>
        <body>extra text to pass length<h1 class='title'>CSS Title</h1>
        <div class='company'>CSS Corp</div><div class='location'>NY</div></body></html>"""
        parser = _make_parser()
        result = parser.parse(_request(html, force=ExtractionStrategy.HEURISTIC))
        assert isinstance(result, ParseResult)
        assert result.strategy_used == ExtractionStrategy.HEURISTIC
        assert result.posting.job_title == "Heuristic Title"


class TestHtmlParserFactory:
    def test_create_factory_returns_html_parser(self) -> None:
        client = MagicMock()
        parser = HtmlParser.create(config=_config(), anthropic_client=client)
        assert isinstance(parser, HtmlParser)
