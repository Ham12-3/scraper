import { LogLevel, StructuredLogEntry, WorkerErrorCode } from "./types";

export class Logger {
  private readonly module = "kafka-worker" as const;

  private write(
    level: LogLevel,
    event: string,
    taskId: string | undefined,
    extra: Record<string, unknown>
  ): void {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      taskId,
      event,
      ...extra,
    };
    process.stdout.write(JSON.stringify(entry) + "\n");
  }

  debug(event: string, taskId?: string, extra?: Record<string, unknown>): void {
    this.write(LogLevel.Debug, event, taskId, extra ?? {});
  }

  info(event: string, taskId?: string, extra?: Record<string, unknown>): void {
    this.write(LogLevel.Info, event, taskId, extra ?? {});
  }

  warn(event: string, taskId?: string, extra?: Record<string, unknown>): void {
    this.write(LogLevel.Warn, event, taskId, extra ?? {});
  }

  error(event: string, taskId?: string, extra?: Record<string, unknown>): void {
    this.write(LogLevel.Error, event, taskId, extra ?? {});
  }

  errorFromException(
    event: string,
    err: unknown,
    taskId?: string,
    errorCode?: WorkerErrorCode,
    extra?: Record<string, unknown>
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    this.write(LogLevel.Error, event, taskId, {
      message,
      stack,
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(extra ?? {}),
    });
  }
}
