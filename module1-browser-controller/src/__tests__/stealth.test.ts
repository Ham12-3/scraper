import { StealthInjector } from "../stealth";
import { Logger } from "../logger";
import { StealthConfig, StealthProfile } from "../types";

const makeConfig = (overrides: Partial<StealthConfig> = {}): StealthConfig => ({
  profile: StealthProfile.Standard,
  userAgents: ["Mozilla/5.0 (Test Agent)"],
  webGLVendor: "Intel Inc.",
  webGLRenderer: "Intel Iris OpenGL Engine",
  spoofCanvas: true,
  ...overrides,
});

const makeMockPage = () => ({
  addInitScript: jest.fn().mockResolvedValue(undefined),
});

describe("StealthInjector", () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger();
    jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  describe("inject()", () => {
    it("calls addInitScript exactly once", async () => {
      const injector = new StealthInjector(makeConfig(), logger);
      const page = makeMockPage();
      await injector.inject(page, "Mozilla/5.0 (Test)");
      expect(page.addInitScript).toHaveBeenCalledTimes(1);
    });

    it("passes an object with a content string to addInitScript", async () => {
      const injector = new StealthInjector(makeConfig(), logger);
      const page = makeMockPage();
      await injector.inject(page, "ua-test");
      const arg = page.addInitScript.mock.calls[0]?.[0] as { content: string };
      expect(typeof arg.content).toBe("string");
      expect(arg.content.length).toBeGreaterThan(0);
    });

    it("embeds the supplied user-agent in the script body", async () => {
      const ua = "Mozilla/5.0 CustomUA/1.0";
      const injector = new StealthInjector(makeConfig(), logger);
      const page = makeMockPage();
      await injector.inject(page, ua);
      const { content } = page.addInitScript.mock.calls[0]?.[0] as {
        content: string;
      };
      expect(content).toContain(ua);
    });

    it("overrides navigator.webdriver in the script", async () => {
      const injector = new StealthInjector(makeConfig(), logger);
      const page = makeMockPage();
      await injector.inject(page, "ua");
      const { content } = page.addInitScript.mock.calls[0]?.[0] as {
        content: string;
      };
      expect(content).toContain("navigator.webdriver");
      expect(content).toContain("undefined");
    });

    it("embeds the WebGL vendor string", async () => {
      const injector = new StealthInjector(
        makeConfig({ webGLVendor: "ACME GPU Corp" }),
        logger
      );
      const page = makeMockPage();
      await injector.inject(page, "ua");
      const { content } = page.addInitScript.mock.calls[0]?.[0] as {
        content: string;
      };
      expect(content).toContain("ACME GPU Corp");
    });

    it("embeds the WebGL renderer string", async () => {
      const injector = new StealthInjector(
        makeConfig({ webGLRenderer: "RX 9090 XT" }),
        logger
      );
      const page = makeMockPage();
      await injector.inject(page, "ua");
      const { content } = page.addInitScript.mock.calls[0]?.[0] as {
        content: string;
      };
      expect(content).toContain("RX 9090 XT");
    });

    it("includes canvas noise code when spoofCanvas is true", async () => {
      const injector = new StealthInjector(
        makeConfig({ spoofCanvas: true }),
        logger
      );
      const page = makeMockPage();
      await injector.inject(page, "ua");
      const { content } = page.addInitScript.mock.calls[0]?.[0] as {
        content: string;
      };
      expect(content).toContain("toDataURL");
      expect(content).toContain("getImageData");
    });

    it("omits canvas noise code when spoofCanvas is false", async () => {
      const injector = new StealthInjector(
        makeConfig({ spoofCanvas: false }),
        logger
      );
      const page = makeMockPage();
      await injector.inject(page, "ua");
      const { content } = page.addInitScript.mock.calls[0]?.[0] as {
        content: string;
      };
      expect(content).not.toContain("toDataURL");
    });

    it("patches both WebGLRenderingContext and WebGL2RenderingContext", async () => {
      const injector = new StealthInjector(makeConfig(), logger);
      const page = makeMockPage();
      await injector.inject(page, "ua");
      const { content } = page.addInitScript.mock.calls[0]?.[0] as {
        content: string;
      };
      expect(content).toContain("WebGLRenderingContext");
      expect(content).toContain("WebGL2RenderingContext");
    });

    it("propagates errors thrown by addInitScript", async () => {
      const injector = new StealthInjector(makeConfig(), logger);
      const page = makeMockPage();
      page.addInitScript.mockRejectedValue(new Error("page closed"));
      await expect(injector.inject(page, "ua")).rejects.toThrow("page closed");
    });
  });
});
