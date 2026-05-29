import {
  KafkaConfig,
  KafkaSaslConfig,
  MetricsConfig,
  RetryConfig,
  TopicConfig,
  WorkerConfig,
} from "./types";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (val === undefined || val === "") {
    throw new Error(`Required environment variable "${name}" is not set`);
  }
  return val;
}

function optionalEnv(name: string): string | undefined {
  const val = process.env[name];
  return val === "" ? undefined : val;
}

function requireInt(name: string): number {
  const raw = requireEnv(name);
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new RangeError(
      `Environment variable "${name}" must be an integer, got: "${raw}"`
    );
  }
  return parsed;
}

function requireFloat(name: string): number {
  const raw = requireEnv(name);
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) {
    throw new RangeError(
      `Environment variable "${name}" must be a number, got: "${raw}"`
    );
  }
  return parsed;
}

function requireBool(name: string): boolean {
  const raw = requireEnv(name).toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(
    `Environment variable "${name}" must be true/false/1/0, got: "${raw}"`
  );
}

function requireStringList(name: string, separator = ","): string[] {
  const raw = requireEnv(name);
  return raw
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function loadSaslConfig(): KafkaSaslConfig | undefined {
  const mechanism = optionalEnv("KAFKA_SASL_MECHANISM");
  if (mechanism === undefined) return undefined;

  const valid = ["plain", "scram-sha-256", "scram-sha-512"] as const;
  if (!(valid as readonly string[]).includes(mechanism)) {
    throw new Error(
      `Environment variable "KAFKA_SASL_MECHANISM" must be one of [${valid.join(", ")}], got: "${mechanism}"`
    );
  }
  return {
    mechanism: mechanism as KafkaSaslConfig["mechanism"],
    username: requireEnv("KAFKA_SASL_USERNAME"),
    password: requireEnv("KAFKA_SASL_PASSWORD"),
  };
}

function loadKafkaConfig(): KafkaConfig {
  return {
    brokers: requireStringList("KAFKA_BROKERS"),
    clientId: requireEnv("KAFKA_CLIENT_ID"),
    groupId: requireEnv("KAFKA_GROUP_ID"),
    ssl: requireBool("KAFKA_SSL"),
    sasl: loadSaslConfig(),
    connectionTimeoutMs: requireInt("KAFKA_CONNECTION_TIMEOUT_MS"),
    requestTimeoutMs: requireInt("KAFKA_REQUEST_TIMEOUT_MS"),
  };
}

function loadTopicConfig(): TopicConfig {
  return {
    inputTopic: requireEnv("KAFKA_TOPIC_INPUT"),
    outputTopic: requireEnv("KAFKA_TOPIC_OUTPUT"),
    deadLetterTopic: requireEnv("KAFKA_TOPIC_DEAD_LETTER"),
    fromBeginning: requireBool("KAFKA_FROM_BEGINNING"),
  };
}

function loadRetryConfig(): RetryConfig {
  return {
    maxRetries: requireInt("RETRY_MAX_RETRIES"),
    initialDelayMs: requireInt("RETRY_INITIAL_DELAY_MS"),
    backoffFactor: requireFloat("RETRY_BACKOFF_FACTOR"),
    maxDelayMs: requireInt("RETRY_MAX_DELAY_MS"),
  };
}

function loadMetricsConfig(): MetricsConfig {
  return {
    port: requireInt("METRICS_PORT"),
    path: requireEnv("METRICS_PATH"),
  };
}

/**
 * Reads all required environment variables and returns a fully validated
 * WorkerConfig. Throws descriptively on the first missing or malformed
 * variable — fail-fast at startup, not mid-processing.
 */
export function loadConfig(): WorkerConfig {
  return {
    kafka: loadKafkaConfig(),
    topics: loadTopicConfig(),
    retry: loadRetryConfig(),
    metrics: loadMetricsConfig(),
    concurrency: requireInt("WORKER_CONCURRENCY"),
    shutdownTimeoutMs: requireInt("WORKER_SHUTDOWN_TIMEOUT_MS"),
  };
}
