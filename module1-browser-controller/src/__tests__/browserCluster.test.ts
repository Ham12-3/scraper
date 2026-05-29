import { BrowserCluster } from "../browserCluster";
import {
  BrowserControllerConfig,
  BrowserStatus,
  HumanMimicryConfig,
  ProxyConfig,
  ResourceType,
  ScrapeErrorCode,
  ScrapeRequest,
  StealthProfile,
} from "../types";

/* ── Playwright mock ──────────────────────────────────────────────────────── */

jest.mock("playwright", () => ({
  chromium: { launch: jest.fn() },
}));

import { chromium } from "playwright";

/* ── Factories ────────────────────────────────────────────────────────────── */

const makeConfig = (
  overrides: Partial<BrowserControllerConfig> = {}
): BrowserControllerConfig => ({
  cluster: {
    maxWorkers: 2,
    launchTimeoutMs: 5000,
    navigationTimeoutMs: 5000,
    headless: true,
    executablePath: undefined,
    extraArgs: [],
  },
  stealth: {
    profile: StealthProfile.Standard,
    userAgents: ["UA-1", "UA-2", "UA-3"],
    webGLVendor: "Intel Inc.",
    webGLRenderer: "Intel Iris OpenGL Engine",
    spoofCanvas: false,
  },
  resourceFilter: {
    blockedTypes: [ResourceType.Image],
    blockedUrlPatterns: [],
  },
  humanMimicry: {
    mouseWaypointRange: [1, 1],
    mouseStepDelayRange: [0, 0],
    scrollStepRange: [100, 100],
    scrollDelayRange: [0, 0],
    keystrokeDelayRange: [0, 0],
  } as HumanMimicryConfig,
  ...overrides,
});

const makeRequest = (overrides: Partial<ScrapeRequest> = {}): ScrapeRequest => ({
  taskId: "task-001",
  url: "https://example.com",
  ...overrides,
});

function makeMockBrowser(pageOverrides: Record<string, unknown> = {}) {
  const mockPage = {
    addInitScript: jest.fn().mockResolvedValue(undefined),
    route: jest.fn(),
    setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
    goto: jest.fn().mockResolvedValue({ status: () => 200 }),
    waitForSelector: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue(1000),
    content: jest.fn().mockResolvedValue("<html><body>OK</body></html>"),
    url: jest.fn().mockReturnValue("https://example.com"),
    close: jest.fn().mockResolvedValue(undefined),
    mouse: {
      move: jest.fn().mockResolvedValue(undefined),
      wheel: jest.fn().mockResolvedValue(undefined),
    },
    keyboard: { type: jest.fn().mockResolvedValue(undefined) },
    ...pageOverrides,
  };

  const mockContext = {
    newPage: jest.fn().mockResolvedValue(mockPage),
    close: jest.fn().mockResolvedValue(undefined),
  };

  const mockBrowser = {
    newContext: jest.fn().mockResolvedValue(mockContext),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };

  return { mockBrowser, mockContext, mockPage };
}

/* ── Suppress logger output ──────────────────────────────────────────────── */
beforeEach(() => {
  jest.spyOn(process.stdout, "write").mockImplementation(() => true);
});

/* ── Tests ───────────────────────────────────────────────────────────────── */

describe("BrowserCluster", () => {
  describe("init()", () => {
    it("launches chromium with the correct headless flag", async () => {
      const { mockBrowser } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();

      expect(chromium.launch).toHaveBeenCalledWith(
        expect.objectContaining({ headless: true })
      );
      await cluster.shutdown();
    });

    it("includes --no-sandbox in launch args for Docker", async () => {
      const { mockBrowser } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();

      const { args } = (chromium.launch as jest.Mock).mock.calls[0]![0] as {
        args: string[];
      };
      expect(args).toContain("--no-sandbox");
      expect(args).toContain("--disable-dev-shm-usage");
      await cluster.shutdown();
    });

    it("throws if called a second time without shutdown", async () => {
      const { mockBrowser } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();
      await expect(cluster.init()).rejects.toThrow("already-initialised");
      await cluster.shutdown();
    });

    it("propagates and logs chromium.launch errors", async () => {
      (chromium.launch as jest.Mock).mockRejectedValue(
        new Error("chromium not found")
      );
      const cluster = new BrowserCluster(makeConfig());
      await expect(cluster.init()).rejects.toThrow("chromium not found");
    });
  });

  describe("scrape() — happy path", () => {
    it("returns a ScrapeResult with the HTML and taskId", async () => {
      const { mockBrowser } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();
      const result = await cluster.scrape(makeRequest());

      expect(result.taskId).toBe("task-001");
      expect(result.html).toBe("<html><body>OK</body></html>");
      expect(result.statusCode).toBe(200);
      expect(result.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      await cluster.shutdown();
    });

    it("creates a new browser context per request", async () => {
      const { mockBrowser, mockContext } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();
      await cluster.scrape(makeRequest({ taskId: "t1" }));
      await cluster.scrape(makeRequest({ taskId: "t2" }));

      expect(mockBrowser.newContext).toHaveBeenCalledTimes(2);
      expect(mockContext.close).toHaveBeenCalledTimes(2);
      await cluster.shutdown();
    });

    it("closes the context even after a successful scrape", async () => {
      const { mockBrowser, mockContext } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();
      await cluster.scrape(makeRequest());

      expect(mockContext.close).toHaveBeenCalledTimes(1);
      await cluster.shutdown();
    });

    it("injects proxy credentials into the browser context", async () => {
      const { mockBrowser } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const proxy: ProxyConfig = {
        host: "proxy.mesh.internal",
        port: 8080,
        username: "user",
        password: "pass",
        protocol: "http",
      };

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();
      await cluster.scrape(makeRequest({ proxy }));

      const contextArgs = mockBrowser.newContext.mock.calls[0]![0] as {
        proxy: { server: string; username: string; password: string };
      };
      expect(contextArgs.proxy.server).toBe("http://proxy.mesh.internal:8080");
      expect(contextArgs.proxy.username).toBe("user");
      expect(contextArgs.proxy.password).toBe("pass");
      await cluster.shutdown();
    });

    it("does not inject proxy config when no proxy is supplied", async () => {
      const { mockBrowser } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();
      await cluster.scrape(makeRequest()); /* no proxy field */

      const contextArgs = mockBrowser.newContext.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(contextArgs["proxy"]).toBeUndefined();
      await cluster.shutdown();
    });

    it("rotates through user agents in round-robin order", async () => {
      const { mockBrowser } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();

      for (let i = 0; i < 3; i++) {
        await cluster.scrape(makeRequest({ taskId: `t${i}` }));
      }

      const uasSent = (mockBrowser.newContext.mock.calls as Array<[{ userAgent: string }]>)
        .map(([opts]) => opts.userAgent);

      expect(uasSent).toEqual(["UA-1", "UA-2", "UA-3"]);
      await cluster.shutdown();
    });

    it("waits for selectors when waitForSelectors is provided", async () => {
      const { mockBrowser, mockPage } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();
      await cluster.scrape(
        makeRequest({ waitForSelectors: [".job-title", ".company-name"] })
      );

      expect(mockPage.waitForSelector).toHaveBeenCalledWith(".job-title", expect.any(Object));
      expect(mockPage.waitForSelector).toHaveBeenCalledWith(".company-name", expect.any(Object));
      await cluster.shutdown();
    });

    it("calls scrollDown when scrollPage is true", async () => {
      const { mockBrowser, mockPage } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();
      await cluster.scrape(makeRequest({ scrollPage: true }));

      expect(mockPage.mouse.wheel).toHaveBeenCalled();
      await cluster.shutdown();
    });

    it("sets extra HTTP headers when extraHeaders is provided", async () => {
      const { mockBrowser, mockPage } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();
      await cluster.scrape(
        makeRequest({ extraHeaders: { "X-Custom": "header-value" } })
      );

      expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith({
        "X-Custom": "header-value",
      });
      await cluster.shutdown();
    });
  });

  describe("scrape() — failure modes", () => {
    it("throws ScrapeError with NavigationTimeout on goto timeout", async () => {
      const { mockBrowser } = makeMockBrowser({
        goto: jest
          .fn()
          .mockRejectedValue(new Error("Timeout exceeded navigating to URL")),
      });
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();

      await expect(cluster.scrape(makeRequest())).rejects.toMatchObject({
        errorCode: ScrapeErrorCode.NavigationTimeout,
        taskId: "task-001",
      });
      await cluster.shutdown();
    });

    it("throws ScrapeError with HTTPError on a 403 response", async () => {
      const { mockBrowser } = makeMockBrowser({
        goto: jest.fn().mockResolvedValue({ status: () => 403 }),
      });
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();

      await expect(cluster.scrape(makeRequest())).rejects.toMatchObject({
        errorCode: ScrapeErrorCode.HTTPError,
      });
      await cluster.shutdown();
    });

    it("throws ScrapeError with ProxyAuthFailure on proxy error", async () => {
      const { mockBrowser } = makeMockBrowser({
        goto: jest
          .fn()
          .mockRejectedValue(new Error("net::ERR_PROXY_CONNECTION_FAILED")),
      });
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();

      await expect(cluster.scrape(makeRequest())).rejects.toMatchObject({
        errorCode: ScrapeErrorCode.ProxyAuthFailure,
      });
      await cluster.shutdown();
    });

    it("closes context in the finally block even when scrape throws", async () => {
      const { mockBrowser, mockContext } = makeMockBrowser({
        goto: jest.fn().mockRejectedValue(new Error("Timeout")),
      });
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();

      await cluster.scrape(makeRequest()).catch(() => undefined);
      expect(mockContext.close).toHaveBeenCalledTimes(1);
      await cluster.shutdown();
    });

    it("throws if scrape() is called before init()", async () => {
      const cluster = new BrowserCluster(makeConfig());
      await expect(cluster.scrape(makeRequest())).rejects.toMatchObject({
        errorCode: ScrapeErrorCode.UnknownError,
      });
    });

    it("throws ScrapeError with ElementTimeout when waitForSelector times out", async () => {
      const { mockBrowser } = makeMockBrowser({
        waitForSelector: jest
          .fn()
          .mockRejectedValue(new Error("Timeout waiting for selector")),
      });
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();

      await expect(
        cluster.scrape(makeRequest({ waitForSelectors: [".missing"] }))
      ).rejects.toMatchObject({ errorCode: ScrapeErrorCode.ElementTimeout });
      await cluster.shutdown();
    });
  });

  describe("shutdown()", () => {
    it("closes the browser", async () => {
      const { mockBrowser } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();
      await cluster.shutdown();

      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });

    it("is idempotent — calling twice does not throw", async () => {
      const { mockBrowser } = makeMockBrowser();
      (chromium.launch as jest.Mock).mockResolvedValue(mockBrowser);

      const cluster = new BrowserCluster(makeConfig());
      await cluster.init();
      await cluster.shutdown();
      await expect(cluster.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("getWorkerStatus()", () => {
    it("returns a slot for every configured worker", () => {
      const cluster = new BrowserCluster(makeConfig({ cluster: { ...makeConfig().cluster, maxWorkers: 3 } }));
      const slots = cluster.getWorkerStatus();
      expect(slots).toHaveLength(3);
    });

    it("all slots start as Idle with no assigned task", () => {
      const cluster = new BrowserCluster(makeConfig());
      for (const slot of cluster.getWorkerStatus()) {
        expect(slot.status).toBe(BrowserStatus.Idle);
        expect(slot.currentTaskId).toBeUndefined();
      }
    });

    it("returns a snapshot — mutations to the returned array do not affect internal state", () => {
      const cluster = new BrowserCluster(makeConfig());
      const slots = cluster.getWorkerStatus();
      slots.splice(0, slots.length);
      expect(cluster.getWorkerStatus()).toHaveLength(2);
    });
  });
});
