/**
 * Production entry point for the Kafka Worker.
 *
 * Wire-up order:
 *   1. Load configs from env vars
 *   2. Build BrowserCluster (real) or MockScraperAdapter (SCRAPER_MOCK_MODE=true)
 *   3. Build HttpParserAdapter → Module 2 HTTP service
 *   4. Build KafkaConsumer + KafkaProducer + WorkerMetrics
 *   5. Start KafkaWorker
 *   6. Register SIGTERM / SIGINT for graceful shutdown
 */

import * as http from "http";

import {
  BrowserCluster,
  loadConfig as loadBrowserConfig,
} from "@scraper/browser-controller";

import { loadConfig } from "./configLoader";
import { Logger } from "./logger";
import { KafkaConsumer } from "./consumer";
import { KafkaProducer } from "./producer";
import { WorkerMetrics, startMetricsServer } from "./metrics";
import { KafkaWorker } from "./worker";
import { BrowserAdapter } from "./adapters/browserAdapter";
import { HttpParserAdapter } from "./adapters/httpParserAdapter";
import type {
  IScraperPort,
  ScrapeRequestMessage,
  ScrapeResultInternal,
} from "./types";

// ---------------------------------------------------------------------------
// Mock scraper — returned when SCRAPER_MOCK_MODE=true
// Serves canned JSON-LD job postings so the demo runs without real web access.
// ---------------------------------------------------------------------------

const MOCK_JOB_HTML = [
  `<html><head><title>Senior Software Engineer at Acme Corp</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting",
  "title":"Senior Software Engineer","hiringOrganization":{"name":"Acme Corp"},
  "jobLocation":{"address":{"addressLocality":"London","addressCountry":"UK"}},
  "description":"Python Go Kubernetes expert needed"}</script></head>
  <body><h1>Senior Software Engineer</h1></body></html>`,

  `<html><head><title>Senior Software Engineer - Acme Corporation</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting",
  "title":"Sr Software Engineer","hiringOrganization":{"name":"Acme Corporation"},
  "jobLocation":{"address":{"addressLocality":"London","addressCountry":"UK"}},
  "description":"Python Kubernetes Go senior engineer role"}</script></head>
  <body><h1>Sr Software Engineer</h1></body></html>`,

  `<html><head><title>Data Scientist at Globex Ltd</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting",
  "title":"Data Scientist","hiringOrganization":{"name":"Globex Ltd"},
  "jobLocation":{"address":{"addressLocality":"Berlin","addressCountry":"DE"}},
  "description":"Python pandas scikit-learn ML engineer"}</script></head>
  <body><h1>Data Scientist</h1></body></html>`,

  `<html><head><title>Product Manager at Initech</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting",
  "title":"Product Manager","hiringOrganization":{"name":"Initech"},
  "jobLocation":{"address":{"addressLocality":"New York","addressCountry":"US"}},
  "description":"Product roadmap strategy stakeholder management"}</script></head>
  <body><h1>Product Manager</h1></body></html>`,
];

class MockScraperAdapter implements IScraperPort {
  private _index = 0;
  async scrape(msg: ScrapeRequestMessage): Promise<ScrapeResultInternal> {
    const html = MOCK_JOB_HTML[this._index % MOCK_JOB_HTML.length] ?? MOCK_JOB_HTML[0] ?? "";
    this._index++;
    return {
      taskId: msg.taskId,
      url: msg.url,
      resolvedUrl: msg.url,
      html,
      statusCode: 200,
      durationMs: 80,
      scrapedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const logger = new Logger();

  const config = loadConfig();
  const mockMode = (process.env["SCRAPER_MOCK_MODE"] ?? "false").toLowerCase() === "true";
  const parserUrl = process.env["PARSER_SERVICE_URL"];
  if (!parserUrl) {
    throw new Error('Required environment variable "PARSER_SERVICE_URL" is not set');
  }

  logger.info("worker.boot", undefined, {
    mockMode,
    parserUrl,
    brokers: config.kafka.brokers,
    inputTopic: config.topics.inputTopic,
  });

  // Build scraper adapter
  let scraper: IScraperPort;
  let cluster: BrowserCluster | undefined;

  if (mockMode) {
    logger.info("worker.scraper.mock", undefined);
    scraper = new MockScraperAdapter();
  } else {
    const browserConfig = loadBrowserConfig();
    cluster = new BrowserCluster(browserConfig);
    await cluster.init();
    scraper = new BrowserAdapter(cluster);
    logger.info("worker.scraper.browser_cluster_ready", undefined);
  }

  // Build parser adapter
  const parser = new HttpParserAdapter(parserUrl);

  // Build Kafka I/O
  const consumer = new KafkaConsumer(config.kafka, logger);
  const producer = new KafkaProducer(config.kafka, logger);
  const metrics = new WorkerMetrics(true);

  // Start Prometheus metrics endpoint
  const stopMetrics = startMetricsServer(config.metrics, metrics, logger);

  // On-demand scrape endpoint: lets other services (e.g. the API/UI's People
  // and Companies modes) fetch a URL through the same stealth browser instead
  // of a plain HTTP fetch. POST /scrape { url } -> { html, statusCode, resolvedUrl }.
  const scrapePort = parseInt(process.env["SCRAPER_HTTP_PORT"] ?? "9091", 10);
  const scrapeServer = http.createServer((req, res) => {
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/scrape") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      void (async () => {
        try {
          const { url } = JSON.parse(body || "{}") as { url?: string };
          if (!url) {
            res.writeHead(400, { "Content-Type": "application/json" }).end(
              JSON.stringify({ error: "url is required" })
            );
            return;
          }
          const request: ScrapeRequestMessage = {
            taskId: `http-${Date.now()}`,
            url,
            priority: "normal" as ScrapeRequestMessage["priority"],
            attempt: 1,
            enqueuedAt: new Date().toISOString(),
          };
          const result = await scraper.scrape(request);
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              html: result.html,
              statusCode: result.statusCode,
              resolvedUrl: result.resolvedUrl,
            })
          );
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: String(err) })
          );
        }
      })();
    });
  });
  scrapeServer.listen(scrapePort, () => {
    logger.info("scrape.server_started", undefined, { port: scrapePort });
  });

  // Build and start worker
  const worker = new KafkaWorker(
    config,
    consumer,
    producer,
    scraper,
    parser,
    metrics,
    logger
  );

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("worker.signal_received", undefined, { signal });
    await worker.stop();
    if (cluster) await cluster.shutdown();
    scrapeServer.close();
    stopMetrics();
    process.exit(0);
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT",  () => { void shutdown("SIGINT"); });

  await worker.start();
}

main().catch((err: unknown) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
