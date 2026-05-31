import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// test/workflow/agentcall.test.ts
import type { NormalizedResponse } from 'flint';
import { budget as makeBudget } from 'flint/budget';
import { mockAdapter, scriptedAdapter } from 'flint/testing';
import { describe, expect, it } from 'vitest';
import { runAgentCall } from '../../src/workflow/agentcall.ts';
import type { RunDeps } from '../../src/workflow/agentcall.ts';
import { WorkflowBudget } from '../../src/workflow/budget.ts';
import { AgentCounter, Semaphore } from '../../src/workflow/concurrency.ts';
import { EventEmitter } from '../../src/workflow/events.ts';
import { workdirIsolation } from '../../src/workflow/isolation.ts';
import { memoryJournalStore } from '../../src/workflow/journal.ts';
import { createAgentRegistry } from '../../src/workflow/registry.ts';

function textResponse(content: string): NormalizedResponse {
  return {
    message: { role: 'assistant', content },
    usage: { input: 10, output: 5 },
    stopReason: 'end',
  };
}
function toolCallResponse(name: string, args: unknown): NormalizedResponse {
  return {
    message: { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name, arguments: args }] },
    usage: { input: 20, output: 10 },
    stopReason: 'tool_call',
  };
}

async function makeDeps(adapter: RunDeps['adapter']): Promise<RunDeps> {
  const base = await mkdtemp(join(tmpdir(), 'ac-'));
  let index = 0;
  return {
    adapter,
    models: { default: 'test' },
    flintBudget: makeBudget({ maxSteps: 50 }),
    wfBudget: new WorkflowBudget(null),
    semaphore: new Semaphore(4),
    counter: new AgentCounter(1000),
    registry: createAgentRegistry(),
    workflows: undefined,
    isolation: workdirIsolation(base),
    worktreeIsolation: undefined,
    emitter: new EventEmitter(),
    journal: memoryJournalStore(),
    runId: 'run-test',
    resumeEntries: [],
    signal: undefined,
    args: undefined,
    depth: 0,
    nextIndex: () => index++,
    currentPhase: { value: undefined },
  };
}

describe('runAgentCall', () => {
  it('returns the final text for a no-schema call and records the journal', async () => {
    const deps = await makeDeps(scriptedAdapter([textResponse('hello world')]));
    const result = await runAgentCall('say hi', undefined, deps);
    expect(result).toBe('hello world');
    expect(await deps.journal.load('run-test')).toHaveLength(1);
    expect(deps.emitter.all().map((e) => e.type)).toEqual(['agent_started', 'agent_complete']);
  });

  it('returns the validated object for a schema call', async () => {
    const deps = await makeDeps(
      scriptedAdapter([
        toolCallResponse('structured_output', { name: 'ada' }),
        textResponse('done'),
      ]),
    );
    const result = await runAgentCall(
      'produce',
      {
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      deps,
    );
    expect(result).toEqual({ name: 'ada' });
  });

  it('replays a cached result on resume without calling the adapter', async () => {
    const throwingAdapter = mockAdapter({
      onCall: () => {
        throw new Error('must not call');
      },
    });
    const deps = await makeDeps(throwingAdapter);
    // Pre-seed resume entry: index 0 with the matching hash for ('say hi', {}).
    const { hashCall } = await import('../../src/workflow/journal.ts');
    deps.resumeEntries = [{ index: 0, hash: hashCall('say hi', {}), result: 'cached!' }];
    const result = await runAgentCall('say hi', undefined, deps);
    expect(result).toBe('cached!');
  });
});
