"""Shared fixtures for all Module 4 tests."""
from datetime import datetime, timezone

import pytest

from src.types import (
    BlockingConfig,
    BlockingStrategy,
    ClassifierConfig,
    ClassifierType,
    ComparableField,
    ComparisonFieldConfig,
    PipelineConfig,
    SimilarityMetric,
)
from helpers import make_record, make_processed

__all__ = ["make_record", "make_processed"]


@pytest.fixture
def now() -> datetime:
    return datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def base_cfg() -> PipelineConfig:
    return PipelineConfig(
        blocking=BlockingConfig(
            strategies=[BlockingStrategy.COMPANY_TITLE],
            max_pairs=5000,
        ),
        comparison_fields=[
            ComparisonFieldConfig(
                field=ComparableField.JOB_TITLE,
                metric=SimilarityMetric.JARO_WINKLER,
                weight=0.5,
                field_match_threshold=0.85,
            ),
            ComparisonFieldConfig(
                field=ComparableField.COMPANY_NAME,
                metric=SimilarityMetric.JARO_WINKLER,
                weight=0.5,
                field_match_threshold=0.90,
            ),
        ],
        classifier=ClassifierConfig(
            type=ClassifierType.THRESHOLD,
            match_threshold=0.8,
            unmatch_threshold=0.3,
        ),
        batch_size=100,
    )
