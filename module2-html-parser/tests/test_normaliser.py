"""Tests for Normaliser — location parsing, seniority/job-function mapping, date parsing."""
from datetime import date

import pytest

from src.normaliser import Normaliser, _map_job_function, _map_seniority, _parse_date, _parse_location
from src.types import JobFunction, Location, RawJobPosting, SeniorityLevel


def _raw(**kwargs) -> RawJobPosting:  # type: ignore[no-untyped-def]
    defaults = dict(job_title="Software Engineer", company_name="Acme Corp")
    return RawJobPosting(**(defaults | kwargs))


class TestNormaliserNormalise:
    def test_returns_normalised_posting(self) -> None:
        result = Normaliser().normalise(_raw())
        assert result.job_title == "Software Engineer"
        assert result.company_name == "Acme Corp"

    def test_raises_when_job_title_missing(self) -> None:
        with pytest.raises(ValueError, match="job_title"):
            Normaliser().normalise(_raw(job_title=None))

    def test_raises_when_company_name_missing(self) -> None:
        with pytest.raises(ValueError, match="company_name"):
            Normaliser().normalise(_raw(company_name=None))

    def test_raises_when_both_required_missing(self) -> None:
        with pytest.raises(ValueError, match="job_title"):
            Normaliser().normalise(RawJobPosting())

    def test_skills_forwarded(self) -> None:
        result = Normaliser().normalise(_raw(skills_raw=["Python", "Go"]))
        assert result.skills == ["Python", "Go"]


class TestSeniorityMapping:
    @pytest.mark.parametrize("raw,expected", [
        ("intern", SeniorityLevel.INTERN),
        ("Junior Developer", SeniorityLevel.JUNIOR),
        ("jr. engineer", SeniorityLevel.JUNIOR),
        ("Senior Software Engineer", SeniorityLevel.SENIOR),
        ("sr. developer", SeniorityLevel.SENIOR),
        ("Staff Engineer", SeniorityLevel.STAFF),
        ("Principal Architect", SeniorityLevel.PRINCIPAL),
        ("Lead Developer", SeniorityLevel.LEAD),
        ("Mid-Level Developer", SeniorityLevel.MID),
        ("Engineering Manager", SeniorityLevel.MANAGER),
        ("Director of Engineering", SeniorityLevel.DIRECTOR),
        ("VP Engineering", SeniorityLevel.VP),
        ("CTO", SeniorityLevel.C_SUITE),
        ("CEO", SeniorityLevel.C_SUITE),
        ("unknown random title", SeniorityLevel.UNKNOWN),
        (None, SeniorityLevel.UNKNOWN),
        ("", SeniorityLevel.UNKNOWN),
        # Direct enum value pass-through (from LLM extractor)
        ("senior", SeniorityLevel.SENIOR),
        ("c_suite", SeniorityLevel.C_SUITE),
    ])
    def test_mapping(self, raw: str | None, expected: SeniorityLevel) -> None:
        assert _map_seniority(raw) == expected


class TestJobFunctionMapping:
    @pytest.mark.parametrize("title,expected", [
        ("Software Engineer", JobFunction.SOFTWARE_ENGINEERING),
        ("Backend Developer", JobFunction.SOFTWARE_ENGINEERING),
        ("Frontend Developer", JobFunction.SOFTWARE_ENGINEERING),
        ("Full Stack Engineer", JobFunction.SOFTWARE_ENGINEERING),
        ("Data Engineer", JobFunction.DATA_ENGINEERING),
        ("Data Scientist", JobFunction.DATA_SCIENCE),
        ("Data Analyst", JobFunction.DATA_SCIENCE),
        ("Machine Learning Engineer", JobFunction.MACHINE_LEARNING),
        ("ML Engineer", JobFunction.MACHINE_LEARNING),
        ("DevOps Engineer", JobFunction.DEVOPS),
        ("Site Reliability Engineer", JobFunction.DEVOPS),
        ("Security Engineer", JobFunction.SECURITY),
        ("QA Engineer", JobFunction.QA),
        ("Product Manager", JobFunction.PRODUCT_MANAGEMENT),
        ("Product Owner", JobFunction.PRODUCT_MANAGEMENT),
        ("UX Designer", JobFunction.DESIGN),
        ("UI/UX Designer", JobFunction.DESIGN),
        ("Account Executive", JobFunction.SALES),
        ("SDR", JobFunction.SALES),
        ("VP of Sales", JobFunction.SALES_LEADERSHIP),
        ("Head of Sales", JobFunction.SALES_LEADERSHIP),
        ("Marketing Manager", JobFunction.MARKETING),
        ("Financial Analyst", JobFunction.FINANCE),
        ("Legal Counsel", JobFunction.LEGAL),
        ("Recruiter", JobFunction.HR),
        ("Customer Success Manager", JobFunction.CUSTOMER_SUCCESS),
        ("Research Scientist", JobFunction.RESEARCH),
        ("Operations Manager", JobFunction.OPERATIONS),
        ("CEO", JobFunction.GENERAL_MANAGEMENT),
        ("Interpretive Dancer", JobFunction.UNKNOWN),
    ])
    def test_mapping(self, title: str, expected: JobFunction) -> None:
        assert _map_job_function(title) == expected


class TestLocationParsing:
    def test_city_and_country(self) -> None:
        loc = _parse_location("London, UK")
        assert loc.city == "London"
        assert loc.country == "UK"

    def test_city_state_country(self) -> None:
        loc = _parse_location("San Francisco, CA, United States")
        assert loc.city == "San Francisco"
        assert loc.country == "United States"

    def test_city_only(self) -> None:
        loc = _parse_location("Berlin")
        assert loc.city == "Berlin"
        assert loc.country is None

    def test_empty_string(self) -> None:
        loc = _parse_location("")
        assert loc.city is None
        assert loc.country is None

    def test_none_returns_empty_location(self) -> None:
        loc = _parse_location(None)
        assert loc == Location()


class TestDateParsing:
    def test_iso_date(self) -> None:
        assert _parse_date("2024-03-15") == date(2024, 3, 15)

    def test_human_readable(self) -> None:
        assert _parse_date("March 15, 2024") == date(2024, 3, 15)

    def test_datetime_string(self) -> None:
        assert _parse_date("2024-03-15T12:00:00Z") == date(2024, 3, 15)

    def test_none_returns_none(self) -> None:
        assert _parse_date(None) is None

    def test_unparseable_returns_none(self) -> None:
        assert _parse_date("not a date at all xyz") is None

    def test_empty_string_returns_none(self) -> None:
        assert _parse_date("") is None
