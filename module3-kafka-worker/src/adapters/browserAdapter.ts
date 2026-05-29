import { BrowserCluster } from "@scraper/browser-controller";
import type { ScrapeRequest } from "@scraper/browser-controller";

import {
  IScraperPort,
  ScrapeRequestMessage,
  ScrapeResultInternal,
} from "../types";

export class BrowserAdapter implements IScraperPort {
  constructor(private readonly cluster: BrowserCluster) {}

  async scrape(msg: ScrapeRequestMessage): Promise<ScrapeResultInternal> {
    const req: ScrapeRequest = {
      taskId: msg.taskId,
      url: msg.url,
      ...(msg.waitForSelectors !== undefined
        ? { waitForSelectors: msg.waitForSelectors }
        : {}),
      ...(msg.scrollPage !== undefined ? { scrollPage: msg.scrollPage } : {}),
    };

    const result = await this.cluster.scrape(req);

    return {
      taskId: result.taskId,
      url: result.url,
      resolvedUrl: result.resolvedUrl,
      html: result.html,
      statusCode: result.statusCode,
      durationMs: result.durationMs,
      scrapedAt: result.extractedAt,
    };
  }
}
