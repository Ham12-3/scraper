import { loadConfig } from "../configLoader";

function baseEnv(): Record<string, string> {
  return {
    KAFKA_BROKERS: "broker1:9092,broker2:9092",
    KAFKA_CLIENT_ID: "scraper-worker",
    KAFKA_GROUP_ID: "scraper-group",
    KAFKA_SSL: "false",
    KAFKA_CONNECTION_TIMEOUT_MS: "3000",
    KAFKA_REQUEST_TIMEOUT_MS: "30000",
    KAFKA_TOPIC_INPUT: "scrape-requests",
    KAFKA_TOPIC_OUTPUT: "parse-results",
    KAFKA_TOPIC_DEAD_LETTER: "scrape-dlq",
    KAFKA_FROM_BEGINNING: "false",
    RETRY_MAX_RETRIES: "3",
    RETRY_INITIAL_DELAY_MS: "500",
    RETRY_BACKOFF_FACTOR: "2.0",
    RETRY_MAX_DELAY_MS: "30000",
    METRICS_PORT: "9090",
    METRICS_PATH: "/metrics",
    WORKER_CONCURRENCY: "5",
    WORKER_SHUTDOWN_TIMEOUT_MS: "10000",
  };
}

function withEnv(
  vars: Record<string, string>,
  fn: () => void
): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function withoutEnv(
  vars: Record<string, string>,
  omit: string,
  fn: () => void
): void {
  const patched = { ...vars };
  delete patched[omit];
  const saved = process.env[omit];
  delete process.env[omit];
  withEnv(patched, fn);
  if (saved !== undefined) process.env[omit] = saved;
}

describe("loadConfig", () => {
  it("returns a valid WorkerConfig from env", () => {
    withEnv(baseEnv(), () => {
      const cfg = loadConfig();
      expect(cfg.kafka.brokers).toEqual(["broker1:9092", "broker2:9092"]);
      expect(cfg.kafka.clientId).toBe("scraper-worker");
      expect(cfg.kafka.groupId).toBe("scraper-group");
      expect(cfg.kafka.ssl).toBe(false);
      expect(cfg.kafka.sasl).toBeUndefined();
      expect(cfg.topics.inputTopic).toBe("scrape-requests");
      expect(cfg.topics.outputTopic).toBe("parse-results");
      expect(cfg.topics.deadLetterTopic).toBe("scrape-dlq");
      expect(cfg.retry.maxRetries).toBe(3);
      expect(cfg.retry.backoffFactor).toBe(2.0);
      expect(cfg.metrics.port).toBe(9090);
      expect(cfg.concurrency).toBe(5);
    });
  });

  it("loads SASL plain config when present", () => {
    withEnv(
      {
        ...baseEnv(),
        KAFKA_SASL_MECHANISM: "plain",
        KAFKA_SASL_USERNAME: "user",
        KAFKA_SASL_PASSWORD: "pass",
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.kafka.sasl).toEqual({
          mechanism: "plain",
          username: "user",
          password: "pass",
        });
      }
    );
  });

  it("throws on unknown SASL mechanism", () => {
    withEnv(
      {
        ...baseEnv(),
        KAFKA_SASL_MECHANISM: "oauthbearer",
        KAFKA_SASL_USERNAME: "u",
        KAFKA_SASL_PASSWORD: "p",
      },
      () => {
        expect(() => loadConfig()).toThrow("KAFKA_SASL_MECHANISM");
      }
    );
  });

  it("throws when a required variable is missing", () => {
    const env = baseEnv();
    delete env["KAFKA_BROKERS"];
    const saved = process.env["KAFKA_BROKERS"];
    delete process.env["KAFKA_BROKERS"];
    withEnv(env, () => {
      expect(() => loadConfig()).toThrow("KAFKA_BROKERS");
    });
    if (saved !== undefined) process.env["KAFKA_BROKERS"] = saved;
  });

  it("throws on non-integer METRICS_PORT", () => {
    withEnv({ ...baseEnv(), METRICS_PORT: "not-a-port" }, () => {
      expect(() => loadConfig()).toThrow("METRICS_PORT");
    });
  });

  it("throws on non-numeric RETRY_BACKOFF_FACTOR", () => {
    withEnv({ ...baseEnv(), RETRY_BACKOFF_FACTOR: "fast" }, () => {
      expect(() => loadConfig()).toThrow("RETRY_BACKOFF_FACTOR");
    });
  });

  it("throws on invalid KAFKA_SSL value", () => {
    withEnv({ ...baseEnv(), KAFKA_SSL: "yes" }, () => {
      expect(() => loadConfig()).toThrow("KAFKA_SSL");
    });
  });

  it("parses KAFKA_FROM_BEGINNING true correctly", () => {
    withEnv({ ...baseEnv(), KAFKA_FROM_BEGINNING: "true" }, () => {
      expect(loadConfig().topics.fromBeginning).toBe(true);
    });
  });
});
