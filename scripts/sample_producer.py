"""
Sample producer — sends test scrape requests to Kafka so you can watch
the full pipeline (Module 1 → 2 → 3 → 4) run end-to-end.

Set SCRAPER_MOCK_MODE=true on the scraper-worker service to use canned HTML
instead of real browser scrapes (faster, no anti-scraping risk).
"""
import json
import os
import time
import uuid
from datetime import datetime, timezone

from kafka import KafkaProducer
from kafka.errors import NoBrokersAvailable

BROKERS = os.environ.get("KAFKA_BROKERS", "localhost:9092").split(",")
INPUT_TOPIC = os.environ.get("KAFKA_TOPIC_INPUT", "scrape-requests")

# Four sample jobs: jobs[0] and jobs[1] are near-duplicates (same role, Acme Corp)
SAMPLE_JOBS = [
    {
        "url": "mock://acme-swe-1",
        "label": "Senior SWE @ Acme Corp (first posting)",
    },
    {
        "url": "mock://acme-swe-2",
        "label": "Senior SWE @ Acme Corp (duplicate posting)",
    },
    {
        "url": "mock://globex-ds-1",
        "label": "Data Scientist @ Globex Ltd",
    },
    {
        "url": "mock://initech-pm-1",
        "label": "Product Manager @ Initech",
    },
]


def wait_for_kafka(brokers: list[str], retries: int = 30, delay: float = 2.0) -> KafkaProducer:
    for attempt in range(1, retries + 1):
        try:
            producer = KafkaProducer(
                bootstrap_servers=brokers,
                value_serializer=lambda v: json.dumps(v).encode("utf-8"),
                key_serializer=lambda k: k.encode("utf-8") if k else None,
            )
            print(f"[producer] Connected to Kafka on attempt {attempt}")
            return producer
        except NoBrokersAvailable:
            print(f"[producer] Kafka not ready (attempt {attempt}/{retries}), retrying in {delay}s …")
            time.sleep(delay)
    raise RuntimeError("Could not connect to Kafka after multiple retries")


def main() -> None:
    producer = wait_for_kafka(BROKERS)

    print(f"[producer] Sending {len(SAMPLE_JOBS)} scrape requests to topic '{INPUT_TOPIC}'")

    for job in SAMPLE_JOBS:
        task_id = str(uuid.uuid4())
        message = {
            "taskId": task_id,
            "url": job["url"],
            "priority": "normal",
            "attempt": 1,
            "enqueuedAt": datetime.now(timezone.utc).isoformat(),
        }
        producer.send(INPUT_TOPIC, key=task_id, value=message)
        print(f"[producer] Sent task {task_id[:8]}…  {job['label']}")
        time.sleep(0.5)

    producer.flush()
    producer.close()
    print("[producer] All messages sent. Watch the scraper-worker and dedup-worker logs.")


if __name__ == "__main__":
    main()
