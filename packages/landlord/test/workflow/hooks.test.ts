// test/workflow/hooks.test.ts
import { describe, expect, it } from 'vitest';
import type { RunDeps } from '../../src/workflow/agentcall.ts';
import { WorkflowBudget } from '../../src/workflow/budget.ts';
import { EventEmitter } from '../../src/workflow/events.ts';
import { buildContext } from '../../src/workflow/hooks.ts';

function fakeDeps(): RunDeps {
  return {
    emitter: new EventEmitter(),
    wfBudget: new WorkflowBudget(100),
    args: { topic: 'x' },
    currentPhase: { value: undefined },
    // unused-by-these-tests fields:
  } as unknown as RunDeps;
}

describe('buildContext combinators', () => {
  it('parallel maps a throwing thunk to null', async () => {
    const ctx = buildContext(fakeDeps(), async () => null);
    const out = await ctx.parallel([
      async () => 1,
      async () => {
        throw new Error('x');
      },
    ]);
    expect(out).toEqual([1, null]);
  });

  it('pipeline runs stages per item and drops a throwing item to null', async () => {
    const ctx = buildContext(fakeDeps(), async () => null);
    const out = await ctx.pipeline(
      [1, 2],
      (prev) => (prev as number) + 1,
      (prev, original, i) => {
        if (original === 2) throw new Error('boom');
        return `${prev}@${i}`;
      },
    );
    expect(out).toEqual(['2@0', null]);
  });

  it('phase and log emit events; budget and args are exposed', async () => {
    const deps = fakeDeps();
    const ctx = buildContext(deps, async () => null);
    ctx.phase('Find');
    ctx.log('looking');
    expect(deps.emitter.all().map((e) => e.type)).toEqual(['phase_started', 'log']);
    expect(ctx.budget.total).toBe(100);
    expect(ctx.args).toEqual({ topic: 'x' });
  });
});
