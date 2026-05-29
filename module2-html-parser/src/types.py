"""
All type contracts for the Layout-Agnostic HTML Parser.
No logic. No defaults beyond Pydantic field constraints.
"""

from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class ExtractionStrategy(str, Enum):
    CSS_SELECTORS = "css_selectors"
    HEURISTIC = "heuristic"
    LLM = "llm"


class SeniorityLevel(str, Enum):
    INTERN = "intern"
    JUNIOR = "junior"
    MID = "mid"
    SENIOR = "senior"
    STAFF = "staff"
    PRINCIPAL = "principal"
    LEAD = "lead"
    MANAGER = "manager"
    DIRECTOR = "director"
    VP = "vp"
    C_SUITE = "c_suite"
    UNKNOWN = "unknown"


class JobFunction(str, Enum):
    """Standardised job function taxonomy. Raw titles map to one of these."""

    SOFTWARE_ENGINEERING = "software_engineering"
    DATA_ENGINEERING = "data_engineering"
    DATA_SCIENCE = "data_science"
    MACHINE_LEARNING = "machine_learning"
    PRODUCT_MANAGEMENT = "product_management"
    DESIGN = "design"
    DEVOPS = "devops"
    SECURITY = "security"
    QA = "qa"
    SALES = "sales"
    SALES_LEADERSHIP = "sales_leadership"
    MARKETING = "marketing"
    FINANCE = "finance"
    LEGAL = "legal"
    HR = "hr"
    OPERATIONS = "operations"
    CUSTOMER_SUCCESS = "customer_success"
    RESEARCH = "research"
    GENERAL_MANAGEMENT = "general_management"
    UNKNOWN = "unknown"


class ParseErrorCode(str, Enum):
    HTML_TOO_SHORT = "HTML_TOO_SHORT"
    ALL_STRATEGIES_FAILED = "ALL_STRATEGIES_FAILED"
    LLM_PARSE_ERROR = "LLM_PARSE_ERROR"
    LLM_API_ERROR = "LLM_API_ERROR"
    NORMALISATION_ERROR = "NORMALISATION_ERROR"
    INVALID_HTML = "INVALID_HTML"


class LogLevel(str, Enum):
    DEBUG = "debug"
    INFO = "info"
    WARN = "warn"
    ERROR = "error"


# ---------------------------------------------------------------------------
# Configuration (injected at construction — never hardcoded)
# ---------------------------------------------------------------------------


class CssSelectorSet(BaseModel):
    """A named group of CSS selectors for one target page layout."""

    name: str
    job_title: list[str] = Field(min_length=1)
    company_name: list[str] = Field(min_length=1)
    location: list[str] = Field(min_length=1)
    skills: list[str] = Field(default_factory=list)
    seniority_level: list[str] = Field(default_factory=list)
    posted_date: list[str] = Field(default_factory=list)


class LLMConfig(BaseModel):
    model: str
    max_tokens: int = Field(gt=0)
    temperature: float = Field(ge=0.0, le=1.0)
    timeout_seconds: float = Field(gt=0)
    """Maximum stripped-HTML length (chars) sent to the LLM to control cost."""
    max_html_chars: int = Field(gt=0)


class ParserConfig(BaseModel):
    selector_sets: list[CssSelectorSet] = Field(default_factory=list)
    llm: LLMConfig
    """Minimum non-whitespace character count to consider an HTML document valid."""
    min_html_length: int = Field(gt=0)
    """Ordered list of strategies to attempt; stops at the first success."""
    strategy_order: list[ExtractionStrategy] = Field(min_length=1)


# ---------------------------------------------------------------------------
# Core domain models
# ---------------------------------------------------------------------------


class Location(BaseModel):
    city: str | None = None
    country: str | None = None


class RawJobPosting(BaseModel):
    """Intermediate, un-normalised data returned by each extraction strategy."""

    job_title: str | None = None
    company_name: str | None = None
    location_raw: str | None = None
    skills_raw: list[str] = Field(default_factory=list)
    seniority_raw: str | None = None
    posted_date_raw: str | None = None

    def is_empty(self) -> bool:
        return not any(
            [
                self.job_title,
                self.company_name,
                self.location_raw,
                self.skills_raw,
            ]
        )


class NormalisedJobPosting(BaseModel):
    """
    Fully normalised output. All dates are ISO 8601. Titles are mapped to
    the JobFunction taxonomy. Whitespace is stripped.
    """

    job_title: str
    job_function: JobFunction
    company_name: str
    location: Location
    skills: list[str] = Field(default_factory=list)
    seniority_level: SeniorityLevel
    posted_date: date | None = None

    @field_validator("job_title", "company_name", mode="before")
    @classmethod
    def strip_whitespace(cls, v: Any) -> Any:
        if isinstance(v, str):
            return " ".join(v.split())
        return v

    @field_validator("skills", mode="before")
    @classmethod
    def strip_skills(cls, v: Any) -> Any:
        if isinstance(v, list):
            return [" ".join(s.split()) for s in v if isinstance(s, str) and s.strip()]
        return v


# ---------------------------------------------------------------------------
# LLM structured output model (used as the response_model for the Anthropic call)
# ---------------------------------------------------------------------------


class LLMExtractionResult(BaseModel):
    """
    Pydantic model that defines the structured output contract for the
    claude-haiku-4-5 extraction call. Field names match the prompt schema
    exactly so the JSON response can be model_validate()'d directly.
    """

    job_title: str = Field(description="Exact job title as listed in the posting")
    company_name: str = Field(description="Name of the hiring company")
    location: Location = Field(
        description="Parsed city and country; use null for unknown fields"
    )
    skills: list[str] = Field(
        description="Technical and soft skills mentioned in the posting",
        default_factory=list,
    )
    seniority_level: SeniorityLevel = Field(
        description="Inferred seniority level; use 'unknown' if not determinable"
    )


# ---------------------------------------------------------------------------
# Request / Response shapes
# ---------------------------------------------------------------------------


class ParseRequest(BaseModel):
    task_id: str
    url: str
    html: str
    """Optional hint — if known, skip to a specific strategy."""
    force_strategy: ExtractionStrategy | None = None


class ParseResult(BaseModel):
    task_id: str
    url: str
    strategy_used: ExtractionStrategy
    posting: NormalisedJobPosting
    extracted_at: str  # ISO 8601 datetime string


class ParseError(BaseModel):
    task_id: str
    url: str
    error_code: ParseErrorCode
    message: str
    strategies_attempted: list[ExtractionStrategy] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Structured log entry
# ---------------------------------------------------------------------------


class StructuredLogEntry(BaseModel):
    timestamp: str
    level: LogLevel
    module: str = "html-parser"
    task_id: str | None = None
    event: str
    strategy: ExtractionStrategy | None = None
    duration_ms: float | None = None
    error_code: ParseErrorCode | None = None
    message: str | None = None

    model_config = {"extra": "allow"}


# ---------------------------------------------------------------------------
# Protocols (structural interfaces for dependency injection / testing)
# ---------------------------------------------------------------------------


@runtime_checkable
class IExtractionStrategy(Protocol):
    """
    Every extraction strategy must satisfy this protocol.
    Implementations must not raise — they return None on failure.
    """

    @property
    def strategy_name(self) -> ExtractionStrategy: ...

    def extract(self, html: str, config: ParserConfig) -> RawJobPosting | None: ...


@runtime_checkable
class INormaliser(Protocol):
    """
    Converts a RawJobPosting into a NormalisedJobPosting.
    Raises ValueError with a descriptive message if normalisation is impossible.
    """

    def normalise(self, raw: RawJobPosting) -> NormalisedJobPosting: ...


@runtime_checkable
class IParser(Protocol):
    """Top-level parser pipeline — accepts an HTML document, returns a result."""

    def parse(self, request: ParseRequest) -> ParseResult: ...
