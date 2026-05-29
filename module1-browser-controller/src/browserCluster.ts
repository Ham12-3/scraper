import { Browser, BrowserContext, chromium, Page } from "playwright";
import {
  BrowserControllerConfig,
  BrowserStatus,
  IBrowserCluster,
  ScrapeError,
  ScrapeErrorCode,
  ScrapeRequest,
  ScrapeResult,
  WorkerSlot,
} from "./types";
import { HumanMimicry } from "./humanMimicry";
import { Logger } from "./logger";
import { ResourceFilter } from "./resourceFilter";
import { Semaphore } from "./semaphore";
import { StealthInjector } from "./stealth";
import { randomUUID } from "crypto";

export class BrowserCluster implements IBrowserCluster {
  private browser: Browser | null = null;
  private readonly semaphore: Semaphore;
  private readonly slots: Map<string, WorkerSlot> = new Map();
  private readonly stealthInjector: StealthInjector;
  private readonly humanMimicry: HumanMimicry;
  private readonly resourceFilter: ResourceFilter;
  private readonly logger: Logger;
  private userAgentIndex = 0;

  constructor(private readonly config: BrowserControllerConfig) {
    this.logger = new Logger();
    this.semaphore = new Semaphore(config.cluster.maxWorkers);
    this.stealthInjector = new StealthInjector(config.stealth, this.logger);
    this.humanMimicry = new HumanMimicry(config.humanMimicry);
    this.resourceFilter = new ResourceFilter(config.resourceFilter, this.logger);

    for (let i = 0; i < config.cluster.maxWorkers; i++) {
      const id = `worker-${i}`;
      this.slots.set(id, {
        workerId: id,
        status: BrowserStatus.Idle,
        lastAssignedAt: undefined,
        currentTaskId: undefined,
      });
    }
  }

  async init(): Promise<void> {
    if (this.browser !== null) {
      throw new Error("BrowserCluster.init() called on an already-initialised cluster");
    }

    this.logger.info("cluster.init.start");

    const args = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", /* required in Docker */
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--window-size=1920,1080",
      "--disable-extensions",
      ...this.config.cluster.extraArgs,
    ];

    try {
      this.browser = await chromium.launch({
        headless: this.config.cluster.headless,
        ...(this.config.cluster.executablePath !== undefined
          ? { executablePath: this.config.cluster.executablePath }
          : {}),
        args,
        timeout: this.config.cluster.launchTimeoutMs,
      });
    } catch (err) {
      this.logger.errorFromException("cluster.launch.failed", err);
      throw err;
    }

    this.browser.on("disconnected", () => {
      this.logger.error("cluster.browser.disconnected");
      this.browser = null;
    });

    this.logger.info("cluster.init.complete", undefined, {
      maxWorkers: this.config.cluster.maxWorkers,
    });
  }

  async scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    if (!this.browser) {
      throw this.buildError(
        request,
        ScrapeErrorCode.UnknownError,
        new Error("BrowserCluster.init() was not called"),
        0
      );
    }

    await this.semaphore.acquire();
    const slotId = this.claimSlot(request.taskId);
    const start = Date.now();

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      this.logger.info("scrape.start", request.taskId, { url: request.url });

      const userAgent = this.nextUserAgent();
      context = await this.openContext(request, userAgent);
      page = await context.newPage();

      await this.stealthInjector.inject(page, userAgent);
      this.resourceFilter.attach(page);

      if (request.extraHeaders && Object.keys(request.extraHeaders).length > 0) {
        await page.setExtraHTTPHeaders(request.extraHeaders);
      }

      this.updateSlot(slotId, BrowserStatus.Navigating);

      let statusCode = 0;
      const response = await page
        .goto(request.url, {
          timeout: this.config.cluster.navigationTimeoutMs,
          waitUntil: "domcontentloaded",
        })
        .catch((err: unknown) => {
          throw this.buildError(
            request,
            this.classifyPlaywrightError(err),
            err instanceof Error ? err : new Error(String(err)),
            1
          );
        });

      statusCode = response?.status() ?? 0;

      if (statusCode >= 400) {
        throw this.buildError(
          request,
          ScrapeErrorCode.HTTPError,
          new Error(`HTTP ${statusCode}`),
          1
        );
      }

      if (request.waitForSelectors && request.waitForSelectors.length > 0) {
        this.updateSlot(slotId, BrowserStatus.Extracting);
        for (const selector of request.waitForSelectors) {
          await page
            .waitForSelector(selector, {
              timeout: this.config.cluster.navigationTimeoutMs,
            })
            .catch((err: unknown) => {
              throw this.buildError(
                request,
                ScrapeErrorCode.ElementTimeout,
                err instanceof Error ? err : new Error(String(err)),
                1
              );
            });
        }
      }

      if (request.scrollPage) {
        const scrollHeight = await page.evaluate('document.body.scrollHeight') as number;
        await this.humanMimicry.scrollDown(page, scrollHeight);
      }

      this.updateSlot(slotId, BrowserStatus.Extracting);
      const html = await page.content();
      const resolvedUrl = page.url();
      const durationMs = Date.now() - start;

      const result: ScrapeResult = {
        taskId: request.taskId,
        url: request.url,
        html,
        resolvedUrl,
        statusCode,
        durationMs,
        extractedAt: new Date().toISOString(),
      };

      this.logger.info("scrape.complete", request.taskId, {
        url: request.url,
        resolvedUrl,
        statusCode,
        durationMs,
        htmlLength: html.length,
      });

      return result;
    } catch (err) {
      const scrapeErr =
        this.isScrapeError(err)
          ? err
          : this.buildError(
              request,
              ScrapeErrorCode.UnknownError,
              err instanceof Error ? err : new Error(String(err)),
              1
            );

      this.logger.errorFromException(
        "scrape.failed",
        err,
        request.taskId,
        scrapeErr.errorCode,
        { url: request.url, durationMs: Date.now() - start }
      );

      this.updateSlot(slotId, BrowserStatus.Error);
      throw scrapeErr;
    } finally {
      if (page) await page.close().catch(() => undefined);
      if (context) await context.close().catch(() => undefined);
      this.releaseSlot(slotId);
      this.semaphore.release();
    }
  }

  async shutdown(): Promise<void> {
    this.logger.info("cluster.shutdown.start");
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.logger.info("cluster.shutdown.complete");
  }

  getWorkerStatus(): WorkerSlot[] {
    return [...this.slots.values()];
  }

  /* ── Private helpers ──────────────────────────────────────────────────── */

  private async openContext(
    request: ScrapeRequest,
    userAgent: string
  ): Promise<BrowserContext> {
    const proxy = request.proxy;
    return (this.browser as Browser).newContext({
      userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
      ...(proxy
        ? {
            proxy: {
              server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
              username: proxy.username,
              password: proxy.password,
            },
          }
        : {}),
    });
  }

  private nextUserAgent(): string {
    const agents = this.config.stealth.userAgents;
    if (agents.length === 0) {
      throw new Error("StealthConfig.userAgents list is empty");
    }
    const ua = agents[this.userAgentIndex % agents.length];
    this.userAgentIndex++;
    return ua as string;
  }

  private claimSlot(taskId: string): string {
    for (const [id, slot] of this.slots) {
      if (slot.status === BrowserStatus.Idle) {
        this.slots.set(id, {
          ...slot,
          status: BrowserStatus.Navigating,
          lastAssignedAt: new Date().toISOString(),
          currentTaskId: taskId,
        });
        return id;
      }
    }
    /* Semaphore guarantees a free slot exists at this point */
    const id = `worker-overflow-${randomUUID()}`;
    this.slots.set(id, {
      workerId: id,
      status: BrowserStatus.Navigating,
      lastAssignedAt: new Date().toISOString(),
      currentTaskId: taskId,
    });
    return id;
  }

  private updateSlot(slotId: string, status: BrowserStatus): void {
    const slot = this.slots.get(slotId);
    if (slot) {
      this.slots.set(slotId, { ...slot, status });
    }
  }

  private releaseSlot(slotId: string): void {
    const slot = this.slots.get(slotId);
    if (slot) {
      this.slots.set(slotId, {
        ...slot,
        status: BrowserStatus.Idle,
        currentTaskId: undefined,
      });
    }
  }

  private classifyPlaywrightError(err: unknown): ScrapeErrorCode {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Timeout") || msg.includes("timeout")) {
      return ScrapeErrorCode.NavigationTimeout;
    }
    if (msg.includes("net::ERR_PROXY") || msg.includes("407")) {
      return ScrapeErrorCode.ProxyAuthFailure;
    }
    if (msg.includes("Page crashed") || msg.includes("Target closed")) {
      return ScrapeErrorCode.PageCrash;
    }
    return ScrapeErrorCode.UnknownError;
  }

  private buildError(
    request: ScrapeRequest,
    errorCode: ScrapeErrorCode,
    err: Error,
    attemptCount: number
  ): ScrapeError {
    return {
      taskId: request.taskId,
      url: request.url,
      errorCode,
      message: err.message,
      stack: err.stack,
      attemptCount,
    };
  }

  private isScrapeError(val: unknown): val is ScrapeError {
    return (
      typeof val === "object" &&
      val !== null &&
      "errorCode" in val &&
      "taskId" in val
    );
  }
}
