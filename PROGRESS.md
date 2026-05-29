# Scraper System — Development Progress

Enterprise-grade, Kubernetes-hosted web scraping system.
**Stack:** TypeScript + Python | **Infra:** Kafka, PostgreSQL, upstream proxy mesh
**Build rule:** Complete Step 1 → Step 2 → Step 3 before moving to next module.

---

## Overall Status

| Module | Description | Step 1: Types | Step 2: Logic | Step 3: Tests | Status |
|--------|-------------|:---:|:---:|:---:|--------|
| **1** | Headless Browser Controller (TS/Playwright) | ✅ | ✅ | ✅ | **COMPLETE** |
| **2** | HTML Parser (Python/BeautifulSoup+Pydantic+Anthropic) | ✅ | ✅ | ✅ | **COMPLETE** |
| **3** | Kafka Worker (TS/kafkajs+prom-client) | ✅ | ✅ | ✅ | **COMPLETE** |
| **4** | Deduplication Pipeline (Python/pandas+recordlinkage) | ✅ | ✅ | ✅ | **COMPLETE** |

---

## Module 1 — Headless Browser Controller

> `module1-browser-controller/` | TypeScript + Playwright

### Step 1: Types
- [x] `src/types.ts` — all interfaces and enums

### Step 2: Logic
- [x] `src/logger.ts` — structured JSON logger
- [x] `src/stealth.ts` — StealthInjector (canvas noise, WebGL spoof, webdriver override)
- [x] `src/humanMimicry.ts` — Bézier mouse, sinusoidal scroll, keystroke timing
- [x] `src/resourceFilter.ts` — Playwright route interception, glob + regex pattern blocking
- [x] `src/semaphore.ts` — promise-queue counting semaphore
- [x] `src/browserCluster.ts` — IBrowserCluster impl, one browser + per-request contexts
- [x] `src/configLoader.ts` — env-var loader, fail-fast validation
- [x] `src/index.ts` — public exports

### Step 3: Tests
- [x] `src/__tests__/stealth.test.ts`
- [x] `src/__tests__/humanMimicry.test.ts`
- [x] `src/__tests__/resourceFilter.test.ts`
- [x] `src/__tests__/semaphore.test.ts`
- [x] `src/__tests__/browserCluster.test.ts`
- [x] `src/__tests__/configLoader.test.ts`

---

## Module 2 — HTML Parser

> `module2-html-parser/` | Python 3.11 + BeautifulSoup + Pydantic + Anthropic SDK

### Step 1: Types ✅ Complete
- [x] `src/types.py` — all enums, Pydantic models, Protocols
  - Enums: `ExtractionStrategy`, `SeniorityLevel`, `JobFunction`, `ParseErrorCode`, `LogLevel`
  - Config models: `CssSelectorSet`, `LLMConfig`, `ParserConfig`
  - Domain models: `Location`, `RawJobPosting`, `NormalisedJobPosting`, `LLMExtractionResult`
  - I/O models: `ParseRequest`, `ParseResult`, `ParseError`, `StructuredLogEntry`
  - Protocols: `IExtractionStrategy`, `INormaliser`, `IParser`

### Step 2: Logic ✅ Complete
- [x] `src/logger.py` — structured JSON logger (mirrors Module 1 pattern)
- [x] `src/config_loader.py` — env-var loader with fail-fast validation
- [x] `src/css_extractor.py` — CSS selector strategy (`CssExtractor`)
- [x] `src/heuristic_extractor.py` — JSON-LD, Microdata, Open Graph, ARIA heuristics (`HeuristicExtractor`)
- [x] `src/llm_extractor.py` — claude-haiku-4-5 fallback extractor (`LLMExtractor`)
- [x] `src/normaliser.py` — `INormaliser` impl: maps `RawJobPosting` → `NormalisedJobPosting`
- [x] `src/parser.py` — `IParser` orchestrator (`HtmlParser`) with `HtmlParser.create()` factory
- [x] `src/server.py` — Flask `/parse` + `/health` service via `create_app(parser)` factory; builds and injects the Anthropic client. gunicorn entry: `src.server:create_app()`.
- [x] `src/__init__.py` — public exports

### Step 3: Tests ✅ Complete (142/142 passing)
- [x] `tests/test_server.py` — `/parse` + `/health` via injected stub parser (no API key needed)
- [x] `tests/__init__.py`
- [x] `tests/test_types.py` — validator edge cases on Pydantic models
- [x] `tests/test_logger.py` — JSON output format, field inclusion
- [x] `tests/test_config_loader.py` — missing vars, malformed JSON, invalid strategy names
- [x] `tests/test_css_extractor.py` — selector hits, misses, empty selector sets
- [x] `tests/test_heuristic_extractor.py` — JSON-LD, Microdata, Open Graph, ARIA, merge logic
- [x] `tests/test_llm_extractor.py` — mocked Anthropic client, API errors, malformed JSON response
- [x] `tests/test_normaliser.py` — location parsing, seniority mapping, job function mapping, date parsing
- [x] `tests/test_parser.py` — full cascade (CSS hit, heuristic hit, LLM hit, all-fail), HTML too short

---

## Module 3 — Kafka Worker

> `module3-kafka-worker/` | TypeScript + kafkajs + prom-client

### Step 1: Types ✅ Complete
- [x] `src/types.ts` — interfaces, enums, message schemas

### Step 2: Logic ✅ Complete
- [x] `src/logger.ts` — structured JSON logger (mirrors Module 1 pattern)
- [x] `src/configLoader.ts` — env-var loader with fail-fast validation
- [x] `src/consumer.ts` — `KafkaConsumer` implementing `IConsumer` (kafkajs wrapper)
- [x] `src/producer.ts` — `KafkaProducer` implementing `IProducer` (idempotent producer)
- [x] `src/metrics.ts` — `WorkerMetrics` (prom-client) + `startMetricsServer()` HTTP endpoint
- [x] `src/worker.ts` — `KafkaWorker` orchestrator: deserialise → scrape → parse → produce → retry/DLQ
- [x] `src/index.ts` — public exports

### Step 3: Tests ✅ Complete (52/52 passing)
- [x] `src/__tests__/configLoader.test.ts`
- [x] `src/__tests__/logger.test.ts`
- [x] `src/__tests__/metrics.test.ts`
- [x] `src/__tests__/consumer.test.ts`
- [x] `src/__tests__/producer.test.ts`
- [x] `src/__tests__/worker.test.ts`

---

## Module 4 — Deduplication Pipeline

> `module4-dedup-pipeline/` | Python + pandas + recordlinkage

### Step 1: Types ✅ Complete
- [x] `src/types.py` — all enums, Pydantic models, Protocols (IPreprocessor, IBlocker, IComparator, IClassifier, IPipeline)

### Step 2: Logic ✅ Complete
- [x] `src/logger.py` — structured JSON logger
- [x] `src/config_loader.py` — env-var loader with fail-fast validation
- [x] `src/preprocessor.py` — unicode normalisation, legal suffix stripping, stop-word removal, skill dedup
- [x] `src/blocker.py` — COMPANY_TITLE / COMPANY_LOCATION / TITLE_FUNCTION strategies, max_pairs guard
- [x] `src/comparator.py` — recordlinkage Compare engine, NaN clamping, weighted composite score
- [x] `src/classifier.py` — threshold + ECM (falls back to threshold on failure)
- [x] `src/pipeline.py` — full orchestrator with Union-Find cluster building, short-circuit paths, error returns
- [x] `src/sink.py` — output sink: `PostgresSink` (upserts canonical + duplicate rows into `job_postings`), `LoggingSink` fallback, `create_sink()` factory (DSN-driven). Wired into `kafka_consumer.py`.
- [x] `src/__init__.py` — public exports

### Step 3: Tests ✅ Complete (122/122 passing)
- [x] `tests/test_logger.py`
- [x] `tests/test_config_loader.py`
- [x] `tests/test_preprocessor.py`
- [x] `tests/test_blocker.py`
- [x] `tests/test_comparator.py`
- [x] `tests/test_classifier.py`
- [x] `tests/test_pipeline.py`
- [x] `tests/test_sink.py` — row flattening, LoggingSink, PostgresSink (fake driver), factory

---

## All Modules Complete

All 4 modules fully implemented and tested.

| Module | Tests |
|--------|-------|
| 1 — Browser Controller | ✅ 100/100 passing |
| 2 — HTML Parser | ✅ 142/142 passing |
| 3 — Kafka Worker | ✅ 52/52 passing |
| 4 — Dedup Pipeline | ✅ 123/123 passing |

**Total: 417 tests passing.**

## Live end-to-end run (verified)

`docker compose up -d --build` runs the full pipeline. Verified live on 2026-05-29:
producer → `scrape-requests` → scraper-worker (mock HTML) → parser (`/parse`) →
`parse-results` → dedup-worker → **PostgreSQL `job_postings`**. The two near-duplicate
Acme postings were correctly clustered (1 canonical survivor + 1 duplicate row tagged
with `canonical_id`), and the parser served `/parse` and `/health` healthily.

### Bugs found & fixed during the live run (had no test coverage)
- **Parser crash-loop:** `server.py` called `HtmlParser.create(config)` without the
  required `anthropic_client`. Fixed + refactored to a testable `create_app()` factory;
  added `tests/test_server.py`.
- **Dedup never fired:** the blocker keyed only on the *first* title token, so
  "Sr Software Engineer" / "Senior Software Engineer" never co-blocked (0 candidate
  pairs). Fixed to block on every title token; added a regression test in `test_blocker.py`.

## Deployment & ops
- `docker-compose.yml` — full local stack (kafka, postgres, parser, scraper-worker, dedup-worker, sample-producer).
- `k8s/` — Kubernetes manifests (Namespace, Secret, ConfigMaps, Kafka + Postgres StatefulSets, topic-init Job, Deployments, HPAs) + `k8s/README.md`.
- `.github/workflows/ci.yml` — CI: per-module test matrix (TS + Python) + `docker compose config` validation.
- `README.md` + `docs/ARCHITECTURE.md` — overview, data flow, env reference, deep-dive.

## Persistence

Deduplicated postings are persisted by Module 4's sink:

- **PostgreSQL** (`postgres` service in `docker-compose.yml`) stores the `job_postings`
  table. Each record is tagged `is_canonical` / `canonical_id` so duplicate clusters
  are traceable to their surviving canonical record.
- Driven by `DEDUP_POSTGRES_DSN`. When unset, the worker falls back to `LoggingSink`
  (log-only, no DB) — handy for local runs without Postgres.
