import re
import unicodedata

from .types import JobPostingRecord, ProcessedRecord

# Legal entity suffixes stripped from company names to improve matching
_LEGAL_SUFFIXES = re.compile(
    r"\b(inc|llc|ltd|corp|gmbh|sa|plc|limited|group|co|company|"
    r"technologies|solutions|services|systems|partners|associates|"
    r"international|global|holdings|ventures|labs|studio|studios)\b\.?",
    re.IGNORECASE,
)

# Title words that add no discriminative signal
_TITLE_STOP_WORDS = frozenset({
    "a", "an", "the", "and", "or", "of", "in", "at", "for",
    "to", "with", "on", "is", "are", "be", "as", "by", "we",
    "our", "your", "this", "that", "you", "us",
})

_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)


def _to_ascii(text: str) -> str:
    """Fold unicode characters to ASCII equivalents where possible."""
    return (
        unicodedata.normalize("NFKD", text)
        .encode("ascii", "ignore")
        .decode("ascii")
    )


def _normalise(text: str) -> str:
    return " ".join(_NON_WORD.sub(" ", _to_ascii(text).lower()).split())


def _title_tokens(title: str) -> str:
    tokens = _normalise(title).split()
    return " ".join(t for t in tokens if t not in _TITLE_STOP_WORDS)


def _company_name(name: str) -> str:
    norm = _normalise(name)
    norm = _LEGAL_SUFFIXES.sub(" ", norm)
    return " ".join(norm.split())


def _location(city: str | None, country: str | None) -> str:
    parts = [
        _normalise(p)
        for p in (city or "", country or "")
        if p and p.strip()
    ]
    return ", ".join(parts)


def _skills(skills: list[str]) -> str:
    normalised = sorted({_normalise(s) for s in skills if s.strip()})
    return " ".join(normalised)


class Preprocessor:
    """
    Implements IPreprocessor. Skips individual records that raise rather than
    aborting the whole batch — the caller sees a shorter output list.
    """

    def preprocess(self, records: list[JobPostingRecord]) -> list[ProcessedRecord]:
        result: list[ProcessedRecord] = []
        for r in records:
            try:
                result.append(
                    ProcessedRecord(
                        record_id=r.record_id,
                        job_title_tokens=_title_tokens(r.job_title),
                        company_name_normalized=_company_name(r.company_name),
                        location_normalized=_location(r.location_city, r.location_country),
                        skills_normalized=_skills(r.skills),
                        job_function=r.job_function.lower(),
                        seniority_level=r.seniority_level.lower(),
                    )
                )
            except Exception:
                continue
        return result
