import { IParserPort, ParseResultMessage } from "../types";

export class HttpParserAdapter implements IParserPort {
  constructor(private readonly baseUrl: string) {}

  async parse(
    taskId: string,
    url: string,
    html: string
  ): Promise<ParseResultMessage> {
    const response = await fetch(`${this.baseUrl}/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId, url, html }),
    });

    if (!response.ok) {
      throw new Error(`Parser service returned HTTP ${response.status} for task ${taskId}`);
    }

    const data = (await response.json()) as Record<string, unknown>;

    if ("error" in data) {
      throw new Error(`Parser rejected task ${taskId}: ${String(data["message"])}`);
    }

    return data as unknown as ParseResultMessage;
  }
}
