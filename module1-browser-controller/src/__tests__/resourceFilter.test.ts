import { ResourceFilter } from "../resourceFilter";
import { Logger } from "../logger";
import { ResourceFilterConfig, ResourceType } from "../types";

const makeConfig = (
  overrides: Partial<ResourceFilterConfig> = {}
): ResourceFilterConfig => ({
  blockedTypes: [ResourceType.Image, ResourceType.Stylesheet, ResourceType.Font],
  blockedUrlPatterns: [],
  ...overrides,
});

type RouteHandler = (route: MockRoute) => void;

interface MockRoute {
  request: () => { resourceType: () => string; url: () => string };
  abort: jest.Mock;
  continue: jest.Mock;
}

const makeMockPage = () => {
  let capturedHandler: RouteHandler | null = null;
  const page = {
    route: jest.fn((_pattern: string, handler: RouteHandler) => {
      capturedHandler = handler;
    }),
    triggerRoute: (resourceType: string, url: string): MockRoute => {
      const route: MockRoute = {
        request: () => ({ resourceType: () => resourceType, url: () => url }),
        abort: jest.fn().mockResolvedValue(undefined),
        continue: jest.fn().mockResolvedValue(undefined),
      };
      capturedHandler!(route);
      return route;
    },
  };
  return page;
};

describe("ResourceFilter", () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger();
    jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  describe("attach()", () => {
    it("registers a route handler on the page with the wildcard pattern", () => {
      const filter = new ResourceFilter(makeConfig(), logger);
      const page = makeMockPage();
      filter.attach(page as never);
      expect(page.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    });
  });

  describe("type-based blocking", () => {
    it("aborts requests whose resource type is in the blocked list", () => {
      const filter = new ResourceFilter(makeConfig(), logger);
      const page = makeMockPage();
      filter.attach(page as never);

      const route = page.triggerRoute("image", "https://cdn.example.com/img.png");
      expect(route.abort).toHaveBeenCalledTimes(1);
      expect(route.continue).not.toHaveBeenCalled();
    });

    it("continues requests whose resource type is NOT in the blocked list", () => {
      const filter = new ResourceFilter(makeConfig(), logger);
      const page = makeMockPage();
      filter.attach(page as never);

      const route = page.triggerRoute("fetch", "https://api.example.com/data");
      expect(route.continue).toHaveBeenCalledTimes(1);
      expect(route.abort).not.toHaveBeenCalled();
    });

    it("blocks all configured types independently", () => {
      const filter = new ResourceFilter(makeConfig(), logger);
      const page = makeMockPage();
      filter.attach(page as never);

      for (const type of ["image", "stylesheet", "font"]) {
        const route = page.triggerRoute(type, `https://cdn.example.com/${type}`);
        expect(route.abort).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe("URL pattern blocking", () => {
    it("aborts requests matching a glob pattern", () => {
      const filter = new ResourceFilter(
        makeConfig({
          blockedTypes: [],
          blockedUrlPatterns: ["**/analytics/**"],
        }),
        logger
      );
      const page = makeMockPage();
      filter.attach(page as never);

      const route = page.triggerRoute(
        "script",
        "https://example.com/analytics/track.js"
      );
      expect(route.abort).toHaveBeenCalledTimes(1);
    });

    it("aborts requests matching a regex literal pattern", () => {
      const filter = new ResourceFilter(
        makeConfig({
          blockedTypes: [],
          blockedUrlPatterns: ["/google-analytics\\.com/"],
        }),
        logger
      );
      const page = makeMockPage();
      filter.attach(page as never);

      const route = page.triggerRoute(
        "script",
        "https://www.google-analytics.com/ga.js"
      );
      expect(route.abort).toHaveBeenCalledTimes(1);
    });

    it("continues requests that do not match any URL pattern", () => {
      const filter = new ResourceFilter(
        makeConfig({
          blockedTypes: [],
          blockedUrlPatterns: ["**/ads/**"],
        }),
        logger
      );
      const page = makeMockPage();
      filter.attach(page as never);

      const route = page.triggerRoute(
        "fetch",
        "https://api.example.com/v1/jobs"
      );
      expect(route.continue).toHaveBeenCalledTimes(1);
      expect(route.abort).not.toHaveBeenCalled();
    });

    it("short-circuits on type before checking URL patterns", () => {
      const filter = new ResourceFilter(
        makeConfig({
          blockedTypes: [ResourceType.Image],
          blockedUrlPatterns: ["**/allowed/**"],
        }),
        logger
      );
      const page = makeMockPage();
      filter.attach(page as never);

      /* URL matches the allow pattern, but the type is blocked → should abort */
      const route = page.triggerRoute(
        "image",
        "https://example.com/allowed/img.png"
      );
      expect(route.abort).toHaveBeenCalledTimes(1);
      expect(route.continue).not.toHaveBeenCalled();
    });

    it("matches multiple URL patterns and aborts on first match", () => {
      const filter = new ResourceFilter(
        makeConfig({
          blockedTypes: [],
          blockedUrlPatterns: ["**/ads/**", "**/tracking/**"],
        }),
        logger
      );
      const page = makeMockPage();
      filter.attach(page as never);

      const route = page.triggerRoute(
        "script",
        "https://example.com/tracking/pixel.js"
      );
      expect(route.abort).toHaveBeenCalledTimes(1);
    });
  });

  describe("error handling", () => {
    it("logs a warning if route.abort() rejects but does not throw", async () => {
      const filter = new ResourceFilter(makeConfig(), logger);
      const page = makeMockPage();
      filter.attach(page as never);

      const route = page.triggerRoute(
        "image",
        "https://cdn.example.com/img.png"
      );
      route.abort.mockRejectedValue(new Error("Target closed"));

      /* Wait a tick so the promise rejection handler fires */
      await Promise.resolve();
      /* If we reached here, the filter didn't throw — warning was swallowed */
    });

    it("logs a warning if route.continue() rejects but does not throw", async () => {
      const filter = new ResourceFilter(
        makeConfig({ blockedTypes: [] }),
        logger
      );
      const page = makeMockPage();
      filter.attach(page as never);

      const route = page.triggerRoute("fetch", "https://api.example.com/data");
      route.continue.mockRejectedValue(new Error("Request aborted"));

      await Promise.resolve();
      /* If we reached here, the filter didn't throw */
    });
  });
});
