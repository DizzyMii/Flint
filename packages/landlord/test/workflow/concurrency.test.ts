// test/workflow/concurrency.test.ts
import { describe, expect, it } from 'vitest';
import { AgentCapError } from '../../src/workflow/errors.ts';
import { AgentCounter, Semaphore, defaultConcurrency } from '../../src/workflow/concurrency.ts';

describe('Semaphore', () => {
  it('never runs more than `limit` tasks concurrently', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      release();
    };
    await Promise.all(Array.from({ length: 8 }, () => task()));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('AgentCounter', () => {
  it('throws AgentCapError past the cap', () => {
    const c = new AgentCounter(3);
    c.increment();
    c.increment();
    c.increment();
    expect(() => c.increment()).toThrow(AgentCapError);
  });
});

describe('defaultConcurrency', () => {
  it('is at least 1 and at most 16', () => {
    const n = defaultConcurrency();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(16);
  });
});
