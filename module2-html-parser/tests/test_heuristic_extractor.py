"""Tests for HeuristicExtractor — JSON-LD, Microdata, Open Graph, ARIA, merge."""
import json

import pytest

from src.heuristic_extractor import HeuristicExtractor
from src.types import ExtractionStrategy, LLMConfig, ParserConfig


def _config() -> ParserConfig:
    return ParserConfig(
        llm=LLMConfig(
            model="claude-haiku-4-5",
            max_tokens=512,
            temperature=0.0,
            timeout_seconds=10.0,
            max_html_chars=50_000,
        ),
        min_html_length=10,
        strategy_order=[ExtractionStrategy.HEURISTIC],
    )


_CFG = _config()


def _json_ld_html(data: dict) -> str:  # type: ignore[type-arg]
    blob = json.dumps(data)
    return f'<html><head><script type="application/ld+json">{blob}</script></head></html>'


class TestHeuristicExtractorJsonLd:
    def test_extracts_job_posting(self) -> None:
        html = _json_ld_html({
            "@type": "JobPosting",
            "title": "Backend Engineer",
            "hiringOrganization": {"@type": "Organization", "name": "Stripe"},
            "jobLocation": {"address": {"addressLocality": "Dublin", "addressCountry": "IE"}},
            "datePosted": "2024-03-01",
        })
        result = HeuristicExtractor().extract(html, _CFG)
        assert result is not None
        assert result.job_title == "Backend Engineer"
        assert result.company_name == "Stripe"
        assert "Dublin" in (result.location_raw or "")
        assert result.posted_date_raw == "2024-03-01"

    def test_handles_graph_array(self) -> None:
        html = _json_ld_html({
            "@graph": [
                {"@type": "Organization", "name": "Acme"},
                {"@type": "JobPosting", "title": "QA Engineer", "hiringOrganization": {"name": "Acme"}},
            ]
        })
        result = HeuristicExtractor().extract(html, _CFG)
        assert result is not None
        assert result.job_title == "QA Engineer"

    def test_skips_non_job_posting_type(self) -> None:
        html = _json_ld_html({"@type": "Article", "name": "Some Article"})
        result = HeuristicExtractor().extract(html, _CFG)
        assert result is None or result.is_empty()

    def test_skills_from_comma_string(self) -> None:
        html = _json_ld_html({
            "@type": "JobPosting",
            "title": "Dev",
            "hiringOrganization": {"name": "X"},
            "skills": "Python, Go, Rust",
        })
        result = HeuristicExtractor().extract(html, _CFG)
        assert result is not None
        assert "Python" in result.skills_raw


class TestHeuristicExtractorMicrodata:
    def test_extracts_itemprop_fields(self) -> None:
        html = """<html><body>
            <span itemprop="title">Data Scientist</span>
            <span itemprop="hiringOrganization">DeepMind</span>
            <span itemprop="addressLocality">London</span>
        </body></html>"""
        result = HeuristicExtractor().extract(html, _CFG)
        assert result is not None
        assert result.job_title == "Data Scientist"
        assert result.company_name == "DeepMind"


class TestHeuristicExtractorOpenGraph:
    def test_extracts_og_title(self) -> None:
        html = """<html><head>
            <meta property="og:title" content="ML Engineer @ OpenAI"/>
            <meta property="og:site_name" content="OpenAI"/>
        </head></html>"""
        result = HeuristicExtractor().extract(html, _CFG)
        assert result is not None
        assert result.job_title == "ML Engineer @ OpenAI"
        assert result.company_name == "OpenAI"

    def test_returns_none_when_no_og_tags(self) -> None:
        html = "<html><head><meta name='viewport' content='width=device-width'/></head></html>"
        result = HeuristicExtractor().extract(html, _CFG)
        assert result is None or result.is_empty()


class TestHeuristicExtractorAria:
    def test_extracts_h1_job_title(self) -> None:
        html = """<html><body>
            <h1>Senior Software Engineer</h1>
            <main role="main"><p>Acme Inc. is hiring.</p></main>
        </body></html>"""
        result = HeuristicExtractor().extract(html, _CFG)
        assert result is not None
        assert result.job_title == "Senior Software Engineer"

    def test_returns_none_when_nothing_found(self) -> None:
        html = "<html><body><p>Nothing relevant here.</p></body></html>"
        result = HeuristicExtractor().extract(html, _CFG)
        assert result is None or result.is_empty()


class TestHeuristicMerge:
    def test_json_ld_wins_over_meta_for_same_field(self) -> None:
        # JSON-LD has a complete title; OG also has one — JSON-LD should win
        ld_data = json.dumps({
            "@type": "JobPosting",
            "title": "LD Title",
            "hiringOrganization": {"name": "LD Corp"},
        })
        html = f"""<html><head>
            <script type="application/ld+json">{ld_data}</script>
            <meta property="og:title" content="OG Title"/>
        </head></html>"""
        result = HeuristicExtractor().extract(html, _CFG)
        assert result is not None
        assert result.job_title == "LD Title"

    def test_strategy_name(self) -> None:
        assert HeuristicExtractor().strategy_name == ExtractionStrategy.HEURISTIC
