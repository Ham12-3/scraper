import { WorkerMetrics } from "../metrics";
import { WorkerErrorCode } from "../types";

describe("WorkerMetrics", () => {
  let m: WorkerMetrics;

  beforeEach(() => {
    m = new WorkerMetrics(false);
  });

  it("snapshot starts at all zeros", () => {
    const s = m.snapshot();
    expect(s.messagesConsumed).toBe(0);
    expect(s.messagesProduced).toBe(0);
    expect(s.messagesDeadLettered).toBe(0);
    expect(s.processingErrors).toBe(0);
    expect(s.activeWorkers).toBe(0);
    expect(s.avgProcessingDurationMs).toBe(0);
    expect(s.consumerLagTotal).toBe(0);
  });

  it("incConsumed increments counter", () => {
    m.incConsumed("input-topic");
    m.incConsumed("input-topic");
    expect(m.snapshot().messagesConsumed).toBe(2);
  });

  it("incProduced increments counter", () => {
    m.incProduced("output-topic");
    expect(m.snapshot().messagesProduced).toBe(1);
  });

  it("incDeadLettered increments counter", () => {
    m.incDeadLettered();
    m.incDeadLettered();
    expect(m.snapshot().messagesDeadLettered).toBe(2);
  });

  it("incError increments counter", () => {
    m.incError(WorkerErrorCode.ScrapeFailed);
    m.incError(WorkerErrorCode.ParseFailed);
    expect(m.snapshot().processingErrors).toBe(2);
  });

  it("setActiveWorkers reflects current gauge", () => {
    m.setActiveWorkers(3);
    expect(m.snapshot().activeWorkers).toBe(3);
    m.setActiveWorkers(0);
    expect(m.snapshot().activeWorkers).toBe(0);
  });

  it("setConsumerLag reflects current gauge", () => {
    m.setConsumerLag(1500);
    expect(m.snapshot().consumerLagTotal).toBe(1500);
  });

  it("observeDuration computes correct average", () => {
    m.observeDuration(100);
    m.observeDuration(300);
    expect(m.snapshot().avgProcessingDurationMs).toBe(200);
  });

  it("avgProcessingDurationMs is 0 when no observations", () => {
    expect(m.snapshot().avgProcessingDurationMs).toBe(0);
  });

  it("getMetricsText returns Prometheus exposition format", async () => {
    m.incConsumed("t");
    const text = await m.getMetricsText();
    expect(text).toContain("kafka_worker_messages_consumed_total");
    expect(text).toContain("kafka_worker_processing_duration_ms");
  });
});
