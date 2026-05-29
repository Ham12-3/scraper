/**
 * All type contracts for the Headless Browser Controller.
 * No logic. No defaults. Pure interface definitions.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum ResourceType {
  Document = "document",
  Stylesheet = "stylesheet",
  Image = "image",
  Media = "media",
  Font = "font",
  Script = "script",
  TextTrack = "texttrack",
  XHR = "xhr",
  Fetch = "fetch",
  EventSource = "eventsource",
  WebSocket = "websocket",
  Manifest = "manifest",
  Other = "other",
}

export enum BrowserStatus {
  Idle = "idle",
  Navigating = "navigating",
  Extracting = "extracting",
  Error = "error",
  Closed = "closed",
}

export enum StealthProfile {
  Standard = "standard",
  Aggressive = "aggressive",
}

export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

// ---------------------------------------------------------------------------
// Configuration types (all values injected — never hardcoded)
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  protocol: "http" | "https" | "socks5";
}

export interface StealthConfig {
  profile: StealthProfile;
  /** Rotate through this list on each new page context */
  userAgents: string[];
  /** Spoofed WebGL vendor string (e.g. "Intel Inc.") */
  webGLVendor: string;
  /** Spoofed WebGL renderer string (e.g. "Intel Iris OpenGL Engine") */
  webGLRenderer: string;
  /** Whether to inject canvas noise on every toDataURL/getImageData call */
  spoofCanvas: boolean;
}

export interface ResourceFilterConfig {
  /** Resource types that will be aborted before fetching */
  blockedTypes: ResourceType[];
  /** URL patterns (glob or regex string) whose requests will be aborted */
  blockedUrlPatterns: string[];
}

export interface HumanMimicryConfig {
  /** Min/max total mouse waypoints generated per navigation */
  mouseWaypointRange: [min: number, max: number];
  /** Min/max delay (ms) between mouse waypoint steps */
  mouseStepDelayRange: [min: number, max: number];
  /** Min/max scroll step size in pixels */
  scrollStepRange: [min: number, max: number];
  /** Min/max delay (ms) between scroll steps */
  scrollDelayRange: [min: number, max: number];
  /** Min/max delay (ms) between individual keystrokes */
  keystrokeDelayRange: [min: number, max: number];
}

export interface ClusterConfig {
  /** Maximum number of concurrent browser workers */
  maxWorkers: number;
  /** Browser launch timeout in milliseconds */
  launchTimeoutMs: number;
  /** Navigation timeout in milliseconds */
  navigationTimeoutMs: number;
  /** Whether to run headless (always true in production) */
  headless: boolean;
  /** Chromium executable path — injected from env in containers */
  executablePath: string | undefined;
  /** Extra Chromium CLI args */
  extraArgs: string[];
}

export interface BrowserControllerConfig {
  cluster: ClusterConfig;
  stealth: StealthConfig;
  resourceFilter: ResourceFilterConfig;
  humanMimicry: HumanMimicryConfig;
}

// ---------------------------------------------------------------------------
// Request / Response shapes
// ---------------------------------------------------------------------------

export interface ScrapeRequest {
  /** Unique job identifier propagated from the Kafka message */
  taskId: string;
  url: string;
  /** Optional per-request proxy — overrides any cluster-level default */
  proxy?: ProxyConfig;
  /** CSS selectors to wait for before extracting (optional) */
  waitForSelectors?: string[];
  /** If true, simulate human scrolling before extraction */
  scrollPage?: boolean;
  /** Extra HTTP headers to inject on the page request */
  extraHeaders?: Record<string, string>;
}

export interface ScrapeResult {
  taskId: string;
  url: string;
  /** Raw HTML captured after all wait conditions resolved */
  html: string;
  /** Final URL after any redirects */
  resolvedUrl: string;
  /** HTTP status code of the main document response */
  statusCode: number;
  /** Wall-clock duration from navigation start to extraction (ms) */
  durationMs: number;
  /** ISO 8601 timestamp of extraction */
  extractedAt: string;
}

export interface ScrapeError {
  taskId: string;
  url: string;
  errorCode: ScrapeErrorCode;
  message: string;
  /** Raw stack trace for structured logging */
  stack: string | undefined;
  /** Number of attempts consumed so far */
  attemptCount: number;
}

export enum ScrapeErrorCode {
  NavigationTimeout = "NAVIGATION_TIMEOUT",
  ElementTimeout = "ELEMENT_TIMEOUT",
  ProxyAuthFailure = "PROXY_AUTH_FAILURE",
  PageCrash = "PAGE_CRASH",
  HTTPError = "HTTP_ERROR",
  UnknownError = "UNKNOWN_ERROR",
}

// ---------------------------------------------------------------------------
// Structured log payload (every log line is a JSON object)
// ---------------------------------------------------------------------------

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  module: "browser-controller";
  taskId: string | undefined;
  event: string;
  durationMs?: number;
  errorCode?: ScrapeErrorCode;
  message?: string;
  stack?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Worker pool internals
// ---------------------------------------------------------------------------

export interface WorkerSlot {
  workerId: string;
  status: BrowserStatus;
  /** ISO 8601 timestamp of last assignment */
  lastAssignedAt: string | undefined;
  /** Currently assigned task, if any */
  currentTaskId: string | undefined;
}

// ---------------------------------------------------------------------------
// Stealth injection contract
// The stealth layer must satisfy this interface so it can be swapped in tests
// ---------------------------------------------------------------------------

export interface IStealthInjector {
  /**
   * Apply all stealth overrides to a Playwright Page object.
   * Must be called before any navigation occurs on that page.
   */
  inject(page: unknown, userAgent: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Human mimicry contract
// ---------------------------------------------------------------------------

export interface IHumanMimicry {
  /** Move mouse from current position to (x, y) via randomised Bézier path */
  moveMouse(page: unknown, x: number, y: number): Promise<void>;
  /** Scroll the page by totalPixels using natural velocity curve */
  scrollDown(page: unknown, totalPixels: number): Promise<void>;
  /** Type text into the focused element with variable keystroke timing */
  typeText(page: unknown, text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Browser cluster contract
// ---------------------------------------------------------------------------

export interface IBrowserCluster {
  /** Initialise the pool and warm up worker slots */
  init(): Promise<void>;
  /** Submit a scrape task; resolves with result or rejects with ScrapeError */
  scrape(request: ScrapeRequest): Promise<ScrapeResult>;
  /** Gracefully drain in-flight work and close all browsers */
  shutdown(): Promise<void>;
  /** Current snapshot of all worker slots */
  getWorkerStatus(): WorkerSlot[];
}
