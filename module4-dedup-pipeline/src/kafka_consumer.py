"""
Kafka consumer that batches ParseResultMessages from Module 3
and runs them through the DedupPipeline.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone

from kafka import KafkaConsumer  # type: ignore[import-untyped]
from kafka.errors import KafkaError  # type: ignore[import-untyped]

from .logger import Logger
from .pipeline import DedupPipeline
from .sink import ISink, create_sink
from .types import (
    DeduplicationError,
    DeduplicationRequest,
    DeduplicationResult,
    JobPostingRecord,
    PipelineConfig,
)


def _parse_record(data: dict) -> JobPostingRecord:
    return JobPostingRecord(
        record_id=data["taskId"],
        job_title=data["jobTitle"],
        job_function=data["jobFunction"],
        company_name=data["companyName"],
        location_city=data.get("locationCity"),
        location_country=data.get("locationCountry"),
        skills=data.get("skills", []),
        seniority_level=data["seniorityLevel"],
        source_url=data.get("resolvedUrl", data.get("url", "")),
        ingested_at=datetime.now(timezone.utc),
    )


def run(config: PipelineConfig) -> None:
    logger = Logger()
    pipeline = DedupPipeline.create(config)
    sink = create_sink(logger)

    brokers = os.environ["DEDUP_KAFKA_BROKERS"].split(",")
    group_id = os.environ["DEDUP_KAFKA_GROUP_ID"]
    input_topic = os.environ["DEDUP_KAFKA_INPUT_TOPIC"]
    flush_interval = int(os.environ.get("DEDUP_FLUSH_INTERVAL_S", "30"))
    batch_flush_size = int(os.environ.get("DEDUP_BATCH_FLUSH_SIZE", "20"))

    logger.info("dedup.consumer.connecting", record_count=0)

    consumer = KafkaConsumer(
        input_topic,
        bootstrap_servers=brokers,
        group_id=group_id,
        value_deserializer=lambda v: json.loads(v.decode("utf-8")),
        auto_offset_reset="earliest",
        enable_auto_commit=True,
        consumer_timeout_ms=5000,
    )

    logger.info("dedup.consumer.started", record_count=0)

    batch: list[JobPostingRecord] = []
    last_flush = time.monotonic()
    batch_num = 0

    while True:
        try:
            for message in consumer:
                try:
                    record = _parse_record(message.value)
                    batch.append(record)
                    logger.debug("dedup.record.received", record_count=len(batch))
                except Exception as exc:
                    logger.warn("dedup.record.parse_error", message=str(exc))

                elapsed = time.monotonic() - last_flush
                if len(batch) >= batch_flush_size or elapsed >= flush_interval:
                    _flush(batch, batch_num, pipeline, sink, logger, config)
                    batch_num += 1
                    batch = []
                    last_flush = time.monotonic()

        except StopIteration:
            # consumer_timeout_ms elapsed with no messages
            if batch:
                _flush(batch, batch_num, pipeline, sink, logger, config)
                batch_num += 1
                batch = []
                last_flush = time.monotonic()

        except KafkaError as exc:
            logger.error("dedup.consumer.kafka_error", message=str(exc))
            time.sleep(5)


def _flush(
    batch: list[JobPostingRecord],
    batch_num: int,
    pipeline: DedupPipeline,
    sink: ISink,
    logger: Logger,
    config: PipelineConfig,
) -> None:
    if not batch:
        return

    batch_id = f"batch-{batch_num:04d}"
    logger.info("dedup.batch.flushing", record_count=len(batch))

    request = DeduplicationRequest(batch_id=batch_id, records=batch)
    result = pipeline.deduplicate(request)

    if isinstance(result, DeduplicationResult):
        logger.info(
            "dedup.batch.completed",
            record_count=len(batch),
            unique=result.stats.unique_record_count,
            clusters=result.stats.cluster_count,
            duration_ms=result.stats.processing_time_ms,
        )
        if result.duplicate_clusters:
            for cluster in result.duplicate_clusters:
                logger.info(
                    "dedup.cluster.found",
                    record_count=len(cluster.member_ids),
                    message=f"canonical={cluster.canonical_id} members={cluster.member_ids}",
                )

        # Persist the deduplicated postings downstream (Postgres, or log-only fallback).
        records_by_id = {rec.record_id: rec for rec in batch}
        sink.write(result, records_by_id)
    else:
        logger.error(
            "dedup.batch.failed",
            error_code=result.error_code,
            message=result.message,
        )
