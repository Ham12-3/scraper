import { Logger } from "./logger";
import {
  ConsumedMessage,
  DeadLetterMessage,
  IConsumer,
  IParserPort,
  IProducer,
  IScraperPort,
  IWorker,
  IWorkerMetrics,
  ParseResultMessage,
  ScrapeRequestMessage,
  WorkerConfig,
  WorkerErrorCode,
  WorkerMetricsSnapshot,
  WorkerStatus,
} from "./types";

export class KafkaWorker implements IWorker {
  private status: WorkerStatus = WorkerStatus.Idle;

  constructor(
    private readonly config: WorkerConfig,
    private readonly consumer: IConsumer,
    private readonly producer: IProducer,
    private readonly scraper: IScraperPort,
    private readonly parser: IParserPort,
    private readonly metrics: IWorkerMetrics,
    private readonly logger: Logger
  ) {}

  // ---------------------------------------------------------------------------
  // IWorker
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.status = WorkerStatus.Processing;
    this.logger.info("worker.starting");

    await this.consumer.connect();
    await this.producer.connect();

    await this.consumer.subscribe(
      [this.config.topics.inputTopic],
      this.config.topics.fromBeginning
    );

    this.logger.info("worker.running", undefined, {
      inputTopic: this.config.topics.inputTopic,
      outputTopic: this.config.topics.outputTopic,
    });

    // eachMessage is awaited serially per partition, giving at-least-once delivery.
    await this.consumer.run(async (message) => {
      if (this.status === WorkerStatus.ShuttingDown) return;
      this.metrics.setActiveWorkers(1);
      try {
        await this.processMessage(message);
      } finally {
        this.metrics.setActiveWorkers(0);
      }
    });
  }

  async stop(): Promise<void> {
    this.logger.info("worker.stopping");
    this.status = WorkerStatus.ShuttingDown;

    // Allow the in-flight eachMessage handler time to finish
    const deadline = Date.now() + this.config.shutdownTimeoutMs;
    while (
      this.metrics.snapshot().activeWorkers > 0 &&
      Date.now() < deadline
    ) {
      await sleep(50);
    }

    if (this.metrics.snapshot().activeWorkers > 0) {
      this.logger.warn("worker.shutdown_timeout_exceeded", undefined, {
        shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      });
      this.metrics.incError(WorkerErrorCode.ShutdownTimeout);
    }

    await this.consumer.disconnect();
    await this.producer.disconnect();
    this.status = WorkerStatus.Stopped;
    this.logger.info("worker.stopped");
  }

  getStatus(): WorkerStatus {
    return this.status;
  }

  getMetrics(): WorkerMetricsSnapshot {
    return this.metrics.snapshot();
  }

  // ---------------------------------------------------------------------------
  // Message lifecycle
  // ---------------------------------------------------------------------------

  async processMessage(message: ConsumedMessage): Promise<void> {
    const startMs = Date.now();
    this.metrics.incConsumed(message.topic);

    // Deserialise
    let request: ScrapeRequestMessage;
    try {
      request = JSON.parse(message.value) as ScrapeRequestMessage;
    } catch (err) {
      this.logger.errorFromException(
        "worker.deserialization_error",
        err,
        undefined,
        WorkerErrorCode.SerializationError
      );
      this.metrics.incError(WorkerErrorCode.SerializationError);
      await this.sendToDeadLetter(
        message,
        WorkerErrorCode.SerializationError,
        err instanceof Error ? err.message : String(err),
        1
      );
      return;
    }

    const { taskId, url, attempt } = request;

    this.logger.debug("worker.processing", taskId, {
      url,
      attempt,
      topic: message.topic,
      partition: message.partition,
      offset: message.offset,
    });

    try {
      // Step 1 — scrape
      const scrapeResult = await this.scraper.scrape(request).catch((err) => {
        throw tagError(err, WorkerErrorCode.ScrapeFailed);
      });

      // Step 2 — parse
      const parseResult = await this.parser
        .parse(taskId, scrapeResult.resolvedUrl, scrapeResult.html)
        .catch((err) => {
          throw tagError(err, WorkerErrorCode.ParseFailed);
        });

      // Enrich with total pipeline duration
      const totalDurationMs = Date.now() - startMs;
      const enriched: ParseResultMessage = { ...parseResult, totalDurationMs };

      // Produce to output
      await this.producer
        .send(this.config.topics.outputTopic, [
          { key: taskId, value: JSON.stringify(enriched) },
        ])
        .catch((err) => {
          throw tagError(err, WorkerErrorCode.KafkaProduceError);
        });

      this.metrics.incProduced(this.config.topics.outputTopic);
      this.metrics.observeDuration(totalDurationMs);
      this.logger.info("worker.message_processed", taskId, {
        durationMs: totalDurationMs,
        offset: message.offset,
      });
    } catch (err) {
      const errorCode = getErrorCode(err);
      this.logger.errorFromException("worker.processing_error", err, taskId, errorCode);
      this.metrics.incError(errorCode);

      if (attempt < this.config.retry.maxRetries) {
        await this.retry(request, errorCode);
      } else {
        await this.sendToDeadLetter(
          message,
          errorCode,
          err instanceof Error ? err.message : String(err),
          attempt
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Retry
  // ---------------------------------------------------------------------------

  private async retry(
    request: ScrapeRequestMessage,
    errorCode: WorkerErrorCode
  ): Promise<void> {
    const { attempt, taskId } = request;
    const delayMs = Math.min(
      this.config.retry.initialDelayMs *
        Math.pow(this.config.retry.backoffFactor, attempt - 1),
      this.config.retry.maxDelayMs
    );

    this.logger.info("worker.message_retrying", taskId, {
      attempt: attempt + 1,
      maxRetries: this.config.retry.maxRetries,
      delayMs,
      errorCode,
    });

    await sleep(delayMs);

    const retryRequest: ScrapeRequestMessage = { ...request, attempt: attempt + 1 };
    await this.producer
      .send(this.config.topics.inputTopic, [
        { key: taskId, value: JSON.stringify(retryRequest) },
      ])
      .catch((err) => {
        this.logger.errorFromException(
          "worker.retry_produce_failed",
          err,
          taskId,
          WorkerErrorCode.KafkaProduceError
        );
      });
  }

  // ---------------------------------------------------------------------------
  // Dead-letter
  // ---------------------------------------------------------------------------

  private async sendToDeadLetter(
    message: ConsumedMessage,
    errorCode: WorkerErrorCode,
    errorMessage: string,
    attemptCount: number
  ): Promise<void> {
    let taskId = message.key ?? "unknown";
    let url = "";
    try {
      const parsed = JSON.parse(message.value) as Partial<ScrapeRequestMessage>;
      if (parsed.taskId) taskId = parsed.taskId;
      if (parsed.url) url = parsed.url;
    } catch {
      // best-effort — original payload is preserved in DeadLetterMessage
    }

    const dlq: DeadLetterMessage = {
      taskId,
      url,
      errorCode,
      message: errorMessage,
      attemptCount,
      failedAt: new Date().toISOString(),
      originalPayload: message.value,
    };

    try {
      await this.producer.send(this.config.topics.deadLetterTopic, [
        { key: taskId, value: JSON.stringify(dlq) },
      ]);
      this.metrics.incDeadLettered();
      this.logger.warn("worker.message_dead_lettered", taskId, {
        errorCode,
        attemptCount,
      });
    } catch (err) {
      this.logger.errorFromException(
        "worker.dead_letter_produce_failed",
        err,
        taskId,
        WorkerErrorCode.KafkaProduceError
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TaggedError extends Error {
  workerErrorCode: WorkerErrorCode;
}

function tagError(err: unknown, code: WorkerErrorCode): TaggedError {
  const base = err instanceof Error ? err : new Error(String(err));
  return Object.assign(base, { workerErrorCode: code }) as TaggedError;
}

function getErrorCode(err: unknown): WorkerErrorCode {
  if (
    err !== null &&
    typeof err === "object" &&
    "workerErrorCode" in err &&
    typeof (err as Record<string, unknown>)["workerErrorCode"] === "string"
  ) {
    return (err as TaggedError).workerErrorCode;
  }
  return WorkerErrorCode.UnknownError;
}
