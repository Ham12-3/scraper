import { Semaphore } from "../semaphore";

describe("Semaphore", () => {
  describe("constructor", () => {
    it("throws RangeError when permits is 0", () => {
      expect(() => new Semaphore(0)).toThrow(RangeError);
    });

    it("throws RangeError when permits is negative", () => {
      expect(() => new Semaphore(-5)).toThrow(RangeError);
    });

    it("initialises with correct available count", () => {
      const sem = new Semaphore(3);
      expect(sem.availablePermits).toBe(3);
      expect(sem.waitingCount).toBe(0);
    });
  });

  describe("acquire", () => {
    it("resolves immediately when permits are available", async () => {
      const sem = new Semaphore(2);
      await expect(sem.acquire()).resolves.toBeUndefined();
      expect(sem.availablePermits).toBe(1);
    });

    it("decrements availablePermits on each acquire", async () => {
      const sem = new Semaphore(3);
      await sem.acquire();
      await sem.acquire();
      expect(sem.availablePermits).toBe(1);
    });

    it("does not resolve when all permits are taken", async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      let resolved = false;
      sem.acquire().then(() => {
        resolved = true;
      });

      await Promise.resolve(); /* flush microtask queue */
      expect(resolved).toBe(false);
      expect(sem.waitingCount).toBe(1);
    });
  });

  describe("release", () => {
    it("unblocks the next waiter in FIFO order", async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const order: number[] = [];

      const w1 = sem.acquire().then(() => order.push(1));
      const w2 = sem.acquire().then(() => order.push(2));
      const w3 = sem.acquire().then(() => order.push(3));

      sem.release();
      await w1;
      sem.release();
      await w2;
      sem.release();
      await w3;

      expect(order).toEqual([1, 2, 3]);
    });

    it("increments availablePermits when no waiters are queued", async () => {
      const sem = new Semaphore(2);
      /* acquire one, then release it — available should return to 2 */
      await sem.acquire().then(() => sem.release());
      expect(sem.availablePermits).toBe(2);
    });

    it("handles concurrent acquisitions up to the permit ceiling", async () => {
      const sem = new Semaphore(3);
      const results: string[] = [];

      const tasks = Array.from({ length: 5 }, (_, i) =>
        sem.acquire().then(async () => {
          results.push(`start-${i}`);
          await Promise.resolve();
          results.push(`end-${i}`);
          sem.release();
        })
      );

      await Promise.all(tasks);
      expect(results.length).toBe(10); /* 5 starts + 5 ends */
    });
  });

  describe("waitingCount", () => {
    it("reports the number of queued waiters accurately", async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      sem.acquire(); /* waiter 1 */
      sem.acquire(); /* waiter 2 */
      expect(sem.waitingCount).toBe(2);

      sem.release();
      await Promise.resolve();
      expect(sem.waitingCount).toBe(1);
    });
  });
});
