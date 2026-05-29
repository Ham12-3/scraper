"""Tests for CssExtractor."""
import pytest

from src.css_extractor import CssExtractor
from src.types import CssSelectorSet, ExtractionStrategy, LLMConfig, ParserConfig


def _config(*selector_sets: CssSelectorSet) -> ParserConfig:
    return ParserConfig(
        selector_sets=list(selector_sets),
        llm=LLMConfig(
            model="claude-haiku-4-5",
            max_tokens=512,
            temperature=0.0,
            timeout_seconds=10.0,
            max_html_chars=50_000,
        ),
        min_html_length=10,
        strategy_order=[ExtractionStrategy.CSS_SELECTORS],
    )


def _selector_set(**kwargs) -> CssSelectorSet:  # type: ignore[no-untyped-def]
    defaults = dict(
        name="test",
        job_title=["h1.title"],
        company_name=[".company"],
        location=[".location"],
    )
    return CssSelectorSet(**(defaults | kwargs))


_HTML = """
<html><body>
  <h1 class="title">Senior Python Engineer</h1>
  <div class="company">Acme Corp</div>
  <div class="location">London, UK</div>
  <ul class="skills"><li>Python</li><li>FastAPI</li></ul>
</body></html>
"""


class TestCssExtractor:
    def test_strategy_name(self) -> None:
        assert CssExtractor().strategy_name == ExtractionStrategy.CSS_SELECTORS

    def test_extracts_required_fields(self) -> None:
        cfg = _config(_selector_set())
        result = CssExtractor().extract(_HTML, cfg)
        assert result is not None
        assert result.job_title == "Senior Python Engineer"
        assert result.company_name == "Acme Corp"
        assert result.location_raw == "London, UK"

    def test_extracts_skills(self) -> None:
        cfg = _config(_selector_set(skills=["ul.skills li"]))
        result = CssExtractor().extract(_HTML, cfg)
        assert result is not None
        assert "Python" in result.skills_raw
        assert "FastAPI" in result.skills_raw

    def test_returns_none_when_no_selector_sets(self) -> None:
        cfg = _config()
        assert CssExtractor().extract(_HTML, cfg) is None

    def test_returns_none_when_selectors_dont_match(self) -> None:
        cfg = _config(_selector_set(job_title=[".no-match"], company_name=[".also-no-match"], location=[".nope"]))
        assert CssExtractor().extract(_HTML, cfg) is None

    def test_falls_through_to_second_selector_set(self) -> None:
        first = _selector_set(name="miss", job_title=[".no-match"], company_name=[".no-match"], location=[".no-match"])
        second = _selector_set(name="hit")
        cfg = _config(first, second)
        result = CssExtractor().extract(_HTML, cfg)
        assert result is not None
        assert result.job_title == "Senior Python Engineer"

    def test_invalid_selector_is_skipped_gracefully(self) -> None:
        cfg = _config(_selector_set(job_title=["h1.title"], company_name=[":::invalid:::"], location=[".location"]))
        # Should not raise; company_name will just be None
        result = CssExtractor().extract(_HTML, cfg)
        assert result is not None
        assert result.company_name is None

    def test_deduplicates_skills(self) -> None:
        html = "<html><ul><li class='s'>Python</li><li class='s'>Python</li></ul></html>"
        cfg = _config(_selector_set(skills=[".s"]))
        result = CssExtractor().extract(html, cfg)
        assert result is not None
        assert result.skills_raw.count("Python") == 1
