import { KafkaWorker } from "../worker";
import { Logger } from "../logger";
import { WorkerMetrics } from "../metrics";
import {
  ConsumedMessage,
  IConsumer,
  IParserPort,
  IProducer,
  IScraperPort,
  MessagePriority,
  ParseResultMessage,
  ScrapeRequestMessage,
  ScrapeResultInternal,
  WorkerConfig,
  WorkerErrorCode,
  WorkerStatus,
} from "../types";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    kafka: {
      brokers: ["localhost:9092"],
      clientId: "test",
      groupId: "test-group",
      ssl: false,
      sasl: undefined,
      connectionTimeoutMs: 1000,
      requestTimeoutMs: 5000,
    },
    topics: {
      inputTopic: "input",
      outputTopic: "output",
      deadLetterTopic: "dlq",
      fromBeginning: false,
    },
    retry: {
      maxRetries: 3,
      initialDelayMs: 1,     // keep tests fast
      backoffFactor: 1,
      maxDelayMs: 1,
    },
    metrics: { port: 9090, path: "/metrics" },
    concurrency: 1,
    shutdownTimeoutMs: 100,
    ...overrides,
  };
}

function makeConsumer(
  runHandler?: (handler: (m: ConsumedMessage) => Promise<void>) => Promise<void>
): jest.Mocked<IConsumer> {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockImplementation(
      runHandler ?? (() => Promise.resolve())
    ),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
}

function makeProducer(): jest.Mocked<IProducer> {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
}

function makeScraper(result?: ScrapeResultInternal): jest.Mocked<IScraperPort> {
  return {
    scrape: jest.fn().mockResolvedValue(
      result ?? {
        taskId: "t1",
        url: "https://example.com",
        resolvedUrl: "https://example.com",
        html: "<html><body>Job</body></html>",
        statusCode: 200,
        durationMs: 500,
        scrapedAt: new Date().toISOString(),
      }
    ),
  };
}

function makeParseResult(override: Partial<ParseResultMessage> = {}): ParseResultMessage {
  return {
    taskId: "t1",
    url: "https://example.com",
    resolvedUrl: "https://example.com",
    jobTitle: "Engineer",
    jobFunction: "software_engineering",
    companyName: "Acme",
    locationCity: "London",
    locationCountry: "UK",
    skills: ["TypeScript"],
    seniorityLevel: "senior",
    postedDate: undefined,
    extractionStrategy: "css_selectors",
    processedAt: new Date().toISOString(),
    totalDurationMs: 0,
    ...override,
  };
}

function makeParser(result?: ParseResultMessage): jest.Mocked<IParserPort> {
  return {
    parse: jest.fn().mockResolvedValue(result ?? makeParseResult()),
  };
}

function makeMessage(
  request: Partial<ScrapeRequestMessage> = {},
  key?: string
): ConsumedMessage {
  const req: ScrapeRequestMessage = {
    taskId: "t1",
    url: "https://example.com",
    priority: MessagePriority.Normal,
    attempt: 1,
    enqueuedAt: new Date().toISOString(),
    ...request,
  };
  return {
    topic: "input",
    partition: 0,
    offset: "0",
    key: key ?? req.taskId,
    value: JSON.stringify(req),
    timestamp: Date.now(),
  };
}

function makeWorker(
  opts: {
    config?: Partial<WorkerConfig>;
    consumer?: jest.Mocked<IConsumer>;
    producer?: jest.Mocked<IProducer>;
    scraper?: jest.Mocked<IScraperPort>;
    parser?: jest.Mocked<IParserPort>;
  } = {}
): {
  worker: KafkaWorker;
  consumer: jest.Mocked<IConsumer>;
  producer: jest.Mocked<IProducer>;
  scraper: jest.Mocked<IScraperPort>;
  parser: jest.Mocked<IParserPort>;
  metrics: WorkerMetrics;
} {
  const consumer = opts.consumer ?? makeConsumer();
  const producer = opts.producer ?? makeProducer();
  const scraper = opts.scraper ?? makeScraper();
  const parser = opts.parser ?? makeParser();
  const metrics = new WorkerMetrics(false);
  const worker = new KafkaWorker(
    makeConfig(opts.config),
    consumer,
    producer,
    scraper,
    parser,
    metrics,
    new Logger()
  );
  return { worker, consumer, producer, scraper, parser, metrics };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KafkaWorker — initial state", () => {
  it("starts in Idle status", () => {
    const { worker } = makeWorker();
    expect(worker.getStatus()).toBe(WorkerStatus.Idle);
  });

  it("getMetrics returns a zero snapshot before start", () => {
    const { worker } = makeWorker();
    expect(worker.getMetrics().messagesConsumed).toBe(0);
  });
});

describe("KafkaWorker — start/stop", () => {
  it("connects consumer and producer on start", async () => {
    const { worker, consumer, producer } = makeWorker();
    await worker.start();
    expect(consumer.connect).toHaveBeenCalled();
    expect(producer.connect).toHaveBeenCalled();
  });

  it("subscribes to the input topic on start", async () => {
    const { worker, consumer } = makeWorker();
    await worker.start();
    expect(consumer.subscribe).toHaveBeenCalledWith(["input"], false);
  });

  it("stop transitions status to Stopped", async () => {
    const { worker } = makeWorker();
    await worker.start();
    await worker.stop();
    expect(worker.getStatus()).toBe(WorkerStatus.Stopped);
  });

  it("stop disconnects consumer and producer", async () => {
    const { worker, consumer, producer } = makeWorker();
    await worker.start();
    await worker.stop();
    expect(consumer.disconnect).toHaveBeenCalled();
    expect(producer.disconnect).toHaveBeenCalled();
  });
});

describe("KafkaWorker — processMessage happy path", () => {
  it("calls scraper and parser, produces to output topic", async () => {
    const { worker, producer, scraper, parser } = makeWorker();
    await worker.processMessage(makeMessage());

    expect(scraper.scrape).toHaveBeenCalled();
    expect(parser.parse).toHaveBeenCalled();
    expect(producer.send).toHaveBeenCalledWith(
      "output",
      expect.arrayContaining([
        expect.objectContaining({ key: "t1" }),
      ])
    );
  });

  it("increments consumed and produced metrics on success", async () => {
    const { worker, metrics } = makeWorker();
    await worker.processMessage(makeMessage());
    expect(metrics.snapshot().messagesConsumed).toBe(1);
    expect(metrics.snapshot().messagesProduced).toBe(1);
  });

  it("records processing duration on success", async () => {
    const { worker, metrics } = makeWorker();
    await worker.processMessage(makeMessage());
    expect(metrics.snapshot().avgProcessingDurationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("KafkaWorker — processMessage deserialization failure", () => {
  it("sends to DLQ when message value is invalid JSON", async () => {
    const { worker, producer, metrics } = makeWorker();
    const bad: ConsumedMessage = {
      topic: "input", partition: 0, offset: "0",
      key: "t1", value: "{{not json}}", timestamp: Date.now(),
    };
    await worker.processMessage(bad);
    expect(producer.send).toHaveBeenCalledWith("dlq", expect.anything());
    expect(metrics.snapshot().messagesDeadLettered).toBe(1);
    expect(metrics.snapshot().processingErrors).toBe(1);
  });
});

describe("KafkaWorker — retry logic", () => {
  it("re-enqueues to input topic with incremented attempt on scrape failure", async () => {
    const scraper = makeScraper();
    scraper.scrape.mockRejectedValue(new Error("connection refused"));

    const { worker, producer } = makeWorker({ scraper });
    await worker.processMessage(makeMessage({ attempt: 1 }));

    // First call is to input (retry), not DLQ
    const firstCall = producer.send.mock.calls[0]!;
    expect(firstCall[0]).toBe("input");
    const retryMsg = JSON.parse(
      (firstCall[1]![0]! as { value: string }).value
    ) as ScrapeRequestMessage;
    expect(retryMsg.attempt).toBe(2);
  });

  it("sends to DLQ after max retries are exceeded", async () => {
    const scraper = makeScraper();
    scraper.scrape.mockRejectedValue(new Error("always fails"));

    const { worker, producer, metrics } = makeWorker({ scraper });
    // attempt == maxRetries (3), so this is the last attempt
    await worker.processMessage(makeMessage({ attempt: 3 }));

    const lastCall = producer.send.mock.calls[producer.send.mock.calls.length - 1]!;
    expect(lastCall[0]).toBe("dlq");
    expect(metrics.snapshot().messagesDeadLettered).toBe(1);
  });

  it("does not retry on parser failure — same retry path", async () => {
    const parser = makeParser();
    parser.parse.mockRejectedValue(new Error("parse error"));

    const { worker, producer } = makeWorker({ parser });
    await worker.processMessage(makeMessage({ attempt: 1 }));

    const firstCallTopic = producer.send.mock.calls[0]![0];
    expect(firstCallTopic).toBe("input"); // retried, not DLQ
  });
});

describe("KafkaWorker — produce failure", () => {
  it("sends to DLQ when output produce fails and retries exhausted", async () => {
    const producer = makeProducer();
    // first send (to output) throws, DLQ send succeeds
    producer.send
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValue(undefined);

    const { worker, metrics } = makeWorker({
      producer,
      config: { retry: { maxRetries: 1, initialDelayMs: 1, backoffFactor: 1, maxDelayMs: 1 } },
    });

    // attempt == maxRetries (1), so DLQ immediately
    await worker.processMessage(makeMessage({ attempt: 1 }));

    const dlqCalls = producer.send.mock.calls.filter((c) => c[0] === "dlq");
    expect(dlqCalls.length).toBeGreaterThan(0);
    expect(metrics.snapshot().processingErrors).toBe(1);
  });
});
