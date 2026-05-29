"""
All type contracts for the Deduplication Pipeline.
No logic. No defaults beyond Pydantic field constraints.
"""

from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class DedupStatus(str, Enum):
    UNIQUE = "unique"
    DUPLICATE = "duplicate"
    UNCERTAIN = "uncertain"


class BlockingStrategy(str, Enum):
    """
    Controls how candidate pairs are generated.
    Multiple strategies may be combined — pairs from all are unioned.
    """
    COMPANY_TITLE = "company_title"     # block on (company token, title token)
    COMPANY_LOCATION = "company_location"  # block on (company token, location)
    TITLE_FUNCTION = "title_function"   # block on (job_function, title token)


class SimilarityMetric(str, Enum):
    EXACT = "exact"
    JARO_WINKLER = "jaro_winkler"
    COSINE = "cosine"
    LEVENSHTEIN = "levenshtein"


class ComparableField(str, Enum):
    """Fields on ProcessedRecord that the comparator may score."""
    JOB_TITLE = "job_title_tokens"
    COMPANY_NAME = "company_name_normalized"
    LOCATION = "location_normalized"
    SKILLS = "skills_normalized"
    JOB_FUNCTION = "job_function"
    SENIORITY = "seniority_level"


class ClassifierType(str, Enum):
    THRESHOLD = "threshold"
    ECM = "ecm"   # Expectation-Conditional-Maximization (unsupervised)


class PipelineErrorCode(str, Enum):
    INVALID_INPUT = "INVALID_INPUT"
    PREPROCESSING_FAILED = "PREPROCESSING_FAILED"
    BLOCKING_FAILED = "BLOCKING_FAILED"
    COMPARISON_FAILED = "COMPARISON_FAILED"
    CLASSIFICATION_FAILED = "CLASSIFICATION_FAILED"
    OUTPUT_FAILED = "OUTPUT_FAILED"


class LogLevel(str, Enum):
    DEBUG = "debug"
    INFO = "info"
    WARN = "warn"
    ERROR = "error"


# ---------------------------------------------------------------------------
# Configuration (all values injected — never hardcoded)
# ---------------------------------------------------------------------------


class BlockingConfig(BaseModel):
    """Controls the pair-generation phase."""
    strategies: list[BlockingStrategy] = Field(min_length=1)
    """Maximum number of candidate pairs; raises if exceeded to prevent OOM."""
    max_pairs: int = Field(gt=0)


class ComparisonFieldConfig(BaseModel):
    """Defines how one field is scored during comparison."""
    field: ComparableField
    metric: SimilarityMetric
    """Importance weight used when computing the composite similarity score."""
    weight: float = Field(gt=0.0, le=1.0)
    """
    Per-field minimum score to count as a field-level match.
    Used by the threshold classifier to build a match vector.
    """
    field_match_threshold: float = Field(ge=0.0, le=1.0)

    @field_validator("weight", "field_match_threshold", mode="before")
    @classmethod
    def _round_float(cls, v: Any) -> Any:
        return round(float(v), 6) if isinstance(v, (int, float)) else v


class ClassifierConfig(BaseModel):
    """Controls the duplicate/unique classification decision."""
    type: ClassifierType
    """
    Composite score above which a pair is classified DUPLICATE.
    Must be strictly greater than unmatch_threshold.
    """
    match_threshold: float = Field(ge=0.0, le=1.0)
    """Composite score below which a pair is classified UNIQUE."""
    unmatch_threshold: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _thresholds_ordered(self) -> "ClassifierConfig":
        if self.unmatch_threshold >= self.match_threshold:
            raise ValueError(
                f"unmatch_threshold ({self.unmatch_threshold}) must be "
                f"strictly less than match_threshold ({self.match_threshold})"
            )
        return self


class PipelineConfig(BaseModel):
    blocking: BlockingConfig
    comparison_fields: list[ComparisonFieldConfig] = Field(min_length=1)
    classifier: ClassifierConfig
    """Number of records processed per batch (memory control)."""
    batch_size: int = Field(gt=0)

    @model_validator(mode="after")
    def _weights_normalised(self) -> "PipelineConfig":
        total = sum(f.weight for f in self.comparison_fields)
        if abs(total - 1.0) > 1e-4:
            raise ValueError(
                f"comparison_fields weights must sum to 1.0, got {total:.6f}"
            )
        return self


# ---------------------------------------------------------------------------
# Core domain models
# ---------------------------------------------------------------------------


class JobPostingRecord(BaseModel):
    """
    Canonical input to the pipeline.
    Mirrors Module 3's ParseResultMessage but is owned by this module.
    """
    record_id: str
    job_title: str
    job_function: str
    company_name: str
    location_city: str | None = None
    location_country: str | None = None
    skills: list[str] = Field(default_factory=list)
    seniority_level: str
    source_url: str
    posted_date: date | None = None
    ingested_at: datetime

    @field_validator("job_title", "company_name", "seniority_level", mode="before")
    @classmethod
    def _strip(cls, v: Any) -> Any:
        return " ".join(str(v).split()) if isinstance(v, str) else v


class ProcessedRecord(BaseModel):
    """
    Normalised form used by blocking and comparison.
    All text fields are lowercase and whitespace-collapsed.
    """
    record_id: str
    job_title_tokens: str        # space-joined normalised tokens
    company_name_normalized: str
    location_normalized: str     # "city, country" or "" if both absent
    skills_normalized: str       # space-joined sorted skill tokens
    job_function: str
    seniority_level: str


class CandidatePair(BaseModel):
    """An (left_id, right_id) pair produced by the blocker."""
    left_id: str
    right_id: str
    blocking_key: str   # which key caused this pair to be generated


class FieldScore(BaseModel):
    """Similarity score for one field in a comparison."""
    field: ComparableField
    score: float = Field(ge=0.0, le=1.0)
    metric: SimilarityMetric


class ComparisonVector(BaseModel):
    """All field scores for one candidate pair."""
    left_id: str
    right_id: str
    field_scores: list[FieldScore]
    """Weighted average of field scores using ComparisonFieldConfig.weight."""
    composite_score: float = Field(ge=0.0, le=1.0)


class DedupDecision(BaseModel):
    """Final classification decision for one candidate pair."""
    left_id: str
    right_id: str
    status: DedupStatus
    composite_score: float = Field(ge=0.0, le=1.0)
    """Confidence in the decision (1.0 = classifier is certain)."""
    confidence: float = Field(ge=0.0, le=1.0)


class DuplicateCluster(BaseModel):
    """
    A group of record IDs that all refer to the same real-world job posting.
    canonical_id is the record that survives deduplication.
    """
    canonical_id: str
    member_ids: list[str] = Field(min_length=2)


# ---------------------------------------------------------------------------
# Pipeline request / response
# ---------------------------------------------------------------------------


class PipelineStats(BaseModel):
    input_record_count: int
    candidate_pair_count: int
    comparison_count: int
    duplicate_pair_count: int
    unique_record_count: int
    cluster_count: int
    processing_time_ms: float


class DeduplicationRequest(BaseModel):
    batch_id: str
    records: list[JobPostingRecord] = Field(min_length=1)
    """Override pipeline config for this batch; uses module default if absent."""
    config: PipelineConfig | None = None


class DeduplicationResult(BaseModel):
    batch_id: str
    """IDs of records with no detected duplicate."""
    unique_record_ids: list[str]
    """Groups of records that are duplicates of each other."""
    duplicate_clusters: list[DuplicateCluster]
    """Full decision log for every candidate pair evaluated."""
    decisions: list[DedupDecision]
    stats: PipelineStats


class DeduplicationError(BaseModel):
    batch_id: str
    error_code: PipelineErrorCode
    message: str


# ---------------------------------------------------------------------------
# Structured log entry
# ---------------------------------------------------------------------------


class StructuredLogEntry(BaseModel):
    timestamp: str
    level: LogLevel
    module: str = "dedup-pipeline"
    batch_id: str | None = None
    event: str
    duration_ms: float | None = None
    error_code: PipelineErrorCode | None = None
    message: str | None = None

    model_config = {"extra": "allow"}


# ---------------------------------------------------------------------------
# Protocols (structural interfaces for dependency injection / testing)
# ---------------------------------------------------------------------------


@runtime_checkable
class IPreprocessor(Protocol):
    """
    Normalises raw JobPostingRecords into ProcessedRecords.
    Never raises — returns an empty list on total failure.
    """
    def preprocess(
        self, records: list[JobPostingRecord]
    ) -> list[ProcessedRecord]: ...


@runtime_checkable
class IBlocker(Protocol):
    """
    Generates candidate pairs from ProcessedRecords.
    Returns an empty list if no pairs qualify.
    Raises ValueError if max_pairs would be exceeded.
    """
    def generate_pairs(
        self,
        records: list[ProcessedRecord],
        config: BlockingConfig,
    ) -> list[CandidatePair]: ...


@runtime_checkable
class IComparator(Protocol):
    """
    Computes a ComparisonVector for each CandidatePair.
    Never raises — skips a pair and logs on field-level error.
    """
    def compare(
        self,
        records: list[ProcessedRecord],
        pairs: list[CandidatePair],
        fields: list[ComparisonFieldConfig],
    ) -> list[ComparisonVector]: ...


@runtime_checkable
class IClassifier(Protocol):
    """
    Converts ComparisonVectors into DedupDecisions.
    Never raises — assigns UNCERTAIN on internal error.
    """
    def classify(
        self,
        vectors: list[ComparisonVector],
        config: ClassifierConfig,
    ) -> list[DedupDecision]: ...


@runtime_checkable
class IPipeline(Protocol):
    """
    Full deduplication pipeline. Never raises — returns DeduplicationError
    on any unrecoverable failure.
    """
    def deduplicate(
        self, request: DeduplicationRequest
    ) -> DeduplicationResult | DeduplicationError: ...
