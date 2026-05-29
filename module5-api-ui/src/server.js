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
const Anthropic = require("@anthropic-ai/sdk");
const { enrichPerson } = require("./enrich");

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
    await pool.query(
      `CREATE TABLE IF NOT EXISTS people (
         id TEXT PRIMARY KEY, full_name TEXT, role TEXT, company TEXT, location TEXT,
         email TEXT, phone TEXT, linkedin TEXT, source_url TEXT, query TEXT,
         enriched BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now()
       )`
    );
    await pool.query("ALTER TABLE people ADD COLUMN IF NOT EXISTS confidence TEXT");
    await pool.query(
      `CREATE TABLE IF NOT EXISTS companies (
         id TEXT PRIMARY KEY, name TEXT, description TEXT, website TEXT, location TEXT,
         sector TEXT, size TEXT, source_url TEXT, query TEXT, created_at TIMESTAMPTZ DEFAULT now()
       )`
    );
    console.log(JSON.stringify({ event: "api.schema.ready" }));
  } catch (_e) {
    setTimeout(ensureSchema, 3000); // Postgres may still be booting
  }
}

// ---------------------------------------------------------------------------
// People mode: scrape pages and LLM-extract people + contact details
// ---------------------------------------------------------------------------
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const PEOPLE_MODEL = process.env.PEOPLE_LLM_MODEL || "claude-haiku-4-5";
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

const SCRAPER_SCRAPE_URL = process.env.SCRAPER_SCRAPE_URL || "";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function plainFetchText(url) {
  const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  return htmlToText(await resp.text());
}

// Prefer the Module 1 stealth browser (renders JS, evades basic bot blocks);
// fall back to a plain fetch if the browser endpoint is unset/unavailable/empty.
async function fetchPageText(url) {
  if (SCRAPER_SCRAPE_URL) {
    try {
      const resp = await fetch(SCRAPER_SCRAPE_URL.replace(/\/$/, "") + "/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(45000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = htmlToText(data.html || "");
        if (text) return text;
      }
    } catch (_e) { /* fall through to plain fetch */ }
  }
  try {
    return await plainFetchText(url);
  } catch (_e) {
    return "";
  }
}

async function extractPeople(text, sourceUrl) {
  const prompt =
    "From the web page text below, extract every real, named person mentioned along with their " +
    "professional details and any contact info present ON THE PAGE. Return ONLY a JSON array; each " +
    'item: {"full_name","role","company","location","email","phone","linkedin"}. Use null for unknown ' +
    "fields. Do not invent emails or phone numbers. If no real people are present, return [].\n\n" +
    "PAGE URL: " + sourceUrl + "\n\nPAGE TEXT:\n" + text;
  const resp = await anthropic.messages.create({
    model: PEOPLE_MODEL,
    max_tokens: 1500,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = (resp.content && resp.content[0] && resp.content[0].text) || "[]";
  const match = raw.match(/\[[\s\S]*\]/); // tolerate code fences / prose around the JSON
  try {
    const arr = JSON.parse(match ? match[0] : raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

async function extractCompanies(text, sourceUrl) {
  const prompt =
    "From the web page text below, extract every distinct real company/organisation mentioned. " +
    'Return ONLY a JSON array; each item: {"name","description","website","location","sector","size"}. ' +
    "Use null for unknown fields. Keep descriptions under 25 words. If none, return [].\n\n" +
    "PAGE URL: " + sourceUrl + "\n\nPAGE TEXT:\n" + text;
  const resp = await anthropic.messages.create({
    model: PEOPLE_MODEL,
    max_tokens: 1500,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = (resp.content && resp.content[0] && resp.content[0].text) || "[]";
  const match = raw.match(/\[[\s\S]*\]/);
  try {
    const arr = JSON.parse(match ? match[0] : raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

// Decide whether a free-text query is about people, companies, or jobs.
// Fast keyword pass first; LLM fallback only when the keywords are ambiguous.
const PEOPLE_WORDS = ["manager", "managers", "executive", "executives", "founder", "founders", "ceo", "cto", "cfo", "coo", "director", "directors", "partner", "partners", "head of", "team", "staff", "people", "person", "contact", "contacts", "advisor", "advisors", "employee", "employees", "recruiter", "who works"];
const COMPANY_WORDS = ["companies", "company", "firms", "firm", "startups", "startup", "vendors", "providers", "agencies", "agency", "manufacturers", "suppliers", "businesses", "organisations", "organizations", "brands"];
const JOB_WORDS = ["job", "jobs", "vacancy", "vacancies", "hiring", "career", "careers", "role", "roles", "position", "positions", "opening", "openings", "apply"];

function keywordIntent(q) {
  const s = " " + q.toLowerCase() + " ";
  const hit = (words) => words.some((w) => s.includes(" " + w + " ") || s.includes(w));
  if (hit(PEOPLE_WORDS)) return "people";
  if (hit(JOB_WORDS)) return "jobs";
  if (hit(COMPANY_WORDS)) return "companies";
  return null;
}

async function classifyIntent(query) {
  const kw = keywordIntent(query);
  if (kw) return kw;
  if (!anthropic) return "people"; // sensible default for this tool
  try {
    const resp = await anthropic.messages.create({
      model: PEOPLE_MODEL,
      max_tokens: 8,
      temperature: 0,
      messages: [{
        role: "user",
        content:
          'Classify this search query as exactly one word: "people" (individuals/contacts), ' +
          '"companies" (organisations/firms), or "jobs" (job openings). Reply with only that word.\n\nQuery: ' +
          query,
      }],
    });
    const word = ((resp.content[0] && resp.content[0].text) || "").toLowerCase().trim();
    return ["people", "companies", "jobs"].find((m) => word.includes(m)) || "people";
  } catch (_e) {
    return "people";
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

// Turn a free-text query into result URLs (no API key required). DuckDuckGo
// HTML first, with a retry and a Bing fallback so a single rate-limit doesn't
// leave the user with zero results.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ddgUrls(query, limit) {
  const resp = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    headers: { "User-Agent": UA },
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

async function bingUrls(query, limit) {
  const resp = await fetch("https://www.bing.com/search?q=" + encodeURIComponent(query), {
    headers: { "User-Agent": UA },
  });
  const html = await resp.text();
  const urls = [];
  const re = /<li class="b_algo"[\s\S]*?<h2>\s*<a[^>]*href="(https?:\/\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) && urls.length < limit) {
    const real = m[1].replace(/&amp;/g, "&");
    if (!/bing\.com|microsoft\.com/.test(real) && !urls.includes(real)) urls.push(real);
  }
  return urls;
}

async function webSearchUrls(query, limit) {
  let urls = await ddgUrls(query, limit).catch(() => []);
  if (!urls.length) { await sleep(800); urls = await ddgUrls(query, limit).catch(() => []); }
  if (!urls.length) { urls = await bingUrls(query, limit).catch(() => []); }
  return urls;
}

async function runJobsSearch(query, limit) {
  const urls = await webSearchUrls(query, limit);
  if (!urls.length) return { query, count: 0, enqueued: [], note: "no results (search may be rate-limited)" };
  const enqueued = [];
  for (const url of urls) enqueued.push({ url, taskId: await enqueue(url, query) });
  return { query, count: enqueued.length, enqueued };
}

app.post("/api/search", async (req, res) => {
  const { query, limit } = req.body || {};
  if (!query || typeof query !== "string") return res.status(400).json({ error: "query is required" });
  if (!producerReady) return res.status(503).json({ error: "kafka not ready yet" });
  try {
    res.json(await runJobsSearch(query, Math.min(parseInt(limit, 10) || 5, 10)));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// People mode: search the web for a query, scrape the top pages (via the
// stealth browser), and LLM-extract people + any contact details on the page.
async function runPeopleSearch(query, limit) {
  const urls = await webSearchUrls(query, limit);
  let inserted = 0, blocked = 0;
  const pages = [];
  for (const url of urls) {
    try {
      const text = await fetchPageText(url);
      if (!text) { blocked++; pages.push({ url, people: 0, note: "empty/blocked" }); continue; }
      const people = await extractPeople(text, url);
      for (const p of people) {
        await pool.query(
          `INSERT INTO people (id, full_name, role, company, location, email, phone, linkedin, source_url, query)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [crypto.randomUUID(), p.full_name || null, p.role || null, p.company || null, p.location || null,
           p.email || null, p.phone || null, p.linkedin || null, url, query]
        );
        inserted++;
      }
      pages.push({ url, people: people.length });
    } catch (e) {
      blocked++;
      pages.push({ url, people: 0, note: "fetch/extract failed" });
    }
  }
  return { query, peopleFound: inserted, pagesTried: urls.length, blocked, pages };
}

app.post("/api/people/search", async (req, res) => {
  const { query, limit } = req.body || {};
  if (!query || typeof query !== "string") return res.status(400).json({ error: "query is required" });
  if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set on the api-ui service" });
  try {
    res.json(await runPeopleSearch(query, Math.min(parseInt(limit, 10) || 6, 8)));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Companies mode: same flow, LLM-extracting organisations instead of people.
async function runCompaniesSearch(query, limit) {
  const urls = await webSearchUrls(query, limit);
  let inserted = 0, blocked = 0;
  const pages = [];
  for (const url of urls) {
    try {
      const text = await fetchPageText(url);
      if (!text) { blocked++; pages.push({ url, companies: 0, note: "empty/blocked" }); continue; }
      const companies = await extractCompanies(text, url);
      for (const c of companies) {
        await pool.query(
          `INSERT INTO companies (id, name, description, website, location, sector, size, source_url, query)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [crypto.randomUUID(), c.name || null, c.description || null, c.website || null,
           c.location || null, c.sector || null, c.size || null, url, query]
        );
        inserted++;
      }
      pages.push({ url, companies: companies.length });
    } catch (e) {
      blocked++;
      pages.push({ url, companies: 0, note: "fetch/extract failed" });
    }
  }
  return { query, companiesFound: inserted, pagesTried: urls.length, blocked, pages };
}

app.post("/api/companies/search", async (req, res) => {
  const { query, limit } = req.body || {};
  if (!query || typeof query !== "string") return res.status(400).json({ error: "query is required" });
  if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set on the api-ui service" });
  try {
    res.json(await runCompaniesSearch(query, Math.min(parseInt(limit, 10) || 6, 8)));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/companies", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, website, location, sector, size, source_url, query
       FROM companies ORDER BY created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.delete("/api/companies", async (_req, res) => {
  try { await pool.query("TRUNCATE companies"); res.json({ cleared: true }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

// Auto mode: detect intent from the query, then run the matching search.
app.post("/api/discover", async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== "string") return res.status(400).json({ error: "query is required" });
  try {
    const mode = await classifyIntent(query);
    let result;
    if (mode === "people") {
      if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set" });
      result = await runPeopleSearch(query, 6);
    } else if (mode === "companies") {
      if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY not set" });
      result = await runCompaniesSearch(query, 6);
    } else {
      if (!producerReady) return res.status(503).json({ error: "kafka not ready yet" });
      result = await runJobsSearch(query, 6);
    }
    res.json({ mode, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/people", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, role, company, location, email, phone, linkedin, source_url, query, enriched, confidence
       FROM people ORDER BY created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.delete("/api/people", async (_req, res) => {
  try { await pool.query("TRUNCATE people"); res.json({ cleared: true }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

// Self-hosted enrichment: resolve company domain, MX-check, generate + verify
// candidate emails, and write back the best email + a confidence label.
app.post("/api/people/:id/enrich", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, full_name, company, email FROM people WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "person not found" });
    const p = rows[0];
    if (!p.company) return res.status(400).json({ error: "no company on record to enrich from" });

    const result = await enrichPerson({ fullName: p.full_name, company: p.company }, webSearchUrls);
    await pool.query(
      "UPDATE people SET email = COALESCE($1, email), confidence = $2, enriched = true WHERE id = $3",
      [result.email, result.confidence, p.id]
    );
    res.json({ id: p.id, ...result });
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
