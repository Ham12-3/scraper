import { HumanMimicry } from "../humanMimicry";
import { HumanMimicryConfig } from "../types";

/** Zero-delay config so tests run instantly */
const INSTANT_CONFIG: HumanMimicryConfig = {
  mouseWaypointRange: [3, 5],
  mouseStepDelayRange: [0, 0],
  scrollStepRange: [100, 100],
  scrollDelayRange: [0, 0],
  keystrokeDelayRange: [0, 0],
};

const makeMockPage = () => ({
  mouse: {
    move: jest.fn().mockResolvedValue(undefined),
    wheel: jest.fn().mockResolvedValue(undefined),
  },
  keyboard: {
    type: jest.fn().mockResolvedValue(undefined),
  },
});

describe("HumanMimicry", () => {
  describe("moveMouse()", () => {
    it("calls page.mouse.move the exact number of waypoints", async () => {
      const mimicry = new HumanMimicry({
        ...INSTANT_CONFIG,
        mouseWaypointRange: [5, 5], /* fixed count for determinism */
      });
      const page = makeMockPage();
      await mimicry.moveMouse(page, 400, 300);
      expect(page.mouse.move).toHaveBeenCalledTimes(5);
    });

    it("ends at the target coordinates on the final waypoint", async () => {
      const mimicry = new HumanMimicry({
        ...INSTANT_CONFIG,
        mouseWaypointRange: [4, 4],
      });
      const page = makeMockPage();
      await mimicry.moveMouse(page, 800, 600);
      const calls = page.mouse.move.mock.calls;
      const lastCall = calls[calls.length - 1] as [number, number];
      expect(lastCall[0]).toBe(800);
      expect(lastCall[1]).toBe(600);
    });

    it("tracks position across sequential calls (start from last end)", async () => {
      const mimicry = new HumanMimicry({
        ...INSTANT_CONFIG,
        mouseWaypointRange: [2, 2],
      });
      const page = makeMockPage();
      await mimicry.moveMouse(page, 100, 100);
      page.mouse.move.mockClear();

      /* Second move should start from (100, 100), not (0, 0) */
      await mimicry.moveMouse(page, 200, 200);
      /* First call on the second move should be somewhere between (100,100) and (200,200) */
      const [firstX, firstY] = page.mouse.move.mock.calls[0] as [
        number,
        number
      ];
      expect(firstX).toBeGreaterThanOrEqual(100);
      expect(firstX).toBeLessThanOrEqual(200);
      expect(firstY).toBeGreaterThanOrEqual(100);
      expect(firstY).toBeLessThanOrEqual(200);
    });

    it("waypoint count falls within configured range across multiple runs", async () => {
      const mimicry = new HumanMimicry({
        ...INSTANT_CONFIG,
        mouseWaypointRange: [3, 7],
      });

      for (let i = 0; i < 20; i++) {
        const page = makeMockPage();
        await mimicry.moveMouse(page, 100, 100);
        const count = page.mouse.move.mock.calls.length;
        expect(count).toBeGreaterThanOrEqual(3);
        expect(count).toBeLessThanOrEqual(7);
      }
    });
  });

  describe("scrollDown()", () => {
    it("does nothing when totalPixels is 0", async () => {
      const mimicry = new HumanMimicry(INSTANT_CONFIG);
      const page = makeMockPage();
      await mimicry.scrollDown(page, 0);
      expect(page.mouse.wheel).not.toHaveBeenCalled();
    });

    it("does nothing when totalPixels is negative", async () => {
      const mimicry = new HumanMimicry(INSTANT_CONFIG);
      const page = makeMockPage();
      await mimicry.scrollDown(page, -200);
      expect(page.mouse.wheel).not.toHaveBeenCalled();
    });

    it("scrolls the correct total number of pixels across all calls", async () => {
      const mimicry = new HumanMimicry({
        ...INSTANT_CONFIG,
        scrollStepRange: [50, 50],
      });
      const page = makeMockPage();
      await mimicry.scrollDown(page, 200);

      const totalScrolled = (
        page.mouse.wheel.mock.calls as [number, number][]
      ).reduce((sum, [, dy]) => sum + dy, 0);
      expect(totalScrolled).toBe(200);
    });

    it("passes 0 as the x-axis delta on every wheel call", async () => {
      const mimicry = new HumanMimicry(INSTANT_CONFIG);
      const page = makeMockPage();
      await mimicry.scrollDown(page, 300);
      for (const call of page.mouse.wheel.mock.calls as [number, number][]) {
        expect(call[0]).toBe(0);
      }
    });
  });

  describe("typeText()", () => {
    it("types each character individually", async () => {
      const mimicry = new HumanMimicry(INSTANT_CONFIG);
      const page = makeMockPage();
      await mimicry.typeText(page, "hello");
      expect(page.keyboard.type).toHaveBeenCalledTimes(5);
    });

    it("types characters in order", async () => {
      const mimicry = new HumanMimicry(INSTANT_CONFIG);
      const page = makeMockPage();
      await mimicry.typeText(page, "abc");
      const typed = (page.keyboard.type.mock.calls as [string][]).map(
        ([c]) => c
      );
      expect(typed).toEqual(["a", "b", "c"]);
    });

    it("handles empty string without calling keyboard.type", async () => {
      const mimicry = new HumanMimicry(INSTANT_CONFIG);
      const page = makeMockPage();
      await mimicry.typeText(page, "");
      expect(page.keyboard.type).not.toHaveBeenCalled();
    });

    it("handles unicode characters", async () => {
      const mimicry = new HumanMimicry(INSTANT_CONFIG);
      const page = makeMockPage();
      await mimicry.typeText(page, "héllo");
      expect(page.keyboard.type).toHaveBeenCalledTimes(5);
    });
  });
});
