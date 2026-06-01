// src/workflow/concurrency.ts
import { cpus } from 'node:os';
import { AgentCapError } from './errors.ts';

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}

/**
 * Counting semaphore. The fast path (slot available) runs synchronously up to
 * `active++`, so concurrent synchronous `acquire()` calls cannot oversubscribe.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

export class AgentCounter {
  private count = 0;

  constructor(private readonly cap: number = 1000) {}

  increment(): void {
    this.count += 1;
    if (this.count > this.cap) {
      throw new AgentCapError(`Workflow exceeded the ${this.cap}-agent cap`);
    }
  }

  get value(): number {
    return this.count;
  }
}
