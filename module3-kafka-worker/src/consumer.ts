import { Consumer, Kafka } from "kafkajs";

import { Logger } from "./logger";
import { ConsumedMessage, IConsumer, KafkaConfig } from "./types";

export class KafkaConsumer implements IConsumer {
  private readonly consumer: Consumer;
  private readonly logger: Logger;

  constructor(config: KafkaConfig, logger: Logger) {
    this.logger = logger;
    const kafka = new Kafka({
      clientId: config.clientId,
      brokers: config.brokers,
      ssl: config.ssl,
      // Our KafkaSaslConfig fields are a structural subset of kafkajs SASLOptions
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sasl: config.sasl as any,
      connectionTimeout: config.connectionTimeoutMs,
      requestTimeout: config.requestTimeoutMs,
    });
    this.consumer = kafka.consumer({ groupId: config.groupId });
  }

  async connect(): Promise<void> {
    await this.consumer.connect();
    this.logger.info("consumer.connected");
  }

  async subscribe(topics: string[], fromBeginning: boolean): Promise<void> {
    for (const topic of topics) {
      await this.consumer.subscribe({ topic, fromBeginning });
      this.logger.info("consumer.subscribed", undefined, { topic });
    }
  }

  async run(handler: (message: ConsumedMessage) => Promise<void>): Promise<void> {
    await this.consumer.run({
      // eachMessage is awaited before the next message is fetched from the
      // same partition, giving us at-least-once delivery with natural backpressure.
      eachMessage: async ({ topic, partition, message }) => {
        const consumed: ConsumedMessage = {
          topic,
          partition,
          offset: message.offset,
          key: message.key?.toString() ?? undefined,
          value: message.value?.toString() ?? "",
          timestamp: Number(message.timestamp),
        };
        await handler(consumed);
      },
    });
  }

  async disconnect(): Promise<void> {
    await this.consumer.disconnect();
    this.logger.info("consumer.disconnected");
  }
}
