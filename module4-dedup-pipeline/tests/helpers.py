from datetime import datetime, timezone

from src.types import JobPostingRecord, ProcessedRecord


def make_record(
    record_id: str,
    job_title: str = "Software Engineer",
    company_name: str = "Acme Corp",
    job_function: str = "software_engineering",
    seniority_level: str = "senior",
    location_city: str | None = "London",
    location_country: str | None = "UK",
    skills: list[str] | None = None,
    now: datetime | None = None,
) -> JobPostingRecord:
    return JobPostingRecord(
        record_id=record_id,
        job_title=job_title,
        job_function=job_function,
        company_name=company_name,
        location_city=location_city,
        location_country=location_country,
        skills=skills or ["Python", "SQL"],
        seniority_level=seniority_level,
        source_url=f"https://example.com/{record_id}",
        ingested_at=now or datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc),
    )


def make_processed(
    record_id: str,
    job_title_tokens: str = "senior software engineer",
    company_name_normalized: str = "acme",
    location_normalized: str = "london, uk",
    skills_normalized: str = "python sql",
    job_function: str = "software_engineering",
    seniority_level: str = "senior",
) -> ProcessedRecord:
    return ProcessedRecord(
        record_id=record_id,
        job_title_tokens=job_title_tokens,
        company_name_normalized=company_name_normalized,
        location_normalized=location_normalized,
        skills_normalized=skills_normalized,
        job_function=job_function,
        seniority_level=seniority_level,
    )
