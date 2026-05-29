import {
  BrowserControllerConfig,
  ClusterConfig,
  HumanMimicryConfig,
  ResourceFilterConfig,
  ResourceType,
  StealthConfig,
  StealthProfile,
} from "./types";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (val === undefined || val === "") {
    throw new Error(`Required environment variable "${name}" is not set`);
  }
  return val;
}

function optionalEnv(name: string): string | undefined {
  const val = process.env[name];
  return val === "" ? undefined : val;
}

function requireInt(name: string): number {
  const raw = requireEnv(name);
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new RangeError(
      `Environment variable "${name}" must be an integer, got: "${raw}"`
    );
  }
  return parsed;
}

function requireBool(name: string): boolean {
  const raw = requireEnv(name).toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(
    `Environment variable "${name}" must be true/false/1/0, got: "${raw}"`
  );
}

function requireIntRange(
  minName: string,
  maxName: string
): [min: number, max: number] {
  const min = requireInt(minName);
  const max = requireInt(maxName);
  if (min > max) {
    throw new RangeError(
      `"${minName}" (${min}) must be <= "${maxName}" (${max})`
    );
  }
  return [min, max];
}

function requireEnum<T extends string>(
  name: string,
  values: readonly T[]
): T {
  const raw = requireEnv(name);
  if ((values as readonly string[]).includes(raw)) {
    return raw as T;
  }
  throw new Error(
    `Environment variable "${name}" must be one of [${values.join(", ")}], got: "${raw}"`
  );
}

function requireStringList(name: string, separator = ","): string[] {
  const raw = requireEnv(name);
  return raw
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function optionalStringList(
  name: string,
  separator = ","
): string[] {
  const raw = optionalEnv(name);
  if (!raw) return [];
  return raw
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function loadClusterConfig(): ClusterConfig {
  return {
    maxWorkers: requireInt("CLUSTER_MAX_WORKERS"),
    launchTimeoutMs: requireInt("CLUSTER_LAUNCH_TIMEOUT_MS"),
    navigationTimeoutMs: requireInt("CLUSTER_NAVIGATION_TIMEOUT_MS"),
    headless: requireBool("CLUSTER_HEADLESS"),
    executablePath: optionalEnv("CLUSTER_EXECUTABLE_PATH"),
    extraArgs: optionalStringList("CLUSTER_EXTRA_ARGS"),
  };
}

function loadStealthConfig(): StealthConfig {
  return {
    profile: requireEnum("STEALTH_PROFILE", Object.values(StealthProfile)),
    userAgents: requireStringList("STEALTH_USER_AGENTS", "|"),
    webGLVendor: requireEnv("STEALTH_WEBGL_VENDOR"),
    webGLRenderer: requireEnv("STEALTH_WEBGL_RENDERER"),
    spoofCanvas: requireBool("STEALTH_SPOOF_CANVAS"),
  };
}

function loadResourceFilterConfig(): ResourceFilterConfig {
  const rawTypes = requireStringList("RESOURCE_BLOCKED_TYPES");
  const validTypes = new Set<string>(Object.values(ResourceType));

  const blockedTypes = rawTypes.map((t) => {
    if (!validTypes.has(t)) {
      throw new Error(
        `Unknown resource type "${t}" in RESOURCE_BLOCKED_TYPES. ` +
          `Valid values: ${[...validTypes].join(", ")}`
      );
    }
    return t as ResourceType;
  });

  return {
    blockedTypes,
    blockedUrlPatterns: optionalStringList("RESOURCE_BLOCKED_URL_PATTERNS"),
  };
}

function loadHumanMimicryConfig(): HumanMimicryConfig {
  return {
    mouseWaypointRange: requireIntRange(
      "MIMICRY_MOUSE_WAYPOINT_MIN",
      "MIMICRY_MOUSE_WAYPOINT_MAX"
    ),
    mouseStepDelayRange: requireIntRange(
      "MIMICRY_MOUSE_STEP_DELAY_MIN",
      "MIMICRY_MOUSE_STEP_DELAY_MAX"
    ),
    scrollStepRange: requireIntRange(
      "MIMICRY_SCROLL_STEP_MIN",
      "MIMICRY_SCROLL_STEP_MAX"
    ),
    scrollDelayRange: requireIntRange(
      "MIMICRY_SCROLL_DELAY_MIN",
      "MIMICRY_SCROLL_DELAY_MAX"
    ),
    keystrokeDelayRange: requireIntRange(
      "MIMICRY_KEYSTROKE_DELAY_MIN",
      "MIMICRY_KEYSTROKE_DELAY_MAX"
    ),
  };
}

/**
 * Reads all required environment variables and returns a fully validated
 * BrowserControllerConfig. Throws descriptively on the first missing or
 * malformed variable — fail-fast at startup, not mid-scrape.
 */
export function loadConfig(): BrowserControllerConfig {
  return {
    cluster: loadClusterConfig(),
    stealth: loadStealthConfig(),
    resourceFilter: loadResourceFilterConfig(),
    humanMimicry: loadHumanMimicryConfig(),
  };
}
