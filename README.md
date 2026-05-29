# Scraper System

An enterprise-grade, container-native web-scraping pipeline that turns scrape
requests into clean, **deduplicated** job postings. Requests flow through Kafka to
a stealth headless-browser scraper, then to a layout-agnostic HTML parser (CSS →
heuristic → LLM cascade), and finally to a record-linkage deduplication stage
that clusters near-duplicate postings and persists the survivors to PostgreSQL.
The system is built from four independent modules (two TypeScript, two Python)
wired together with Kafka topics and an HTTP parse service, and ships with a
Docker Compose topology that runs the whole thing end-to-end.

---

## Architecture

```mermaid
flowchart LR
    SP[sample-producer]
    KI[kafka-init<br/>creates topics]

    subgraph KAFKA["Kafka (KRaft, :9092)"]
        T1[[scrape-requests]]
        T2[[parse-results]]
        DLQ[[scrape-dlq]]
    end

    subgraph SW["scraper-worker (Module 1 + 3)"]
        W[KafkaWorker<br/>scrape → parse → produce]
        M[(metrics :9090/metrics)]
    end

    P[parser service<br/>Module 2 · Flask :8080]
    DW[dedup-worker<br/>Module 4]
    PG[(PostgreSQL :5432<br/>job_postings)]

    SP -->|ScrapeRequest| T1
    KI -.-> T1 & T2 & DLQ
    T1 --> W
    W -->|"HTTP POST /parse"| P
    P -->|ParseResult JSON| W
    W -->|ParseResult| T2
    W -.->|"retries exhausted"| DLQ
    W --- M
    T2 --> DW
    DW -->|deduplicated rows| PG
```

Compact ASCII fallback:

```
                    +--------------+
                    | kafka-init   |  (creates the 3 topics, then exits)
                    +--------------+
                           |
 sample-producer           v
   |  ScrapeRequest   [ scrape-requests ]
   +----------------------> |
                           v
                  +------------------------+        HTTP POST /parse
                  |   scraper-worker       | -------------------------> +-----------+
                  |   (Module 1 scrape +   | <------------------------- |  parser   |
                  |    Module 3 orchestr.) |     ParseResult JSON       | (Mod. 2)  |
                  |   metrics :9090        |                            +-----------+
                  +------------------------+
                     |                  \  retries exhausted
                     | ParseResult       \-----> [ scrape-dlq ]
                     v
              [ parse-results ]
                     |
                     v
              +----------------+      deduplicated rows
              |  dedup-worker  | --------------------------> [ PostgreSQL: job_postings ]
              |  (Module 4)    |
              +----------------+
```

---

## Modules

| # | Name | Language / Stack | Responsibility | Tests |
|---|------|------------------|----------------|:----:|
| **1** | Headless Browser Controller | TypeScript · Playwright | Stealth Chromium cluster: canvas/WebGL/webdriver spoofing, human mouse/scroll/keystroke mimicry, resource-type request filtering, semaphore-bounded per-request browser contexts. | 100 |
| **2** | HTML Parser | Python 3.11 · BeautifulSoup · Pydantic · Anthropic | Layout-agnostic extraction cascade — CSS selectors → JSON-LD/Microdata/OpenGraph/ARIA heuristics → Claude LLM fallback — normalised into a typed job posting. Exposed as a Flask `/parse` HTTP service. | 136 |
| **3** | Kafka Worker | TypeScript · kafkajs · prom-client | Orchestrates the `scrape → parse → produce` pipeline; consumes `scrape-requests`, calls Module 1 (or mock) then the Module 2 service, produces `parse-results`, with exponential-backoff retry, DLQ routing, and Prometheus metrics. | 52 |
| **4** | Deduplication Pipeline | Python · pandas · recordlinkage · scikit-learn | Batches `parse-results` and runs `preprocess → block → compare → classify`, builds duplicate clusters with Union-Find, then persists canonical + duplicate rows to PostgreSQL. | 122 |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the deep dive into each
module's internal design, message schemas, the dedup algorithm, the persistence
schema, and failure handling.

---

## Prerequisites

- **Docker** and **Docker Compose** (the only requirement for the full stack — every service builds and runs in containers).
- For running individual modules locally / for development:
  - **Node.js 20** (Modules 1 and 3)
  - **Python 3.11** (Modules 2 and 4)

---

## Quickstart

```bash
# 1. Configure secrets
cp .env.example .env
#    then edit .env and set a real ANTHROPIC_API_KEY (used by Module 2's LLM fallback)

# 2. Build and start the whole stack
docker compose up -d --build

# 3. Watch the deduplication results roll in
docker compose logs -f dedup-worker
#    (or watch the scraper: docker compose logs -f scraper-worker)

# 4. Query the persisted, deduplicated postings
docker compose exec postgres psql -U scraper -d scraper \
  -c 'SELECT record_id, job_title, company_name, is_canonical, canonical_id FROM job_postings;'

# 5. Tear everything down (and drop the volumes)
docker compose down -v
```

On startup, `kafka-init` creates the three topics, `sample-producer` sends four
demo `ScrapeRequest`s (two of which are near-duplicate "Senior SWE @ Acme"
postings), and the pipeline processes them end-to-end. In the `job_postings`
table you should see one of the Acme records flagged `is_canonical = true` and
the other pointing at it via `canonical_id`.

### Mock mode vs. live scraping

The Compose stack ships with `SCRAPER_MOCK_MODE=true` on `scraper-worker`. In
this mode the worker **does not** open a real browser — it serves canned JSON-LD
job HTML, and the sample producer sends `mock://…` URLs. This lets the demo run
with no live web access and no anti-scraping risk.

Set `SCRAPER_MOCK_MODE=false` (in `.env` / the service environment) to have the
worker spin up the real Module 1 Playwright `BrowserCluster` and scrape the URLs
it receives. All the `STEALTH_*`, `RESOURCE_*`, `MIMICRY_*`, and `CLUSTER_*`
variables on `scraper-worker` apply in this mode.

---

## Environment variables

The single required secret lives in `.env` (see `.env.example`):

| Variable | Required | Purpose |
|----------|:---:|---------|
| `ANTHROPIC_API_KEY` | ✅ | Anthropic key for Module 2's LLM extractor fallback. |
| `SCRAPER_MOCK_MODE` | optional | `true` (default) = canned HTML demo; `false` = real browser scraping. |

Everything else is set per-service in `docker-compose.yml`. Key variables, grouped by service:

**`parser` (Module 2, port 8080)**

| Variable | Default | Purpose |
|----------|---------|---------|
| `PARSER_STRATEGY_ORDER` | `heuristic,llm` | Extraction cascade order. |
| `PARSER_SELECTOR_SETS` | `[]` | JSON CSS-selector sets for the CSS strategy. |
| `PARSER_MIN_HTML_LENGTH` | `200` | Reject HTML shorter than this (non-whitespace chars). |
| `LLM_MODEL` | `claude-haiku-4-5-20251001` | Model used by the LLM fallback. |
| `LLM_MAX_TOKENS` / `LLM_TEMPERATURE` / `LLM_TIMEOUT_SECONDS` / `LLM_MAX_HTML_CHARS` | `1024` / `0.0` / `30` / `8000` | LLM call tuning. |
| `ANTHROPIC_API_KEY` | from `.env` | LLM credential. |
| `PARSER_PORT` | `8080` | HTTP listen port. |

**`scraper-worker` (Modules 1 + 3, metrics port 9090)**

| Variable | Default | Purpose |
|----------|---------|---------|
| `KAFKA_BROKERS` | `kafka:9092` | Broker list. |
| `KAFKA_CLIENT_ID` / `KAFKA_GROUP_ID` | `scraper-worker` / `scraper-workers` | Kafka client identity. |
| `KAFKA_TOPIC_INPUT` | `scrape-requests` | Consumed topic. |
| `KAFKA_TOPIC_OUTPUT` | `parse-results` | Produced topic. |
| `KAFKA_TOPIC_DEAD_LETTER` | `scrape-dlq` | Dead-letter topic. |
| `KAFKA_FROM_BEGINNING` | `true` | Read from earliest offset. |
| `RETRY_MAX_RETRIES` / `RETRY_INITIAL_DELAY_MS` / `RETRY_BACKOFF_FACTOR` / `RETRY_MAX_DELAY_MS` | `3` / `1000` / `2.0` / `30000` | Retry/backoff policy. |
| `METRICS_PORT` / `METRICS_PATH` | `9090` / `/metrics` | Prometheus endpoint. |
| `WORKER_CONCURRENCY` / `WORKER_SHUTDOWN_TIMEOUT_MS` | `2` / `30000` | Concurrency and graceful-shutdown window. |
| `PARSER_SERVICE_URL` | `http://parser:8080` | Module 2 endpoint. |
| `SCRAPER_MOCK_MODE` | `true` | See *Mock mode* above. |
| `CLUSTER_*`, `STEALTH_*`, `RESOURCE_BLOCKED_TYPES`, `MIMICRY_*` | (see compose) | Module 1 browser config, used only when `SCRAPER_MOCK_MODE=false`. |

**`dedup-worker` (Module 4)**

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEDUP_BLOCKING_STRATEGIES` | `company_title,title_function` | Candidate-pair blocking strategies. |
| `DEDUP_BLOCKING_MAX_PAIRS` | `5000` | Hard cap on generated candidate pairs. |
| `DEDUP_COMPARISON_FIELDS` | (JSON) | Per-field metric/weight/threshold config. |
| `DEDUP_CLASSIFIER_TYPE` | `threshold` | `threshold` or `ecm`. |
| `DEDUP_MATCH_THRESHOLD` / `DEDUP_UNMATCH_THRESHOLD` | `0.75` / `0.3` | Duplicate / unique decision bounds. |
| `DEDUP_BATCH_SIZE` | `100` | Pipeline batch size. |
| `DEDUP_KAFKA_BROKERS` | `kafka:9092` | Broker list. |
| `DEDUP_KAFKA_GROUP_ID` | `dedup-workers` | Consumer group. |
| `DEDUP_KAFKA_INPUT_TOPIC` | `parse-results` | Consumed topic. |
| `DEDUP_FLUSH_INTERVAL_S` / `DEDUP_BATCH_FLUSH_SIZE` | `15` / `4` | Time- and size-based batch flush triggers. |
| `DEDUP_POSTGRES_DSN` | `postgresql://scraper:scraper@postgres:5432/scraper` | Persistence target. **Unset → log-only fallback (no DB).** |

**`postgres`**

| Variable | Default |
|----------|---------|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `scraper` / `scraper` / `scraper` |

**Kafka topics & ports**

| Topic | Partitions | Role |
|-------|:---:|------|
| `scrape-requests` | 3 | Inbound scrape jobs. |
| `parse-results` | 3 | Parsed postings (scraper → dedup). |
| `scrape-dlq` | 1 | Dead-letter for permanently failed messages. |

| Port | Service |
|------|---------|
| `8080` | parser (Module 2 HTTP) |
| `9090` | scraper-worker Prometheus metrics |
| `9092` | Kafka broker |
| `5432` | PostgreSQL |

---

## Running the test suites

Each module is tested in isolation.

```bash
# Module 1 — Browser Controller (100 tests)
cd module1-browser-controller && npm install && npm test

# Module 2 — HTML Parser (136 tests)
cd module2-html-parser && pip install -e .[dev] && pytest

# Module 3 — Kafka Worker (52 tests)
cd module3-kafka-worker && npm install && npm test

# Module 4 — Dedup Pipeline (122 tests)
cd module4-dedup-pipeline && pip install -e .[dev] && pytest
```

---

## Observability

The `scraper-worker` exposes Prometheus metrics at
`http://localhost:9090/metrics` (path/port configurable via `METRICS_PATH` /
`METRICS_PORT`). Exported series include:

- `kafka_worker_messages_consumed_total{topic}`
- `kafka_worker_messages_produced_total{topic}`
- `kafka_worker_messages_dead_lettered_total`
- `kafka_worker_processing_errors_total{error_code}`
- `kafka_worker_processing_duration_ms` (histogram)
- `kafka_worker_active_workers`, `kafka_worker_consumer_lag_total`

plus default Node.js process metrics.

### Kubernetes

For Kubernetes deployment manifests, see `k8s/` (being added by a teammate).

---

## Troubleshooting

- **`docker compose up` hangs or errors immediately** — the Docker engine may be paused or not started. Start Docker Desktop / the daemon and retry.
- **Parser returns errors / scraping fails on every message** — check that `ANTHROPIC_API_KEY` is set to a real key in `.env`. The parser container reads it at boot; the LLM fallback fails without it.
- **`Unknown topic or partition` early in the logs** — topics are created by the one-shot `kafka-init` service after Kafka becomes healthy. Workers `depend_on` it, but on a very fresh start give it a few seconds; the producer and consumers retry automatically.
- **`job_postings` table is empty** — confirm `dedup-worker` is healthy (`docker compose logs dedup-worker`) and that `DEDUP_POSTGRES_DSN` is set (when unset, Module 4 logs results instead of writing to the DB). Batches flush by size (`DEDUP_BATCH_FLUSH_SIZE`) or after `DEDUP_FLUSH_INTERVAL_S`, so allow a few seconds.
- **Stale state between runs** — `docker compose down -v` drops the `kafka-data` and `postgres-data` volumes for a clean slate.
