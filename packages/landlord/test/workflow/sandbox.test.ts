import { describe, expect, it } from 'vitest';
import { sandboxBindings } from '../../src/workflow/sandbox.ts';

describe('sandboxBindings', () => {
  it('blocks Date, Math.random, and process but allows pure Math', () => {
    const b = sandboxBindings();
    const D = b['Date'] as { now: () => number };
    const M = b['Math'] as Math;
    const P = b['process'] as { cwd: () => string };
    expect(() => D.now()).toThrow();
    expect(() => new (b['Date'] as unknown as new () => unknown)()).toThrow();
    expect(() => M.random()).toThrow();
    expect(M.floor(3.7)).toBe(3);
    expect(() => P.cwd()).toThrow();
  });
});
