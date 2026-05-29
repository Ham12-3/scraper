import { Kafka, Producer } from "kafkajs";

import { Logger } from "./logger";
import { IProducer, KafkaConfig, ProducerMessage } from "./types";

export class KafkaProducer implements IProducer {
  private readonly producer: Producer;
  private readonly logger: Logger;

  constructor(config: KafkaConfig, logger: Logger) {
    this.logger = logger;
    const kafka = new Kafka({
      clientId: `${config.clientId}-producer`,
      brokers: config.brokers,
      ssl: config.ssl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sasl: config.sasl as any,
      connectionTimeout: config.connectionTimeoutMs,
      requestTimeout: config.requestTimeoutMs,
    });
    this.producer = kafka.producer({
      // Idempotent producer: exactly-once produce semantics within a session
      idempotent: true,
    });
  }

  async connect(): Promise<void> {
    await this.producer.connect();
    this.logger.info("producer.connected");
  }

  async send(topic: string, messages: ProducerMessage[]): Promise<void> {
    await this.producer.send({
      topic,
      messages: messages.map((m) => ({
        // kafkajs expects null, not undefined, for absent keys
        key: m.key ?? null,
        value: m.value,
      })),
    });
    this.logger.debug("producer.sent", undefined, {
      topic,
      count: messages.length,
    });
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
    this.logger.info("producer.disconnected");
  }
}
