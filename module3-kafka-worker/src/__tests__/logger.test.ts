import { Logger } from "../logger";
import { WorkerErrorCode } from "../types";

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

function lastEntry(output: string): Record<string, unknown> {
  const lines = output.split("\n").filter((l) => l.trim());
  return JSON.parse(lines[lines.length - 1]!);
}

describe("Logger", () => {
  it("writes valid JSON to stdout", () => {
    const out = captureStdout(() =>
      new Logger().info("test.event", "task-1")
    );
    const entry = lastEntry(out);
    expect(entry["event"]).toBe("test.event");
    expect(entry["taskId"]).toBe("task-1");
    expect(entry["level"]).toBe("info");
    expect(entry["module"]).toBe("kafka-worker");
    expect(typeof entry["timestamp"]).toBe("string");
  });

  it("debug level", () => {
    const out = captureStdout(() => new Logger().debug("d"));
    expect(lastEntry(out)["level"]).toBe("debug");
  });

  it("warn level", () => {
    const out = captureStdout(() => new Logger().warn("w"));
    expect(lastEntry(out)["level"]).toBe("warn");
  });

  it("error level", () => {
    const out = captureStdout(() => new Logger().error("e"));
    expect(lastEntry(out)["level"]).toBe("error");
  });

  it("extra fields are spread into the entry", () => {
    const out = captureStdout(() =>
      new Logger().info("evt", undefined, { durationMs: 42, topic: "t1" })
    );
    const entry = lastEntry(out);
    expect(entry["durationMs"]).toBe(42);
    expect(entry["topic"]).toBe("t1");
  });

  it("errorFromException includes message and stack", () => {
    const err = new Error("something broke");
    const out = captureStdout(() =>
      new Logger().errorFromException("err.event", err, "task-x")
    );
    const entry = lastEntry(out);
    expect(entry["message"]).toBe("something broke");
    expect(typeof entry["stack"]).toBe("string");
    expect(entry["taskId"]).toBe("task-x");
  });

  it("errorFromException includes errorCode when provided", () => {
    const out = captureStdout(() =>
      new Logger().errorFromException(
        "err",
        new Error("x"),
        undefined,
        WorkerErrorCode.ScrapeFailed
      )
    );
    expect(lastEntry(out)["errorCode"]).toBe(WorkerErrorCode.ScrapeFailed);
  });

  it("errorFromException handles non-Error thrown values", () => {
    const out = captureStdout(() =>
      new Logger().errorFromException("err", "raw string error")
    );
    expect(lastEntry(out)["message"]).toBe("raw string error");
  });

  it("taskId is omitted when not provided", () => {
    const out = captureStdout(() => new Logger().info("evt"));
    expect(lastEntry(out)["taskId"]).toBeUndefined();
  });

  it("timestamp is a valid ISO 8601 string", () => {
    const out = captureStdout(() => new Logger().info("evt"));
    const ts = lastEntry(out)["timestamp"] as string;
    expect(() => new Date(ts).toISOString()).not.toThrow();
  });
});
