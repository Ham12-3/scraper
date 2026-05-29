import { KafkaProducer } from "../producer";
import { KafkaConfig } from "../types";
import { Logger } from "../logger";

jest.mock("kafkajs", () => {
  const mockProducer = {
    connect: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return {
    Kafka: jest.fn().mockImplementation(() => ({
      producer: jest.fn().mockReturnValue(mockProducer),
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

function getInnerProducer() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Kafka } = require("kafkajs") as { Kafka: jest.Mock };
  const kafkaInstance = Kafka.mock.results[Kafka.mock.results.length - 1]!.value as {
    producer: jest.Mock;
  };
  return kafkaInstance.producer.mock.results[
    kafkaInstance.producer.mock.results.length - 1
  ]!.value as {
    connect: jest.Mock;
    send: jest.Mock;
    disconnect: jest.Mock;
  };
}

describe("KafkaProducer", () => {
  it("connect delegates to kafkajs producer", async () => {
    const p = new KafkaProducer(makeConfig(), new Logger());
    await p.connect();
    expect(getInnerProducer().connect).toHaveBeenCalled();
  });

  it("send serialises messages to the correct topic", async () => {
    const p = new KafkaProducer(makeConfig(), new Logger());
    await p.connect();
    await p.send("my-topic", [{ key: "k1", value: '{"a":1}' }]);
    const inner = getInnerProducer();
    expect(inner.send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "my-topic",
        messages: expect.arrayContaining([
          expect.objectContaining({ key: "k1", value: '{"a":1}' }),
        ]),
      })
    );
  });

  it("send converts undefined key to null", async () => {
    const p = new KafkaProducer(makeConfig(), new Logger());
    await p.connect();
    await p.send("t", [{ value: "v" }]);
    const call = getInnerProducer().send.mock.calls[0][0] as {
      messages: { key: null | string; value: string }[];
    };
    expect(call.messages[0]!.key).toBeNull();
  });

  it("send handles multiple messages in one call", async () => {
    const p = new KafkaProducer(makeConfig(), new Logger());
    await p.connect();
    await p.send("t", [
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
    const inner = getInnerProducer();
    const sent = inner.send.mock.calls[0][0] as { messages: unknown[] };
    expect(sent.messages).toHaveLength(2);
  });

  it("disconnect delegates to kafkajs producer", async () => {
    const p = new KafkaProducer(makeConfig(), new Logger());
    await p.connect();
    await p.disconnect();
    expect(getInnerProducer().disconnect).toHaveBeenCalled();
  });
});
