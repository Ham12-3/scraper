/**
 * API gateway + dashboard for the scraper pipeline.
 *
 *  REST:
 *    POST /api/scrape        { url }            -> enqueue one scrape job
 *    POST /api/scrape/bulk   { urls: [...] }    -> enqueue many
 *    GET  /api/jobs                              -> recent job_postings rows
 *    GET  /api/stats                             -> totals
 *    GET  /health
 *  WebSocket /ws/logs  -> live, service-tagged container log lines
 *
 * Live logs are streamed straight from the Docker daemon (socket mounted into
 * this container), so the panel shows exactly what `docker compose logs` shows.
 */
const http = require("http");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const { Kafka } = require("kafkajs");
const { Pool } = require("pg");
const { WebSocketServer } = require("ws");
const Docker = require("dockerode");

const PORT = parseInt(process.env.API_PORT || "3000", 10);
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || "kafka:9092").split(",");
const INPUT_TOPIC = process.env.KAFKA_TOPIC_INPUT || "scrape-requests";
const PG_DSN = process.env.POSTGRES_DSN || "postgresql://scraper:scraper@postgres:5432/scraper";
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT || "scraper";

// ---------------------------------------------------------------------------
// Kafka producer (connect with retry)
// ---------------------------------------------------------------------------
const kafka = new Kafka({ clientId: "api-ui", brokers: KAFKA_BROKERS });
const producer = kafka.producer();
let producerReady = false;

async function connectProducer() {
  for (let attempt = 1; ; attempt++) {
    try {
      await producer.connect();
      producerReady = true;
      console.log(JSON.stringify({ event: "api.kafka.connected", attempt }));
      return;
    } catch (err) {
      console.log(JSON.stringify({ event: "api.kafka.retry", attempt, message: String(err) }));
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function enqueue(url, query) {
  const taskId = crypto.randomUUID();
  const message = {
    taskId,
    url,
    priority: "normal",
    attempt: 1,
    enqueuedAt: new Date().toISOString(),
  };
  await producer.send({
    topic: INPUT_TOPIC,
    messages: [{ key: taskId, value: JSON.stringify(message) }],
  });
  // Remember which query/url produced this task so the UI can tag the result.
  try {
    await pool.query(
      "INSERT INTO scrape_queries (task_id, query) VALUES ($1, $2) ON CONFLICT (task_id) DO NOTHING",
      [taskId, query || url]
    );
  } catch (_e) { /* table may not exist yet on very first call */ }
  return taskId;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------
const pool = new Pool({ connectionString: PG_DSN });

async function ensureSchema() {
  try {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS scrape_queries (task_id TEXT PRIMARY KEY, query TEXT, created_at TIMESTAMPTZ DEFAULT now())"
    );
    console.log(JSON.stringify({ event: "api.schema.ready" }));
  } catch (_e) {
    setTimeout(ensureSchema, 3000); // Postgres may still be booting
  }
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ status: "ok", producerReady }));

app.post("/api/scrape", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ error: "url is required" });
  if (!producerReady) return res.status(503).json({ error: "kafka not ready yet" });
  try {
    const taskId = await enqueue(url, "(direct URL)");
    res.json({ taskId, url, status: "enqueued" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/scrape/bulk", async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: "urls[] is required" });
  if (!producerReady) return res.status(503).json({ error: "kafka not ready yet" });
  try {
    const enqueued = [];
    for (const url of urls) {
      const u = typeof url === "string" ? url.trim() : "";
      if (u) enqueued.push({ url: u, taskId: await enqueue(u, "(direct URL)") });
    }
    res.json({ count: enqueued.length, enqueued });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Turn a free-text query into result URLs via DuckDuckGo's HTML endpoint
// (no API key required), then enqueue each one through the pipeline.
async function webSearchUrls(query, limit) {
  const resp = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  const html = await resp.text();
  const urls = [];
  const re = /class="result__a"[^>]*href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) && urls.length < limit) {
    const href = m[1].replace(/&amp;/g, "&");
    const uddg = href.match(/[?&]uddg=([^&]+)/); // organic results are wrapped in this redirect
    if (!uddg) continue; // skip ads / y.js sponsored links (they have no uddg)
    const real = decodeURIComponent(uddg[1]);
    if (/^https?:\/\//.test(real) && !/duckduckgo\.com/.test(real) && !urls.includes(real)) {
      urls.push(real);
    }
  }
  return urls;
}

app.post("/api/search", async (req, res) => {
  const { query, limit } = req.body || {};
  if (!query || typeof query !== "string") return res.status(400).json({ error: "query is required" });
  if (!producerReady) return res.status(503).json({ error: "kafka not ready yet" });
  try {
    const n = Math.min(parseInt(limit, 10) || 5, 10);
    const urls = await webSearchUrls(query, n);
    if (!urls.length) return res.json({ query, count: 0, enqueued: [], note: "no results (search may be rate-limited)" });
    const enqueued = [];
    for (const url of urls) enqueued.push({ url, taskId: await enqueue(url, query) });
    res.json({ query, count: enqueued.length, enqueued });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/jobs", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT j.record_id, j.job_title, j.company_name, j.location_city, j.location_country,
              j.seniority_level, j.skills, j.source_url, j.is_canonical, j.canonical_id, j.written_at,
              q.query
       FROM job_postings j
       LEFT JOIN scrape_queries q ON q.task_id = j.record_id
       ORDER BY j.written_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err), hint: "table is created after the first batch is persisted" });
  }
});

app.delete("/api/jobs", async (_req, res) => {
  try {
    await pool.query("TRUNCATE job_postings");
    await pool.query("TRUNCATE scrape_queries");
    res.json({ cleared: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE is_canonical)::int AS canonical,
              count(*) FILTER (WHERE NOT is_canonical)::int AS duplicates
       FROM job_postings`
    );
    res.json(rows[0] || { total: 0, canonical: 0, duplicates: 0 });
  } catch (err) {
    res.json({ total: 0, canonical: 0, duplicates: 0 });
  }
});

// ---------------------------------------------------------------------------
// WebSocket: live Docker container logs
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/logs" });
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

function shortService(container) {
  const labels = container.Labels || {};
  return labels["com.docker.compose.service"] || (container.Names && container.Names[0]) || container.Id.slice(0, 12);
}

const ANSI = new RegExp("\\u001b\\[[0-9;]*m", "g");
const CTRL = new RegExp("[\\u0000-\\u0008\\u000e-\\u001f]", "g");

function cleanLine(raw) {
  // strip ANSI colour codes and stray control bytes from container output
  return String(raw).replace(ANSI, "").replace(CTRL, "").trim();
}

async function streamContainerLogs(container, service) {
  const c = docker.getContainer(container.Id);
  const stream = await c.logs({ follow: true, stdout: true, stderr: true, tail: 20, timestamps: false });
  const emit = (buf, level) => {
    String(buf)
      .split("\n")
      .map(cleanLine)
      .filter(Boolean)
      .forEach((line) => broadcast({ ts: new Date().toISOString(), service, level, line }));
  };
  const stdout = { write: (b) => emit(b, "out") };
  const stderr = { write: (b) => emit(b, "err") };
  c.modem.demuxStream(stream, stdout, stderr);
  stream.on("error", () => {});
}

async function startLogStreaming() {
  try {
    const containers = await docker.listContainers({ all: false });
    const mine = containers.filter(
      (c) => (c.Labels || {})["com.docker.compose.project"] === COMPOSE_PROJECT && shortService(c) !== "api-ui"
    );
    for (const c of mine) {
      streamContainerLogs(c, shortService(c)).catch(() => {});
    }
    console.log(JSON.stringify({ event: "api.logs.streaming", containers: mine.map((c) => shortService(c)) }));
  } catch (err) {
    console.log(JSON.stringify({ event: "api.logs.error", message: String(err) }));
    setTimeout(startLogStreaming, 5000);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(JSON.stringify({ event: "api.listening", port: PORT }));
  connectProducer();
  ensureSchema();
  setTimeout(startLogStreaming, 3000);
});
