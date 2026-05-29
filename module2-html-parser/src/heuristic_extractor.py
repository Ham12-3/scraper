"""
Heuristic extraction layer.

Scanning order (stops at the first non-empty result per field):
  1. JSON-LD <script type="application/ld+json"> blocks (JobPosting schema)
  2. Microdata / itemprop attributes
  3. Open Graph / meta tags
  4. ARIA landmark roles and semantic heading proximity
"""

import json
import re
from typing import Any

from bs4 import BeautifulSoup, NavigableString, Tag

from .types import ExtractionStrategy, ParserConfig, RawJobPosting


# ---------------------------------------------------------------------------
# JSON-LD
# ---------------------------------------------------------------------------

def _extract_json_ld(soup: BeautifulSoup) -> RawJobPosting | None:
    for script in soup.find_all("script", type="application/ld+json"):
        raw = script.get_text(strip=True)
        try:
            data: Any = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue

        # Handle both a single object and an @graph array
        candidates: list[dict[str, Any]] = []
        if isinstance(data, dict):
            if data.get("@type") == "JobPosting":
                candidates.append(data)
            for item in data.get("@graph", []):
                if isinstance(item, dict) and item.get("@type") == "JobPosting":
                    candidates.append(item)
        elif isinstance(data, list):
            candidates = [d for d in data if isinstance(d, dict) and d.get("@type") == "JobPosting"]

        for candidate in candidates:
            location_raw: str | None = None
            loc = candidate.get("jobLocation")
            if isinstance(loc, dict):
                address = loc.get("address", {})
                if isinstance(address, dict):
                    parts = [
                        address.get("addressLocality"),
                        address.get("addressCountry"),
                    ]
                    location_raw = ", ".join(p for p in parts if p)
                elif isinstance(address, str):
                    location_raw = address
            elif isinstance(loc, str):
                location_raw = loc

            skills_raw: list[str] = []
            skills_field = candidate.get("skills") or candidate.get("experienceRequirements")
            if isinstance(skills_field, str):
                skills_raw = [s.strip() for s in re.split(r"[,;]", skills_field) if s.strip()]
            elif isinstance(skills_field, list):
                skills_raw = [str(s).strip() for s in skills_field if s]

            posting = RawJobPosting(
                job_title=_str_or_none(candidate.get("title") or candidate.get("name")),
                company_name=_str_or_none(
                    _deep_get(candidate, "hiringOrganization", "name")
                    or candidate.get("hiringOrganization")
                ),
                location_raw=location_raw,
                skills_raw=skills_raw,
                posted_date_raw=_str_or_none(
                    candidate.get("datePosted") or candidate.get("validThrough")
                ),
            )
            if not posting.is_empty():
                return posting

    return None


# ---------------------------------------------------------------------------
# Microdata / itemprop
# ---------------------------------------------------------------------------

_ITEMPROP_MAP: dict[str, str] = {
    "title": "job_title",
    "name": "job_title",
    "jobTitle": "job_title",
    "hiringOrganization": "company_name",
    "employerOverview": "company_name",
    "jobLocation": "location_raw",
    "addressLocality": "location_raw",
    "datePosted": "posted_date_raw",
    "validThrough": "posted_date_raw",
    "skills": "skills_raw",
    "experienceRequirements": "skills_raw",
}


def _extract_microdata(soup: BeautifulSoup) -> RawJobPosting | None:
    fields: dict[str, str | list[str]] = {}

    for node in soup.find_all(itemprop=True):
        if not isinstance(node, Tag):
            continue
        prop = node.get("itemprop")
        if not isinstance(prop, str):
            continue
        target = _ITEMPROP_MAP.get(prop)
        if not target:
            continue

        text = (
            node.get("content")
            or node.get("datetime")
            or node.get_text(separator=" ", strip=True)
        )
        if not text:
            continue

        if target == "skills_raw":
            existing = fields.get("skills_raw", [])
            assert isinstance(existing, list)
            existing.append(str(text))
            fields["skills_raw"] = existing
        elif target not in fields:
            fields[target] = str(text)

    if not fields:
        return None

    posting = RawJobPosting(
        job_title=_str_or_none(fields.get("job_title")),
        company_name=_str_or_none(fields.get("company_name")),
        location_raw=_str_or_none(fields.get("location_raw")),
        skills_raw=fields.get("skills_raw") if isinstance(fields.get("skills_raw"), list) else [],  # type: ignore[arg-type]
        posted_date_raw=_str_or_none(fields.get("posted_date_raw")),
    )
    return None if posting.is_empty() else posting


# ---------------------------------------------------------------------------
# Open Graph / meta tags
# ---------------------------------------------------------------------------

_OG_TITLE_PROPS = {"og:title", "twitter:title"}
_OG_SITE_PROPS = {"og:site_name", "twitter:site"}


def _extract_meta(soup: BeautifulSoup) -> RawJobPosting | None:
    job_title: str | None = None
    company_name: str | None = None

    for meta in soup.find_all("meta"):
        if not isinstance(meta, Tag):
            continue
        prop = str(meta.get("property", "") or meta.get("name", "")).lower()
        content = _str_or_none(meta.get("content"))
        if not content:
            continue
        if prop in _OG_TITLE_PROPS and not job_title:
            job_title = content
        if prop in _OG_SITE_PROPS and not company_name:
            company_name = content

    if not job_title and not company_name:
        return None

    posting = RawJobPosting(job_title=job_title, company_name=company_name)
    return None if posting.is_empty() else posting


# ---------------------------------------------------------------------------
# ARIA landmark / semantic heading proximity
# ---------------------------------------------------------------------------

_ARIA_SECTION_ROLES = {"main", "article", "region"}
_HEADING_TAGS = {"h1", "h2", "h3"}

_TITLE_HINTS = re.compile(
    r"\b(engineer|developer|manager|analyst|designer|scientist|director|"
    r"lead|architect|consultant|specialist|coordinator|officer|vp|president)\b",
    re.IGNORECASE,
)
_COMPANY_HINTS = re.compile(
    r"\b(inc\.|llc|ltd|corp|gmbh|s\.a\.|plc|limited|group|technologies|"
    r"solutions|services|systems|partners)\b",
    re.IGNORECASE,
)


def _extract_aria(soup: BeautifulSoup) -> RawJobPosting | None:
    job_title: str | None = None
    company_name: str | None = None

    # Prefer h1 that looks like a job title
    for h1 in soup.find_all("h1"):
        if not isinstance(h1, Tag):
            continue
        text = h1.get_text(separator=" ", strip=True)
        if text and _TITLE_HINTS.search(text) and not job_title:
            job_title = text
            break

    # Walk ARIA landmark sections for company clues
    for node in soup.find_all(role=True):
        if not isinstance(node, Tag):
            continue
        if node.get("role") not in _ARIA_SECTION_ROLES:
            continue
        for child in node.descendants:
            if isinstance(child, NavigableString):
                continue
            if not isinstance(child, Tag):
                continue
            text = child.get_text(separator=" ", strip=True)
            if text and _COMPANY_HINTS.search(text) and not company_name:
                company_name = text
                break

    if not job_title and not company_name:
        return None

    posting = RawJobPosting(job_title=job_title, company_name=company_name)
    return None if posting.is_empty() else posting


# ---------------------------------------------------------------------------
# Public strategy class
# ---------------------------------------------------------------------------

class HeuristicExtractor:
    strategy_name: ExtractionStrategy = ExtractionStrategy.HEURISTIC

    # Sub-extractors run in priority order; first non-empty result wins per field
    _SUB_EXTRACTORS = [
        _extract_json_ld,
        _extract_microdata,
        _extract_meta,
        _extract_aria,
    ]

    def extract(self, html: str, config: ParserConfig) -> RawJobPosting | None:  # noqa: ARG002
        soup = BeautifulSoup(html, "lxml")

        merged = RawJobPosting()
        for extractor in self._SUB_EXTRACTORS:
            result = extractor(soup)
            if result is None:
                continue
            # Merge: only fill fields that are still empty
            if not merged.job_title and result.job_title:
                merged.job_title = result.job_title
            if not merged.company_name and result.company_name:
                merged.company_name = result.company_name
            if not merged.location_raw and result.location_raw:
                merged.location_raw = result.location_raw
            if not merged.skills_raw and result.skills_raw:
                merged.skills_raw = result.skills_raw
            if not merged.posted_date_raw and result.posted_date_raw:
                merged.posted_date_raw = result.posted_date_raw

            if not merged.is_empty():
                # Keep running to fill remaining empty fields unless all are full
                if all([
                    merged.job_title,
                    merged.company_name,
                    merged.location_raw,
                ]):
                    break

        return None if merged.is_empty() else merged


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _str_or_none(val: Any) -> str | None:
    if val is None:
        return None
    s = str(val).strip()
    return s if s else None


def _deep_get(d: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if not isinstance(d, dict):
            return None
        d = d.get(key)  # type: ignore[assignment]
    return d
