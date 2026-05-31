// test/workflow/runtime.test.ts
import type { NormalizedResponse } from 'flint';
import { mockAdapter, scriptedAdapter } from 'flint/testing';
import { describe, expect, it } from 'vitest';
import { memoryJournalStore } from '../../src/workflow/journal.ts';
import { runWorkflow, runWorkflowScript } from '../../src/workflow/runtime.ts';
import { defineWorkflow } from '../../src/workflow/define.ts';

function textResponse(content: string): NormalizedResponse {
  return {
    message: { role: 'assistant', content },
    usage: { input: 10, output: 5 },
    stopReason: 'end',
  };
}

describe('runWorkflow', () => {
  it('runs a single-agent script and reports events', async () => {
    const adapter = scriptedAdapter([textResponse('hello')]);
    const res = await runWorkflowScript(
      `export const meta = { name: 'r', description: 'd' }\nreturn await agent('hi')`,
      { adapter, models: { default: 'm' } },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.result).toBe('hello');
      expect(res.value.events.map((e) => e.type)).toContain('workflow_complete');
    }
  });

  it('replays from a prior run without calling the adapter (resume)', async () => {
    const journal = memoryJournalStore();
    const source = `export const meta = { name: 'r', description: 'd' }\nreturn await agent('hi')`;
    const r1 = await runWorkflowScript(source, {
      adapter: scriptedAdapter([textResponse('hello')]),
      models: { default: 'm' },
      journal,
      runId: 'run1',
    });
    expect(r1.ok && r1.value.result).toBe('hello');

    const throwing = mockAdapter({
      onCall: () => {
        throw new Error('must not be called');
      },
    });
    const r2 = await runWorkflowScript(source, {
      adapter: throwing,
      models: { default: 'm' },
      journal,
      runId: 'run2',
      resumeFromRunId: 'run1',
    });
    expect(r2.ok && r2.value.result).toBe('hello');
  });

  it('supports two-hop resume by re-journaling replayed entries', async () => {
    const journal = memoryJournalStore();
    const source = `export const meta = { name: 'r', description: 'd' }\nreturn await agent('hi')`;
    await runWorkflowScript(source, {
      adapter: scriptedAdapter([textResponse('hello')]),
      models: { default: 'm' },
      journal,
      runId: 'run1',
    });
    const throwing = mockAdapter({
      onCall: () => {
        throw new Error('must not be called');
      },
    });
    await runWorkflowScript(source, {
      adapter: throwing,
      models: { default: 'm' },
      journal,
      runId: 'run2',
      resumeFromRunId: 'run1',
    });
    const r3 = await runWorkflowScript(source, {
      adapter: throwing,
      models: { default: 'm' },
      journal,
      runId: 'run3',
      resumeFromRunId: 'run2',
    });
    expect(r3.ok && r3.value.result).toBe('hello');
  });

  it('runs a typed workflow via runWorkflow', async () => {
    const mod = defineWorkflow({
      meta: { name: 't', description: 'd' },
      run: async (wf) => {
        wf.phase('Work');
        return wf.budget.total;
      },
    });
    const res = await runWorkflow(mod, {
      adapter: scriptedAdapter([]),
      models: { default: 'm' },
      tokenTarget: 500,
    });
    expect(res.ok && res.value.result).toBe(500);
  });
});
