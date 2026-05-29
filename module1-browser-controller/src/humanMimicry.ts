import { Page } from "playwright";
import { HumanMimicryConfig, IHumanMimicry } from "./types";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const randomInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

interface Point {
  x: number;
  y: number;
}

/**
 * Quadratic Bézier: interpolates from P0 through control point Pc to P1.
 * t ∈ [0, 1]
 */
function bezierPoint(P0: Point, Pc: Point, P1: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: Math.round(u * u * P0.x + 2 * u * t * Pc.x + t * t * P1.x),
    y: Math.round(u * u * P0.y + 2 * u * t * Pc.y + t * t * P1.y),
  };
}

/**
 * Sinusoidal ease-in-out: returns a velocity multiplier for progress ∈ [0,1].
 * Peaks at 1.0 in the middle, tapers to 0 at both ends.
 */
function sineEase(progress: number): number {
  return Math.sin(Math.PI * progress);
}

export class HumanMimicry implements IHumanMimicry {
  private readonly mousePositions = new WeakMap<Page, Point>();

  constructor(private readonly config: HumanMimicryConfig) {}

  async moveMouse(page: unknown, x: number, y: number): Promise<void> {
    const p = page as Page;
    const start: Point = this.mousePositions.get(p) ?? { x: 0, y: 0 };
    const end: Point = { x, y };

    const waypoints = randomInt(
      this.config.mouseWaypointRange[0],
      this.config.mouseWaypointRange[1]
    );

    /* Control point: midpoint + random perpendicular offset */
    const mid: Point = {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    };
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const perpLen = Math.sqrt(dx * dx + dy * dy) || 1;
    const jitter = (Math.random() - 0.5) * perpLen * 0.4;
    const control: Point = {
      x: Math.round(mid.x + ((-dy / perpLen) * jitter)),
      y: Math.round(mid.y + ((dx / perpLen) * jitter)),
    };

    for (let step = 1; step <= waypoints; step++) {
      const t = step / waypoints;
      const pt = bezierPoint(start, control, end, t);
      await p.mouse.move(pt.x, pt.y);

      const delay = randomInt(
        this.config.mouseStepDelayRange[0],
        this.config.mouseStepDelayRange[1]
      );
      await sleep(delay);
    }

    this.mousePositions.set(p, end);
  }

  async scrollDown(page: unknown, totalPixels: number): Promise<void> {
    const p = page as Page;
    if (totalPixels <= 0) return;

    const stepSize = randomInt(
      this.config.scrollStepRange[0],
      this.config.scrollStepRange[1]
    );
    const steps = Math.ceil(totalPixels / stepSize);

    for (let i = 0; i < steps; i++) {
      const progress = i / steps;
      /* Scale delay by inverse of sine velocity so fast sections have short
         delays and the ends (slow) have longer pauses — natural deceleration. */
      const velocityFactor = sineEase(progress) || 0.1;
      const baseDelay = randomInt(
        this.config.scrollDelayRange[0],
        this.config.scrollDelayRange[1]
      );
      const actualDelay = Math.round(baseDelay / velocityFactor);

      const pixels = Math.min(stepSize, totalPixels - i * stepSize);
      await p.mouse.wheel(0, pixels);
      await sleep(Math.min(actualDelay, 500)); /* cap so we don't stall */
    }
  }

  async typeText(page: unknown, text: string): Promise<void> {
    const p = page as Page;

    for (const char of text) {
      await p.keyboard.type(char);
      const delay = randomInt(
        this.config.keystrokeDelayRange[0],
        this.config.keystrokeDelayRange[1]
      );
      await sleep(delay);
    }
  }
}
