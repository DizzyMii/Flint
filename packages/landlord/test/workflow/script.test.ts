// test/workflow/script.test.ts
import { describe, expect, it } from 'vitest';
import { defineWorkflow } from '../../src/workflow/define.ts';
import { MetaError } from '../../src/workflow/errors.ts';
import { compileScript } from '../../src/workflow/script.ts';
import type { WorkflowContext } from '../../src/workflow/types.ts';

function fakeCtx(calls: string[]): WorkflowContext {
  return {
    agent: async (p) => {
      calls.push(`agent:${p}`);
      return 'R';
    },
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    pipeline: async (items) => items,
    phase: () => {},
    log: (m) => calls.push(`log:${m}`),
    args: { n: 2 },
    budget: { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
    workflow: async () => null,
  };
}

describe('compileScript', () => {
  it('parses meta, injects hooks, supports top-level await and return', async () => {
    const mod = compileScript(
      `export const meta = { name: 'x', description: 'y' }\nlog('hi')\nconst r = await agent('do ' + args.n)\nreturn r`,
    );
    expect(mod.meta.name).toBe('x');
    const calls: string[] = [];
    const result = await mod.run(fakeCtx(calls));
    expect(result).toBe('R');
    expect(calls).toEqual(['log:hi', 'agent:do 2']);
  });

  it('blocks nondeterministic globals at runtime', async () => {
    const mod = compileScript(
      `export const meta = { name: 'a', description: 'b' }\nreturn Date.now()`,
    );
    await expect(mod.run(fakeCtx([]))).rejects.toThrow();
  });

  it('blocks sandbox escape via this', async () => {
    const mod = compileScript(
      `export const meta = { name: 'a', description: 'b' }\nreturn this.Date.now()`,
    );
    await expect(mod.run(fakeCtx([]))).rejects.toThrow();
  });
});

describe('defineWorkflow', () => {
  it('returns the module and validates meta', () => {
    const mod = defineWorkflow({ meta: { name: 'm', description: 'd' }, run: async () => 42 });
    expect(mod.meta.name).toBe('m');
    expect(() => defineWorkflow({ meta: { name: 'm' } as never, run: async () => 1 })).toThrow(
      MetaError,
    );
  });
});
