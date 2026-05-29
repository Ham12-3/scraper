import { loadConfig } from "../configLoader";
import { ResourceType, StealthProfile } from "../types";

const VALID_ENV: Record<string, string> = {
  CLUSTER_MAX_WORKERS: "4",
  CLUSTER_LAUNCH_TIMEOUT_MS: "30000",
  CLUSTER_NAVIGATION_TIMEOUT_MS: "30000",
  CLUSTER_HEADLESS: "true",
  STEALTH_PROFILE: "standard",
  STEALTH_USER_AGENTS:
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36|Mozilla/5.0 (Macintosh)",
  STEALTH_WEBGL_VENDOR: "Intel Inc.",
  STEALTH_WEBGL_RENDERER: "Intel Iris OpenGL Engine",
  STEALTH_SPOOF_CANVAS: "true",
  RESOURCE_BLOCKED_TYPES: "image,stylesheet,font",
  MIMICRY_MOUSE_WAYPOINT_MIN: "10",
  MIMICRY_MOUSE_WAYPOINT_MAX: "30",
  MIMICRY_MOUSE_STEP_DELAY_MIN: "5",
  MIMICRY_MOUSE_STEP_DELAY_MAX: "20",
  MIMICRY_SCROLL_STEP_MIN: "50",
  MIMICRY_SCROLL_STEP_MAX: "150",
  MIMICRY_SCROLL_DELAY_MIN: "30",
  MIMICRY_SCROLL_DELAY_MAX: "100",
  MIMICRY_KEYSTROKE_DELAY_MIN: "50",
  MIMICRY_KEYSTROKE_DELAY_MAX: "200",
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};

  /* Save originals and apply the full valid env */
  for (const key of Object.keys(VALID_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = VALID_ENV[key];
  }

  /* Apply test-specific overrides */
  for (const [key, val] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

describe("loadConfig()", () => {
  describe("happy path", () => {
    it("loads a fully valid config without throwing", () => {
      withEnv({}, () => {
        expect(() => loadConfig()).not.toThrow();
      });
    });

    it("parses cluster.maxWorkers as an integer", () => {
      withEnv({}, () => {
        const cfg = loadConfig();
        expect(cfg.cluster.maxWorkers).toBe(4);
      });
    });

    it("parses cluster.headless as true", () => {
      withEnv({}, () => {
        const cfg = loadConfig();
        expect(cfg.cluster.headless).toBe(true);
      });
    });

    it("parses cluster.headless as false from '0'", () => {
      withEnv({ CLUSTER_HEADLESS: "0" }, () => {
        const cfg = loadConfig();
        expect(cfg.cluster.headless).toBe(false);
      });
    });

    it("parses stealth.profile as StealthProfile.Standard", () => {
      withEnv({}, () => {
        const cfg = loadConfig();
        expect(cfg.stealth.profile).toBe(StealthProfile.Standard);
      });
    });

    it("parses stealth.userAgents as a list split by '|'", () => {
      withEnv({}, () => {
        const cfg = loadConfig();
        expect(cfg.stealth.userAgents).toHaveLength(2);
        expect(cfg.stealth.userAgents[0]).toContain("Windows");
      });
    });

    it("parses stealth.spoofCanvas as true", () => {
      withEnv({}, () => {
        const cfg = loadConfig();
        expect(cfg.stealth.spoofCanvas).toBe(true);
      });
    });

    it("parses resourceFilter.blockedTypes correctly", () => {
      withEnv({}, () => {
        const cfg = loadConfig();
        expect(cfg.resourceFilter.blockedTypes).toContain(ResourceType.Image);
        expect(cfg.resourceFilter.blockedTypes).toContain(ResourceType.Stylesheet);
        expect(cfg.resourceFilter.blockedTypes).toContain(ResourceType.Font);
      });
    });

    it("defaults resourceFilter.blockedUrlPatterns to [] when unset", () => {
      withEnv({ RESOURCE_BLOCKED_URL_PATTERNS: undefined }, () => {
        const cfg = loadConfig();
        expect(cfg.resourceFilter.blockedUrlPatterns).toEqual([]);
      });
    });

    it("defaults cluster.extraArgs to [] when unset", () => {
      withEnv({ CLUSTER_EXTRA_ARGS: undefined }, () => {
        const cfg = loadConfig();
        expect(cfg.cluster.extraArgs).toEqual([]);
      });
    });

    it("leaves cluster.executablePath undefined when unset", () => {
      withEnv({ CLUSTER_EXECUTABLE_PATH: undefined }, () => {
        const cfg = loadConfig();
        expect(cfg.cluster.executablePath).toBeUndefined();
      });
    });

    it("parses mimicry ranges as [min, max] tuples", () => {
      withEnv({}, () => {
        const cfg = loadConfig();
        expect(cfg.humanMimicry.mouseWaypointRange).toEqual([10, 30]);
        expect(cfg.humanMimicry.keystrokeDelayRange).toEqual([50, 200]);
      });
    });
  });

  describe("missing required variables", () => {
    const required = [
      "CLUSTER_MAX_WORKERS",
      "CLUSTER_HEADLESS",
      "STEALTH_PROFILE",
      "STEALTH_USER_AGENTS",
      "STEALTH_WEBGL_VENDOR",
      "STEALTH_SPOOF_CANVAS",
      "RESOURCE_BLOCKED_TYPES",
      "MIMICRY_MOUSE_WAYPOINT_MIN",
    ] as const;

    for (const varName of required) {
      it(`throws when ${varName} is missing`, () => {
        withEnv({ [varName]: undefined }, () => {
          expect(() => loadConfig()).toThrow(varName);
        });
      });

      it(`throws when ${varName} is an empty string`, () => {
        withEnv({ [varName]: "" }, () => {
          expect(() => loadConfig()).toThrow(varName);
        });
      });
    }
  });

  describe("malformed values", () => {
    it("throws a RangeError when CLUSTER_MAX_WORKERS is not an integer", () => {
      withEnv({ CLUSTER_MAX_WORKERS: "four" }, () => {
        expect(() => loadConfig()).toThrow(RangeError);
      });
    });

    it("throws when CLUSTER_HEADLESS is not true/false/1/0", () => {
      withEnv({ CLUSTER_HEADLESS: "yes" }, () => {
        expect(() => loadConfig()).toThrow();
      });
    });

    it("throws when STEALTH_PROFILE is not a valid enum value", () => {
      withEnv({ STEALTH_PROFILE: "ultra-stealth" }, () => {
        expect(() => loadConfig()).toThrow("STEALTH_PROFILE");
      });
    });

    it("throws when RESOURCE_BLOCKED_TYPES contains an unknown type", () => {
      withEnv({ RESOURCE_BLOCKED_TYPES: "image,hologram" }, () => {
        expect(() => loadConfig()).toThrow("hologram");
      });
    });

    it("throws a RangeError when min > max in a range pair", () => {
      withEnv({
        MIMICRY_MOUSE_WAYPOINT_MIN: "50",
        MIMICRY_MOUSE_WAYPOINT_MAX: "10",
      }, () => {
        expect(() => loadConfig()).toThrow(RangeError);
      });
    });
  });
});
