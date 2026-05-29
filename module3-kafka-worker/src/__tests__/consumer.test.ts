import { KafkaConsumer } from "../consumer";
import { KafkaConfig } from "../types";
import { Logger } from "../logger";

// Mock kafkajs so no real broker connection is made
jest.mock("kafkajs", () => {
  const mockConsumer = {
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return {
    Kafka: jest.fn().mockImplementation(() => ({
      consumer: jest.fn().mockReturnValue(mockConsumer),
    })),
  };
});

function makeConfig(): KafkaConfig {
  return {
    brokers: ["localhost:9092"],
    clientId: "test-client",
    groupId: "test-group",
    ssl: false,
    sasl: undefined,
    connectionTimeoutMs: 3000,
    requestTimeoutMs: 30000,
  };
}

function getInnerConsumer() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Kafka } = require("kafkajs") as { Kafka: jest.Mock };
  const kafkaInstance = Kafka.mock.results[Kafka.mock.results.length - 1]!.value as {
    consumer: jest.Mock;
  };
  return kafkaInstance.consumer.mock.results[
    kafkaInstance.consumer.mock.results.length - 1
  ]!.value as {
    connect: jest.Mock;
    subscribe: jest.Mock;
    run: jest.Mock;
    disconnect: jest.Mock;
  };
}

describe("KafkaConsumer", () => {
  it("connect delegates to kafkajs consumer", async () => {
    const c = new KafkaConsumer(makeConfig(), new Logger());
    await c.connect();
    expect(getInnerConsumer().connect).toHaveBeenCalled();
  });

  it("subscribe passes topic and fromBeginning", async () => {
    const c = new KafkaConsumer(makeConfig(), new Logger());
    await c.connect();
    await c.subscribe(["my-topic"], true);
    expect(getInnerConsumer().subscribe).toHaveBeenCalledWith({
      topic: "my-topic",
      fromBeginning: true,
    });
  });

  it("subscribe iterates multiple topics", async () => {
    const c = new KafkaConsumer(makeConfig(), new Logger());
    await c.connect();
    await c.subscribe(["t1", "t2"], false);
    const inner = getInnerConsumer();
    expect(inner.subscribe).toHaveBeenCalledTimes(2);
  });

  it("run calls kafkajs consumer.run", async () => {
    const c = new KafkaConsumer(makeConfig(), new Logger());
    await c.connect();
    const handler = jest.fn();
    await c.run(handler);
    expect(getInnerConsumer().run).toHaveBeenCalled();
  });

  it("disconnect delegates to kafkajs consumer", async () => {
    const c = new KafkaConsumer(makeConfig(), new Logger());
    await c.connect();
    await c.disconnect();
    expect(getInnerConsumer().disconnect).toHaveBeenCalled();
  });
});
