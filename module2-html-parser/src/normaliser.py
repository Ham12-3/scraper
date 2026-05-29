"""
Converts a RawJobPosting into a NormalisedJobPosting.
Pure deterministic logic — no external calls, no side effects.
"""
from __future__ import annotations

import re
from datetime import date

from dateutil import parser as dateutil_parser

from .types import (
    JobFunction,
    Location,
    NormalisedJobPosting,
    RawJobPosting,
    SeniorityLevel,
)


# ---------------------------------------------------------------------------
# Seniority mapping
# ---------------------------------------------------------------------------

_SENIORITY_KEYWORDS: list[tuple[re.Pattern[str], SeniorityLevel]] = [
    (re.compile(r"\bintern\b", re.IGNORECASE), SeniorityLevel.INTERN),
    (re.compile(r"\bjunior\b|\bjr\.?\b", re.IGNORECASE), SeniorityLevel.JUNIOR),
    (re.compile(r"\bstaff\b", re.IGNORECASE), SeniorityLevel.STAFF),
    (re.compile(r"\bprincipal\b", re.IGNORECASE), SeniorityLevel.PRINCIPAL),
    (re.compile(r"\blead\b", re.IGNORECASE), SeniorityLevel.LEAD),
    (re.compile(r"\bsenior\b|\bsr\.?\b", re.IGNORECASE), SeniorityLevel.SENIOR),
    (re.compile(r"\bmid[\s-]?level\b|\bmid\b", re.IGNORECASE), SeniorityLevel.MID),
    (re.compile(r"\bvp\b|\bvice[\s-]president\b", re.IGNORECASE), SeniorityLevel.VP),
    (re.compile(r"\bceo\b|\bcto\b|\bcoo\b|\bcfo\b|\bcmo\b|\bcso\b", re.IGNORECASE), SeniorityLevel.C_SUITE),
    (re.compile(r"\bdirector\b", re.IGNORECASE), SeniorityLevel.DIRECTOR),
    (re.compile(r"\bmanager\b|\bmgr\b", re.IGNORECASE), SeniorityLevel.MANAGER),
]


def _map_seniority(raw: str | None) -> SeniorityLevel:
    if not raw:
        return SeniorityLevel.UNKNOWN
    text = raw.strip()
    # Direct enum value match (fast path — LLMExtractor already emits enum values)
    for level in SeniorityLevel:
        if text.lower() == level.value:
            return level
    # Keyword scan on raw title strings
    for pattern, level in _SENIORITY_KEYWORDS:
        if pattern.search(text):
            return level
    return SeniorityLevel.UNKNOWN


# ---------------------------------------------------------------------------
# Job function mapping
# ---------------------------------------------------------------------------

# Rules are evaluated in order; first match wins. More-specific rules must
# appear before broader ones (e.g. DATA_ENGINEERING before SOFTWARE_ENGINEERING).
_JOB_FUNCTION_RULES: list[tuple[re.Pattern[str], JobFunction]] = [
    (
        re.compile(
            r"\bsales[\s-]?(director|vp|head|lead|manager|leadership)\b"
            r"|\bhead\s+of\s+sales\b|\bchief\s+revenue\b"
            r"|\bvp\s+of\s+sales\b|\bvp,?\s+sales\b",
            re.IGNORECASE,
        ),
        JobFunction.SALES_LEADERSHIP,
    ),
    (
        re.compile(
            r"\bdata[\s-]?engineer\b|\betl\b|\bdata\s+pipeline\b"
            r"|\bdata\s+infra\w*\b",
            re.IGNORECASE,
        ),
        JobFunction.DATA_ENGINEERING,
    ),
    (
        re.compile(
            r"\bdata\s+scien\w+\b|\bdata\s+analys\w+\b|\banalytics\b",
            re.IGNORECASE,
        ),
        JobFunction.DATA_SCIENCE,
    ),
    (
        re.compile(
            r"\bmachine\s+learning\b|\bml\s+engineer\b|\bai\s+engineer\b"
            r"|\bdeep\s+learning\b|\bmlops\b|\bllmops\b",
            re.IGNORECASE,
        ),
        JobFunction.MACHINE_LEARNING,
    ),
    (
        re.compile(
            r"\bdevops\b|\bsite\s+reliability\b|\bsre\b|\bplatform\s+engineer\b"
            r"|\bcloud\s+engineer\b|\binfrastructure\s+engineer\b"
            r"|\bkubernetes\b|\bk8s\b|\bterraform\b",
            re.IGNORECASE,
        ),
        JobFunction.DEVOPS,
    ),
    (
        re.compile(
            r"\bsecurity\b|\binfosec\b|\bcyber\b|\bpenetration\b"
            r"|\bsoc\s+analyst\b|\bappsec\b",
            re.IGNORECASE,
        ),
        JobFunction.SECURITY,
    ),
    (
        re.compile(
            r"\bqa\s+engineer\b|\bquality\s+assurance\b|\btest\s+engineer\b"
            r"|\btester\b|\bsdet\b",
            re.IGNORECASE,
        ),
        JobFunction.QA,
    ),
    (
        re.compile(
            r"\bproduct\s+manager\b|\bproduct\s+owner\b",
            re.IGNORECASE,
        ),
        JobFunction.PRODUCT_MANAGEMENT,
    ),
    (
        re.compile(
            r"\bux[\s/]?ui\b|\bui[\s/]?ux\b|\bux\s+designer\b|\bui\s+designer\b"
            r"|\bgraphic\s+designer\b|\bvisual\s+designer\b|\bcreative\s+designer\b",
            re.IGNORECASE,
        ),
        JobFunction.DESIGN,
    ),
    (
        re.compile(
            r"\baccount\s+executive\b|\bsales\s+rep\w*\b|\bsdr\b|\bbdr\b"
            r"|\bbusiness\s+development\s+rep\w*\b",
            re.IGNORECASE,
        ),
        JobFunction.SALES,
    ),
    (
        re.compile(
            r"\bmarketing\b|\bgrowth\s+market\w+\b|\bseo\s+specialist\b"
            r"|\bcontent\s+strateg\w+\b|\bdemand\s+gen\w*\b|\bbrand\s+manager\b",
            re.IGNORECASE,
        ),
        JobFunction.MARKETING,
    ),
    (
        re.compile(
            r"\bfinancial\s+analyst\b|\baccountan\w+\b|\bcontroller\b"
            r"|\bfinance\s+manager\b",
            re.IGNORECASE,
        ),
        JobFunction.FINANCE,
    ),
    (
        re.compile(r"\bcounsel\b|\battorney\b|\blawyer\b|\bcompliance\b", re.IGNORECASE),
        JobFunction.LEGAL,
    ),
    (
        re.compile(
            r"\brecruiter\b|\btalent\s+acquisition\b|\bpeople\s+ops\w*\b"
            r"|\bhuman\s+resources\b|\bhr\s+manager\b",
            re.IGNORECASE,
        ),
        JobFunction.HR,
    ),
    (
        re.compile(
            r"\bcustomer\s+success\b|\bcsm\b|\bcustomer\s+experience\b"
            r"|\bcustomer\s+support\b",
            re.IGNORECASE,
        ),
        JobFunction.CUSTOMER_SUCCESS,
    ),
    (
        re.compile(r"\bresearch\s+scien\w+\b|\bresearch\s+engineer\b", re.IGNORECASE),
        JobFunction.RESEARCH,
    ),
    (
        re.compile(
            r"\boperations\s+manager\b|\bbiz\s+ops\b|\bchief\s+of\s+staff\b",
            re.IGNORECASE,
        ),
        JobFunction.OPERATIONS,
    ),
    (
        re.compile(
            r"\bceo\b|\bcto\b|\bcoo\b|\bgeneral\s+manager\b|\bpresident\b"
            r"|\bmanaging\s+director\b",
            re.IGNORECASE,
        ),
        JobFunction.GENERAL_MANAGEMENT,
    ),
    (
        re.compile(
            r"\bengineer\b|\bdeveloper\b|\bprogrammer\b|\bsoftware\b"
            r"|\bbackend\b|\bfrontend\b|\bfull[\s-]?stack\b|\bswe\b",
            re.IGNORECASE,
        ),
        JobFunction.SOFTWARE_ENGINEERING,
    ),
]


def _map_job_function(title: str) -> JobFunction:
    for pattern, function in _JOB_FUNCTION_RULES:
        if pattern.search(title):
            return function
    return JobFunction.UNKNOWN


# ---------------------------------------------------------------------------
# Location parsing
# ---------------------------------------------------------------------------

def _parse_location(raw: str | None) -> Location:
    if not raw:
        return Location()
    text = raw.strip()
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if len(parts) >= 2:
        return Location(city=parts[0], country=parts[-1])
    return Location(city=parts[0] if parts else None)


# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------

def _parse_date(raw: str | None) -> date | None:
    if not raw:
        return None
    try:
        return dateutil_parser.parse(raw.strip(), fuzzy=True).date()
    except (ValueError, OverflowError):
        return None


# ---------------------------------------------------------------------------
# Public normaliser class
# ---------------------------------------------------------------------------

class Normaliser:
    """
    Implements INormaliser. Raises ValueError if job_title or company_name
    are absent — the caller (HtmlParser) catches this and converts to ParseError.
    """

    def normalise(self, raw: RawJobPosting) -> NormalisedJobPosting:
        job_title = (raw.job_title or "").strip()
        company_name = (raw.company_name or "").strip()

        missing: list[str] = []
        if not job_title:
            missing.append("job_title")
        if not company_name:
            missing.append("company_name")
        if missing:
            raise ValueError(
                f"Cannot normalise posting — required field(s) missing: {', '.join(missing)}"
            )

        return NormalisedJobPosting(
            job_title=job_title,
            job_function=_map_job_function(job_title),
            company_name=company_name,
            location=_parse_location(raw.location_raw),
            skills=raw.skills_raw,
            seniority_level=_map_seniority(raw.seniority_raw),
            posted_date=_parse_date(raw.posted_date_raw),
        )
