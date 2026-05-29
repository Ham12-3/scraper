"""Tests for Pydantic model validators and edge cases in types.py."""
import pytest
from pydantic import ValidationError

from src.types import (
    ExtractionStrategy,
    LLMConfig,
    NormalisedJobPosting,
    JobFunction,
    Location,
    ParseRequest,
    ParserConfig,
    RawJobPosting,
    SeniorityLevel,
)


class TestRawJobPosting:
    def test_is_empty_when_all_none(self) -> None:
        assert RawJobPosting().is_empty()

    def test_is_empty_false_when_title_set(self) -> None:
        assert not RawJobPosting(job_title="Engineer").is_empty()

    def test_is_empty_false_when_skills_set(self) -> None:
        assert not RawJobPosting(skills_raw=["Python"]).is_empty()

    def test_is_empty_ignores_seniority_and_date_alone(self) -> None:
        # seniority_raw and posted_date_raw alone don't count as non-empty
        assert RawJobPosting(seniority_raw="senior", posted_date_raw="2024-01-01").is_empty()


class TestNormalisedJobPosting:
    def _valid(self, **overrides):  # type: ignore[no-untyped-def]
        defaults = dict(
            job_title="  Senior Engineer  ",
            job_function=JobFunction.SOFTWARE_ENGINEERING,
            company_name="  Acme Corp  ",
            location=Location(city="London", country="UK"),
            seniority_level=SeniorityLevel.SENIOR,
        )
        return NormalisedJobPosting(**(defaults | overrides))

    def test_strips_job_title_whitespace(self) -> None:
        p = self._valid(job_title="  Senior Engineer  ")
        assert p.job_title == "Senior Engineer"

    def test_strips_company_name_whitespace(self) -> None:
        p = self._valid(company_name="  Acme  Corp  ")
        assert p.company_name == "Acme Corp"

    def test_strips_skill_whitespace(self) -> None:
        p = self._valid(skills=["  Python  ", "  Go  "])
        assert p.skills == ["Python", "Go"]

    def test_drops_blank_skills(self) -> None:
        p = self._valid(skills=["Python", "   ", ""])
        assert p.skills == ["Python"]

    def test_job_title_required(self) -> None:
        with pytest.raises(ValidationError):
            NormalisedJobPosting(
                job_title=None,  # type: ignore[arg-type]
                job_function=JobFunction.UNKNOWN,
                company_name="X",
                location=Location(),
                seniority_level=SeniorityLevel.UNKNOWN,
            )


class TestParserConfig:
    def _llm_config(self) -> LLMConfig:
        return LLMConfig(
            model="claude-haiku-4-5",
            max_tokens=512,
            temperature=0.0,
            timeout_seconds=10.0,
            max_html_chars=10_000,
        )

    def test_strategy_order_must_not_be_empty(self) -> None:
        with pytest.raises(ValidationError):
            ParserConfig(
                llm=self._llm_config(),
                min_html_length=100,
                strategy_order=[],
            )

    def test_llm_max_tokens_must_be_positive(self) -> None:
        with pytest.raises(ValidationError):
            LLMConfig(
                model="claude-haiku-4-5",
                max_tokens=0,
                temperature=0.0,
                timeout_seconds=10.0,
                max_html_chars=10_000,
            )

    def test_llm_temperature_bounds(self) -> None:
        with pytest.raises(ValidationError):
            LLMConfig(
                model="m",
                max_tokens=1,
                temperature=1.5,
                timeout_seconds=1.0,
                max_html_chars=1,
            )


class TestParseRequest:
    def test_force_strategy_defaults_none(self) -> None:
        req = ParseRequest(task_id="t1", url="https://example.com", html="<html/>")
        assert req.force_strategy is None

    def test_force_strategy_accepted(self) -> None:
        req = ParseRequest(
            task_id="t1",
            url="https://example.com",
            html="<html/>",
            force_strategy=ExtractionStrategy.LLM,
        )
        assert req.force_strategy == ExtractionStrategy.LLM
