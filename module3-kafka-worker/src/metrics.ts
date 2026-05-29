import * as http from "http";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

import { Logger } from "./logger";
import {
  IWorkerMetrics,
  MetricsConfig,
  WorkerErrorCode,
  WorkerMetricsSnapshot,
} from "./types";

export class WorkerMetrics implements IWorkerMetrics {
  private readonly registry: Registry;
  private readonly consumed: Counter<string>;
  private readonly produced: Counter<string>;
  private readonly deadLettered: Counter<string>;
  private readonly errors: Counter<string>;
  private readonly duration: Histogram<string>;
  private readonly activeWorkersGauge: Gauge<string>;
  private readonly consumerLagGauge: Gauge<string>;

  // Shadow counters so snapshot() is a pure in-memory read with no async
  private _consumed = 0;
  private _produced = 0;
  private _deadLettered = 0;
  private _errors = 0;
  private _activeWorkers = 0;
  private _consumerLag = 0;
  private _totalDuration = 0;
  private _durationCount = 0;

  constructor(collectDefaults = false) {
    this.registry = new Registry();

    if (collectDefaults) {
      collectDefaultMetrics({ register: this.registry });
    }

    this.consumed = new Counter({
      name: "kafka_worker_messages_consumed_total",
      help: "Total messages consumed from input topic",
      labelNames: ["topic"],
      registers: [this.registry],
    });

    this.produced = new Counter({
      name: "kafka_worker_messages_produced_total",
      help: "Total messages produced to output topic",
      labelNames: ["topic"],
      registers: [this.registry],
    });

    this.deadLettered = new Counter({
      name: "kafka_worker_messages_dead_lettered_total",
      help: "Total messages routed to the dead-letter topic",
      registers: [this.registry],
    });

    this.errors = new Counter({
      name: "kafka_worker_processing_errors_total",
      help: "Total processing errors, partitioned by error code",
      labelNames: ["error_code"],
      registers: [this.registry],
    });

    this.duration = new Histogram({
      name: "kafka_worker_processing_duration_ms",
      help: "End-to-end processing duration from message receipt to publish (ms)",
      buckets: [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
      registers: [this.registry],
    });

    this.activeWorkersGauge = new Gauge({
      name: "kafka_worker_active_workers",
      help: "Number of messages currently being processed",
      registers: [this.registry],
    });

    this.consumerLagGauge = new Gauge({
      name: "kafka_worker_consumer_lag_total",
      help: "Total consumer group lag summed across all partitions",
      registers: [this.registry],
    });
  }

  incConsumed(topic: string): void {
    this.consumed.inc({ topic });
    this._consumed++;
  }

  incProduced(topic: string): void {
    this.produced.inc({ topic });
    this._produced++;
  }

  incDeadLettered(): void {
    this.deadLettered.inc();
    this._deadLettered++;
  }

  incError(errorCode: WorkerErrorCode): void {
    this.errors.inc({ error_code: errorCode });
    this._errors++;
  }

  observeDuration(durationMs: number): void {
    this.duration.observe(durationMs);
    this._totalDuration += durationMs;
    this._durationCount++;
  }

  setActiveWorkers(count: number): void {
    this.activeWorkersGauge.set(count);
    this._activeWorkers = count;
  }

  setConsumerLag(lag: number): void {
    this.consumerLagGauge.set(lag);
    this._consumerLag = lag;
  }

  snapshot(): WorkerMetricsSnapshot {
    return {
      messagesConsumed: this._consumed,
      messagesProduced: this._produced,
      messagesDeadLettered: this._deadLettered,
      processingErrors: this._errors,
      activeWorkers: this._activeWorkers,
      avgProcessingDurationMs:
        this._durationCount > 0
          ? this._totalDuration / this._durationCount
          : 0,
      consumerLagTotal: this._consumerLag,
    };
  }

  async getMetricsText(): Promise<string> {
    return this.registry.metrics();
  }
}

/**
 * Starts a minimal HTTP server that exposes the Prometheus /metrics endpoint.
 * Returns a cleanup function that closes the server.
 */
export function startMetricsServer(
  metricsConfig: MetricsConfig,
  workerMetrics: IWorkerMetrics,
  logger: Logger
): () => Promise<void> {
  const server = http.createServer(async (req, res) => {
    if (req.url !== metricsConfig.path) {
      res.writeHead(404).end();
      return;
    }
    try {
      const text = await workerMetrics.getMetricsText();
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(text);
    } catch (err) {
      res.writeHead(500).end();
      logger.errorFromException("metrics.server_error", err);
    }
  });

  server.listen(metricsConfig.port, () => {
    logger.info("metrics.server_started", undefined, {
      port: metricsConfig.port,
      path: metricsConfig.path,
    });
  });

  return () =>
    new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
}
