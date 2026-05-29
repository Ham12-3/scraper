# Architecture

This document describes the internal design of each module, the message schemas
that flow between them, the deduplication algorithm, the persistence schema, and
how failures are handled. For a high-level overview, quickstart, and environment
reference, see the top-level [`README.md`](../README.md).

---

## System overview

The system is a four-stage pipeline glued together by Kafka topics and one
HTTP service:

```
ScrapeRequest ──> [scrape-requests] ──> scraper-worker ──HTTP──> parser
                                              │  (Module 1 + 3)     (Module 2)
                                              ▼
                                       ParseResult
                                              ▼
                                       [parse-results] ──> dedup-worker ──> PostgreSQL
                                              │              (Module 4)      job_postings
                                  (on repeated failure)
                                              ▼
                                        [scrape-dlq]
```

Each module is independently buildable and tested, exposes a small public API via
`src/index.ts` (TypeScript) or `src/__init__.py` (Python), and is composed at the
edges by container entry points (`module3-kafka-worker/src/main.ts`,
`module2-html-parser/src/server.py`, `module4-dedup-pipeline/src/kafka_consumer.py`).

---

## Module 1 — Headless Browser Controller

`module1-browser-controller/` · TypeScript + Playwright · published as
`@scraper/browser-controller`.

Public surface (`src/index.ts`): `BrowserCluster`, `loadConfig`, `Logger`,
`HumanMimicry`, `ResourceFilter`, `StealthInjector`, `Semaphore`, plus all types.

Internal components:

- **`BrowserCluster` (`browserCluster.ts`)** — implements `IBrowserCluster`. Launches
  one Chromium browser and serves each scrape from its **own ephemeral browser
  context** (isolated cookies/storage). Concurrency is bounded by a counting
  `Semaphore`. `init()` launches the browser, `scrape()` runs a request,
  `shutdown()` tears it down.
- **`StealthInjector` (`stealth.ts`)** — applies anti-fingerprinting: canvas-noise
  injection, WebGL vendor/renderer spoofing, and a `navigator.webdriver`
  override, driven by the `STEALTH_*` config.
- **`HumanMimicry` (`humanMimicry.ts`)** — humanises interaction: Bézier-curve
  mouse paths, sinusoidal scrolling, and randomised keystroke timing, all
  parameterised by the `MIMICRY_*` config (waypoint counts, step delays, ranges).
- **`ResourceFilter` (`resourceFilter.ts`)** — Playwright route interception that
  blocks requests by resource type (`RESOURCE_BLOCKED_TYPES`, e.g.
  `image,media,font,stylesheet`) and glob/regex patterns to cut bandwidth and
  speed up loads.
- **`Semaphore` (`semaphore.ts`)** — a promise-queue counting semaphore used to cap
  concurrent contexts.
- **`configLoader.ts`** — env-var loader with fail-fast validation.

In the running stack this module is **only active when `SCRAPER_MOCK_MODE=false`**.
The scraper-worker entry point (`main.ts`) builds a `BrowserCluster` and wraps it
in a `BrowserAdapter`; otherwise it substitutes a `MockScraperAdapter` that
returns canned JSON-LD job HTML.

---

## Module 2 — HTML Parser

`module2-html-parser/` · Python 3.11 + BeautifulSoup + Pydantic + Anthropic.

Public surface (`src/__init__.py`): `HtmlParser`, `Normaliser`, `load_config`,
and the domain types (`ParseRequest`, `ParseResult`, `ParseError`, `Location`,
`NormalisedJobPosting`, the `ExtractionStrategy` / `JobFunction` /
`SeniorityLevel` enums, etc.).

### Extraction cascade

`HtmlParser.parse()` (`parser.py`) runs registered strategies **in
`config.strategy_order` order** and returns the first non-empty result, then
normalises it. The cascade short-circuits on the first hit; a `force_strategy`
on the request overrides the configured order. The three strategies (all
implementing `IExtractionStrategy`) are:

1. **`CssExtractor` (`css_extractor.py`)** — `ExtractionStrategy.CSS_SELECTORS`.
   Applies configured `CssSelectorSet`s; precise but layout-specific.
2. **`HeuristicExtractor` (`heuristic_extractor.py`)** — `ExtractionStrategy.HEURISTIC`.
   Layout-agnostic: parses JSON-LD, Microdata, Open Graph, and ARIA, then merges
   the signals.
3. **`LLMExtractor` (`llm_extractor.py`)** — `ExtractionStrategy.LLM`. Final
   fallback: sends (truncated to `LLM_MAX_HTML_CHARS`) HTML to a Claude model
   (`LLM_MODEL`, default `claude-haiku-4-5-20251001`) and parses the structured
   response. Requires `ANTHROPIC_API_KEY`.

The default Compose order is `heuristic,llm` (CSS is skipped because
`PARSER_SELECTOR_SETS` is empty). Each strategy returns a `RawJobPosting`, which
the **`Normaliser`** maps to a typed `NormalisedJobPosting` — parsing
locations, mapping seniority and job function, and normalising dates.

### HTTP service

`src/server.py` wraps `HtmlParser` in Flask:

- `POST /parse` — accepts `{task_id, url, html}`, returns the **Module 3-compatible
  ParseResult JSON** (camelCase) on success, or `{"error", "message"}` with HTTP
  422 on a `ParseError`.
- `GET /health` — `{"status": "ok"}` (used by the container healthcheck).

The parser **never raises** out of `parse()`; every failure path returns a
`ParseError` (`HTML_TOO_SHORT`, `ALL_STRATEGIES_FAILED`, `NORMALISATION_ERROR`).

---

## Module 3 — Kafka Worker

`module3-kafka-worker/` · TypeScript + kafkajs + prom-client · published as
`@scraper/kafka-worker`.

Public surface (`src/index.ts`): `KafkaWorker`, `KafkaConsumer`, `KafkaProducer`,
`WorkerMetrics`, `startMetricsServer`, `loadConfig`, `Logger`, and the port/message
types.

The entry point (`main.ts`) wires everything together: load config → build the
scraper adapter (`BrowserAdapter` over a real `BrowserCluster`, or
`MockScraperAdapter`) → `HttpParserAdapter` pointed at `PARSER_SERVICE_URL` →
`KafkaConsumer` + `KafkaProducer` + `WorkerMetrics` → start the Prometheus
metrics server → run `KafkaWorker`, with `SIGTERM`/`SIGINT` handlers for graceful
shutdown.

### Message lifecycle

`KafkaWorker.processMessage()` (`worker.ts`) handles each consumed message:

1. **Deserialise** the value into a `ScrapeRequestMessage`. A JSON failure
   increments the `SerializationError` counter and routes the raw payload
   straight to the DLQ.
2. **Scrape** via `IScraperPort.scrape()` (errors tagged `ScrapeFailed`).
3. **Parse** via `IParserPort.parse()` → the Module 2 HTTP service (errors tagged
   `ParseFailed`).
4. **Produce** the enriched `ParseResultMessage` (with `totalDurationMs`) to the
   output topic (`parse-results`); produce errors tagged `KafkaProduceError`.

`eachMessage` is awaited serially per partition, giving **at-least-once
delivery**. Metrics (consumed/produced/errors/duration/active-workers) are
recorded throughout.

### Metrics

`WorkerMetrics` (`metrics.ts`) registers prom-client series —
`kafka_worker_messages_consumed_total`, `..._produced_total`,
`..._dead_lettered_total`, `..._processing_errors_total{error_code}`,
`kafka_worker_processing_duration_ms` (histogram),
`kafka_worker_active_workers`, `kafka_worker_consumer_lag_total` — plus default
Node metrics, served at `METRICS_PATH` on `METRICS_PORT` (9090) by
`startMetricsServer`.

---

## Module 4 — Deduplication Pipeline

`module4-dedup-pipeline/` · Python + pandas + recordlinkage + scikit-learn.

Public surface (`src/__init__.py`): `DedupPipeline`, the sinks
(`ISink`, `LoggingSink`, `PostgresSink`, `create_sink`), `load_config`, and the
domain types.

The consumer (`kafka_consumer.py`) batches `ParseResultMessage`s from
`parse-results`, mapping each into a `JobPostingRecord`, and **flushes a batch**
when it reaches `DEDUP_BATCH_FLUSH_SIZE` records **or** `DEDUP_FLUSH_INTERVAL_S`
seconds elapse. Each batch becomes a `DeduplicationRequest` fed to the pipeline;
the resulting `DeduplicationResult` is then handed to the sink.

### Pipeline stages

`DedupPipeline.deduplicate()` (`pipeline.py`) — **never raises**; every failure
returns a `DeduplicationError`. Batches of fewer than 2 records short-circuit as
all-unique.

1. **Preprocess (`preprocessor.py`)** — Unicode normalisation, legal-suffix
   stripping, stop-word removal, and skill de-duplication, producing
   `ProcessedRecord`s with normalised fields (`company_name_normalized`,
   `job_title_tokens`, `location_normalized`, `job_function`).
2. **Block (`blocker.py`)** — generates `CandidatePair`s using one or more
   strategies, deduplicating pairs across strategies, and raising if
   `max_pairs` (`DEDUP_BLOCKING_MAX_PAIRS`) is exceeded:
   - `COMPANY_TITLE` (`ct`) — first token of company + first token of title.
   - `COMPANY_LOCATION` (`cl`) — first token of company + location prefix.
   - `TITLE_FUNCTION` (`tf`) — job function + first token of title.
3. **Compare (`comparator.py`)** — uses recordlinkage's `Compare` engine over a
   pandas DataFrame. Per `ComparisonFieldConfig`, it applies a similarity metric
   (`jaro_winkler` / `cosine` / `levenshtein` string similarity, or `exact`),
   clamps NaN/inf scores to 0, and accumulates a **weighted composite score**
   (`Σ score · weight`) into a `ComparisonVector`. Pairs referencing unknown
   record IDs are dropped.
4. **Classify (`classifier.py`)** — turns vectors into `DedupDecision`s:
   - **THRESHOLD** (default): `composite_score ≥ DEDUP_MATCH_THRESHOLD` → `DUPLICATE`;
     `≤ DEDUP_UNMATCH_THRESHOLD` → `UNIQUE`; in between → `UNCERTAIN`. Confidence
     scales with distance from the boundary.
     The Compose default is `match=0.75`, `unmatch=0.3`.
   - **ECM**: fits an unsupervised `ECMClassifier` (Expectation-Conditional-
     Maximization, `binarize=0.5`) on the field-score matrix and predicts matches,
     applying the threshold rule to non-matches. **Gracefully degrades to
     THRESHOLD** if ECM cannot fit (too few vectors, no field scores, or any
     exception).
5. **Cluster (`pipeline.py`)** — feeds every `DUPLICATE` decision into a
   **Union-Find** structure. On `union`, the **lexicographically smaller record
   ID becomes the root**, giving a stable canonical choice. Groups of ≥ 2 batch
   members become `DuplicateCluster`s (`canonical_id` + sorted `member_ids`);
   every record not demoted to a duplicate is reported in `unique_record_ids`.
   `PipelineStats` records pair/comparison/duplicate/cluster counts and timing.

---

## Message schemas

The contract between stages. Field names are taken from the code.

### ScrapeRequest (`scrape-requests`)

Produced by `sample-producer`, consumed by the scraper-worker as
`ScrapeRequestMessage`:

```json
{
  "taskId": "uuid",
  "url": "mock://acme-swe-1",
  "priority": "normal",
  "attempt": 1,
  "enqueuedAt": "2026-05-29T00:00:00Z"
}
```

`attempt` drives the retry/DLQ decision in Module 3.

### ParseResult (`parse-results`)

The parser service returns this JSON (Module 3 then adds `totalDurationMs`
before producing it):

```json
{
  "taskId": "uuid",
  "url": "...",
  "resolvedUrl": "...",
  "jobTitle": "Senior Software Engineer",
  "jobFunction": "engineering",
  "companyName": "Acme Corp",
  "locationCity": "London",
  "locationCountry": "UK",
  "skills": ["python", "go", "kubernetes"],
  "seniorityLevel": "senior",
  "postedDate": null,
  "extractionStrategy": "heuristic",
  "processedAt": "...",
  "totalDurationMs": 0
}
```

### JobPostingRecord (Module 4 internal)

`kafka_consumer._parse_record()` maps a ParseResult into a `JobPostingRecord`:
`record_id` ← `taskId`, `job_title`, `job_function`, `company_name`,
`location_city`, `location_country`, `skills`, `seniority_level`,
`source_url` ← `resolvedUrl`/`url`, and a fresh `ingested_at` timestamp.

### DeadLetterMessage (`scrape-dlq`)

Emitted by Module 3 when retries are exhausted (or on an undeserialisable
message). Preserves the original payload:

```json
{
  "taskId": "uuid",
  "url": "...",
  "errorCode": "SCRAPE_FAILED",
  "message": "...",
  "attemptCount": 3,
  "failedAt": "...",
  "originalPayload": "<raw kafka value>"
}
```

---

## Persistence

Module 4's **sink** (`sink.py`) is what actually persists deduplicated postings;
the pipeline itself only emits IDs and clusters. `create_sink()` chooses the
implementation from the environment:

- **`PostgresSink`** when `DEDUP_POSTGRES_DSN` is set — upserts every surviving
  record into `job_postings`.
- **`LoggingSink`** otherwise — logs what *would* have been written (no DB),
  handy for local runs.

`_rows_from_result()` flattens a `DeduplicationResult` into
`(record, is_canonical, canonical_id)` rows: unique records are canonical with no
parent; within a cluster, the `canonical_id` member is canonical and every other
member points at it.

### `job_postings` schema

Created by `PostgresSink` on first connect (`_SCHEMA_SQL`):

| Column | Type | Notes |
|--------|------|-------|
| `record_id` | `TEXT PRIMARY KEY` | The posting's task ID. |
| `job_title` | `TEXT NOT NULL` | |
| `job_function` | `TEXT NOT NULL` | |
| `company_name` | `TEXT NOT NULL` | |
| `location_city` | `TEXT` | nullable |
| `location_country` | `TEXT` | nullable |
| `skills` | `JSONB NOT NULL DEFAULT '[]'` | serialised skill list |
| `seniority_level` | `TEXT NOT NULL` | |
| `source_url` | `TEXT NOT NULL` | |
| `posted_date` | `DATE` | nullable |
| `ingested_at` | `TIMESTAMPTZ NOT NULL` | |
| `is_canonical` | `BOOLEAN NOT NULL` | `true` = surviving record of its cluster (or a unique record). |
| `canonical_id` | `TEXT` | for duplicates, the `record_id` of the canonical record; `NULL` for canonical/unique rows. |
| `batch_id` | `TEXT NOT NULL` | the dedup batch that wrote the row. |
| `written_at` | `TIMESTAMPTZ DEFAULT now()` | |

Indexes: `idx_job_postings_canonical (canonical_id)`,
`idx_job_postings_company (company_name)`.

Writes are **idempotent upserts** keyed on `record_id`
(`INSERT ... ON CONFLICT (record_id) DO UPDATE`), so reprocessing a batch updates
in place rather than duplicating rows — this complements the at-least-once
delivery upstream.

---

## Failure handling

**Module 1/3 (scrape + parse path):**

- Errors are tagged with a `WorkerErrorCode` (`ScrapeFailed`, `ParseFailed`,
  `KafkaProduceError`, `SerializationError`, `ShutdownTimeout`, `UnknownError`).
- **Retry with exponential backoff:** while `attempt < RETRY_MAX_RETRIES`, the
  request is re-produced to the **input topic** with `attempt + 1`, after a delay
  of `min(initialDelayMs · backoffFactor^(attempt-1), maxDelayMs)`.
- **DLQ:** once retries are exhausted (or on an undeserialisable message), a
  `DeadLetterMessage` carrying the original payload is produced to `scrape-dlq`
  and the dead-letter counter increments.
- **Graceful shutdown:** on `SIGTERM`/`SIGINT`, the worker stops accepting new
  work and waits up to `WORKER_SHUTDOWN_TIMEOUT_MS` for the in-flight handler to
  finish before disconnecting (recording `ShutdownTimeout` if it overruns).

**Module 2 (parser):** `HtmlParser.parse()` never raises — failures become a
typed `ParseError` returned as HTTP 422, which Module 3 surfaces as a
`ParseFailed` error and feeds into its retry/DLQ logic.

**Module 4 (dedup + persistence):**

- `DedupPipeline.deduplicate()` never raises; stage failures return a
  `DeduplicationError` (e.g. `PREPROCESSING_FAILED`, `BLOCKING_FAILED`,
  `COMPARISON_FAILED`, `CLASSIFICATION_FAILED`), which the consumer logs without
  crashing the batch loop.
- `PostgresSink` **retries the initial connection** (default 10 attempts,
  3s apart) since Postgres may still be booting, and **wraps each batch write in a
  transaction**: any failure triggers `rollback()` and a logged
  `dedup.sink.write_failed` rather than a crash — the batch is dropped, not
  half-written.
- The Kafka consumer catches `KafkaError`, sleeps briefly, and continues; the
  `consumer_timeout_ms` path flushes any pending partial batch when the stream
  goes idle.
