/**
 * All type contracts for the Kafka Worker.
 * No logic. No defaults. Pure interface definitions.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum WorkerStatus {
  Idle = "idle",
  Processing = "processing",
  ShuttingDown = "shutting_down",
  Stopped = "stopped",
}

export enum MessagePriority {
  Low = "low",
  Normal = "normal",
  High = "high",
}

export enum WorkerErrorCode {
  ScrapeFailed = "SCRAPE_FAILED",
  ParseFailed = "PARSE_FAILED",
  KafkaProduceError = "KAFKA_PRODUCE_ERROR",
  KafkaConsumeError = "KAFKA_CONSUME_ERROR",
  SerializationError = "SERIALIZATION_ERROR",
  MaxRetriesExceeded = "MAX_RETRIES_EXCEEDED",
  ShutdownTimeout = "SHUTDOWN_TIMEOUT",
  UnknownError = "UNKNOWN_ERROR",
}

export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

// ---------------------------------------------------------------------------
// Configuration (all values injected from env — never hardcoded)
// ---------------------------------------------------------------------------

export interface KafkaSaslConfig {
  mechanism: "plain" | "scram-sha-256" | "scram-sha-512";
  username: string;
  password: string;
}

export interface KafkaConfig {
  /** Comma-separated or array of broker addresses, e.g. ["broker:9092"] */
  brokers: string[];
  clientId: string;
  groupId: string;
  /** Whether to use TLS for broker connections */
  ssl: boolean;
  sasl: KafkaSaslConfig | undefined;
  /** Connection timeout in ms */
  connectionTimeoutMs: number;
  /** Request timeout in ms */
  requestTimeoutMs: number;
}

export interface TopicConfig {
  /** Incoming scrape-request messages */
  inputTopic: string;
  /** Successfully parsed job postings published here */
  outputTopic: string;
  /** Messages that exceeded max retries are routed here */
  deadLetterTopic: string;
  /** Consumer group seek-to-beginning on first run */
  fromBeginning: boolean;
}

export interface RetryConfig {
  /** Maximum number of processing attempts before dead-lettering */
  maxRetries: number;
  /** Initial delay before the first retry in ms */
  initialDelayMs: number;
  /** Multiplicative backoff factor applied on each successive retry */
  backoffFactor: number;
  /** Upper bound on retry delay in ms */
  maxDelayMs: number;
}

export interface MetricsConfig {
  /** Port the Prometheus /metrics endpoint listens on */
  port: number;
  /** HTTP path for the metrics endpoint */
  path: string;
}

export interface WorkerConfig {
  kafka: KafkaConfig;
  topics: TopicConfig;
  retry: RetryConfig;
  metrics: MetricsConfig;
  /** Maximum number of messages processed concurrently */
  concurrency: number;
  /** Milliseconds to wait for in-flight messages to drain on SIGTERM */
  shutdownTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Kafka message payloads
// ---------------------------------------------------------------------------

/** Written to the input topic by upstream producers (e.g. a URL scheduler). */
export interface ScrapeRequestMessage {
  /** Unique task identifier — propagated through every downstream message */
  taskId: string;
  url: string;
  priority: MessagePriority;
  /** 1-based attempt counter; set to 1 on first enqueue, incremented on retry */
  attempt: number;
  /** ISO 8601 timestamp when the message was first enqueued */
  enqueuedAt: string;
  /** Optional CSS selectors Module 1 should wait for before capturing HTML */
  waitForSelectors?: string[];
  /** If true, Module 1 simulates human scrolling before extraction */
  scrollPage?: boolean;
}

/**
 * Enriched result after Module 1 scrapes the URL.
 * Passed internally to Module 2 — never written to Kafka directly.
 */
export interface ScrapeResultInternal {
  taskId: string;
  url: string;
  resolvedUrl: string;
  html: string;
  statusCode: number;
  durationMs: number;
  scrapedAt: string;
}

/** Written to the output topic after successful scrape + parse. */
export interface ParseResultMessage {
  taskId: string;
  url: string;
  resolvedUrl: string;
  /** Normalised job posting fields (mirrors Module 2's NormalisedJobPosting) */
  jobTitle: string;
  jobFunction: string;
  companyName: string;
  locationCity: string | undefined;
  locationCountry: string | undefined;
  skills: string[];
  seniorityLevel: string;
  postedDate: string | undefined;
  /** Which Module 2 strategy produced this result */
  extractionStrategy: string;
  /** ISO 8601 timestamp when the full pipeline completed */
  processedAt: string;
  /** Total wall-clock time from message receipt to publish (ms) */
  totalDurationMs: number;
}

/** Written to the dead-letter topic when all retries are exhausted. */
export interface DeadLetterMessage {
  taskId: string;
  url: string;
  errorCode: WorkerErrorCode;
  message: string;
  /** 1-based count of attempts made before dead-lettering */
  attemptCount: number;
  /** ISO 8601 timestamp of the final failure */
  failedAt: string;
  /** Original raw Kafka message value (stringified) for forensic replay */
  originalPayload: string;
}

// ---------------------------------------------------------------------------
// Metrics snapshot (returned by IWorkerMetrics.snapshot())
// ---------------------------------------------------------------------------

export interface WorkerMetricsSnapshot {
  messagesConsumed: number;
  messagesProduced: number;
  messagesDeadLettered: number;
  processingErrors: number;
  activeWorkers: number;
  /** Average end-to-end processing time over the last collection window (ms) */
  avgProcessingDurationMs: number;
  /** Current consumer group lag across all partitions */
  consumerLagTotal: number;
}

// ---------------------------------------------------------------------------
// Structured log payload
// ---------------------------------------------------------------------------

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  module: "kafka-worker";
  taskId: string | undefined;
  event: string;
  durationMs?: number;
  errorCode?: WorkerErrorCode;
  message?: string;
  attempt?: number;
  topic?: string;
  partition?: number;
  offset?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Interfaces (structural contracts for dependency injection / testing)
// ---------------------------------------------------------------------------

export interface IConsumer {
  /** Connect to the broker and join the consumer group */
  connect(): Promise<void>;
  /** Subscribe to topics defined in TopicConfig */
  subscribe(topics: string[], fromBeginning: boolean): Promise<void>;
  /**
   * Begin consuming. The handler is called once per message.
   * The consumer handles offset commits internally after the handler resolves.
   */
  run(handler: (message: ConsumedMessage) => Promise<void>): Promise<void>;
  /** Stop consuming and disconnect from the broker */
  disconnect(): Promise<void>;
}

export interface IProducer {
  /** Connect to the broker */
  connect(): Promise<void>;
  /** Publish a batch of messages to a topic */
  send(topic: string, messages: ProducerMessage[]): Promise<void>;
  /** Flush in-flight sends and disconnect */
  disconnect(): Promise<void>;
}

export interface IWorkerMetrics {
  /** Increment the messages-consumed counter */
  incConsumed(topic: string): void;
  /** Increment the messages-produced counter */
  incProduced(topic: string): void;
  /** Increment the dead-letter counter */
  incDeadLettered(): void;
  /** Increment the processing-error counter */
  incError(errorCode: WorkerErrorCode): void;
  /** Record an end-to-end processing duration */
  observeDuration(durationMs: number): void;
  /** Update the active-worker gauge */
  setActiveWorkers(count: number): void;
  /** Update the consumer lag gauge */
  setConsumerLag(lag: number): void;
  /** Return a point-in-time snapshot of all counters */
  snapshot(): WorkerMetricsSnapshot;
  /** Return the Prometheus text exposition format for /metrics */
  getMetricsText(): Promise<string>;
}

export interface IWorker {
  /** Start consuming and processing messages */
  start(): Promise<void>;
  /** Drain in-flight work and cleanly shut down */
  stop(): Promise<void>;
  /** Current operational status */
  getStatus(): WorkerStatus;
  /** Point-in-time metrics snapshot */
  getMetrics(): WorkerMetricsSnapshot;
}

// ---------------------------------------------------------------------------
// Internal primitives used by IConsumer / IProducer implementations
// ---------------------------------------------------------------------------

export interface ConsumedMessage {
  topic: string;
  partition: number;
  offset: string;
  /** Raw message key (may be null if the producer sent no key) */
  key: string | undefined;
  /** Raw UTF-8 message value */
  value: string;
  /** Kafka message timestamp in ms since epoch */
  timestamp: number;
}

export interface ProducerMessage {
  /** Optional partition key for consistent routing */
  key?: string;
  /** Message body — must be serialised to a string before passing here */
  value: string;
}

// ---------------------------------------------------------------------------
// Adapter ports (injected into KafkaWorker for scraping and parsing)
// ---------------------------------------------------------------------------

/** Implemented by a Module 1 adapter — takes a request, returns scraped HTML. */
export interface IScraperPort {
  scrape(request: ScrapeRequestMessage): Promise<ScrapeResultInternal>;
}

/** Implemented by a Module 2 adapter — takes HTML, returns a parse result. */
export interface IParserPort {
  parse(taskId: string, url: string, html: string): Promise<ParseResultMessage>;
}
