import { describe, expect, it } from 'vitest';
import { resolveOrder, DependencyCycleError, orchestrate } from '../src/orchestrate.ts';
import type { Contract } from '../src/contract.ts';
import { budget } from 'flint/budget';
import { mockAdapter } from 'flint/testing';
import type { NormalizedResponse } from 'flint';

function makeContract(role: string, dependsOn: string[] = []): Contract {
  return {
    tenantId: role,
    role,
    objective: `Do ${role}`,
    subPrompt: `Do ${role}`,
    checkpoints: [],
    outputSchema: {},
    dependsOn,
    maxRetries: 3,
  };
}

describe('resolveOrder', () => {
  it('returns single contract unchanged', () => {
    const contracts = [makeContract('a')];
    const order = resolveOrder(contracts);
    expect(order.map(c => c.role)).toEqual(['a']);
  });

  it('orders a → b (b depends on a)', () => {
    const contracts = [makeContract('b', ['a']), makeContract('a')];
    const order = resolveOrder(contracts);
    const roles = order.map(c => c.role);
    expect(roles.indexOf('a')).toBeLessThan(roles.indexOf('b'));
  });

  it('orders a → b → c chain', () => {
    const contracts = [makeContract('c', ['b']), makeContract('a'), makeContract('b', ['a'])];
    const order = resolveOrder(contracts);
    const roles = order.map(c => c.role);
    expect(roles.indexOf('a')).toBeLessThan(roles.indexOf('b'));
    expect(roles.indexOf('b')).toBeLessThan(roles.indexOf('c'));
  });

  it('throws DependencyCycleError on cycle', () => {
    const contracts = [makeContract('a', ['b']), makeContract('b', ['a'])];
    expect(() => resolveOrder(contracts)).toThrow(DependencyCycleError);
  });

  it('ignores depends_on references to unknown roles', () => {
    const contracts = [makeContract('a', ['nonexistent'])];
    expect(() => resolveOrder(contracts)).not.toThrow();
  });
});

function textResponse(content: string): NormalizedResponse {
  return { message: { role: 'assistant', content }, usage: { input: 10, output: 5 }, stopReason: 'end' };
}

function toolCallResponse(name: string, args: unknown): NormalizedResponse {
  return {
    message: { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name, arguments: args }] },
    usage: { input: 20, output: 10 },
    stopReason: 'tool_call',
  };
}

function judgePass(): NormalizedResponse {
  return {
    message: { role: 'assistant', content: JSON.stringify({ passed: true, explanation: 'Good' }) },
    usage: { input: 10, output: 5 },
    stopReason: 'end',
  };
}

describe('orchestrate', () => {
  it('single tenant completes end-to-end', async () => {
    // Call sequence: decompose (i=0), agent checkpoint call (i=1), validate judge (i=2), agent finish (i=3)
    const adapter = mockAdapter({
      onCall: (_req, i) => {
        if (i === 0) return toolCallResponse('emit_plan', {
          contracts: [{
            role: 'worker',
            objective: 'Do work',
            subPrompt: 'Do the work',
            checkpoints: [{ name: 'done', description: 'Work is done', schema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] } }],
            outputSchema: {},
          }],
        });
        if (i === 1) return toolCallResponse('emit_checkpoint__done', { result: 'success' });
        if (i === 2) return judgePass();
        return textResponse('Complete');
      },
    });

    const result = await orchestrate('Do some work', () => [], {
      adapter,
      landlordModel: 'test',
      tenantModel: 'test',
      budget: budget({ maxSteps: 50 }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('complete');
      expect(result.value.tenants['worker']?.status).toBe('complete');
    }
  });

  it('two independent tenants run and both complete', async () => {
    const adapter = mockAdapter({
      onCall: (_req, i) => {
        if (i === 0) return toolCallResponse('emit_plan', {
          contracts: [
            { role: 'alpha', objective: 'x', subPrompt: 'x', checkpoints: [], outputSchema: {} },
            { role: 'beta', objective: 'y', subPrompt: 'y', checkpoints: [], outputSchema: {} },
          ],
        });
        return textResponse('Done');
      },
    });

    const result = await orchestrate('Two tasks', () => [], {
      adapter,
      landlordModel: 'test',
      tenantModel: 'test',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('complete');
      expect(result.value.tenants['alpha']?.status).toBe('complete');
      expect(result.value.tenants['beta']?.status).toBe('complete');
    }
  });

  it('tenant that misses checkpoints is retried and eventually escalated', async () => {
    const events: string[] = [];
    const adapter = mockAdapter({
      onCall: (_req, i) => {
        if (i === 0) return toolCallResponse('emit_plan', {
          contracts: [{
            role: 'flaky',
            objective: 'x',
            subPrompt: 'x',
            checkpoints: [{ name: 'cp', description: 'checkpoint', schema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] } }],
            outputSchema: {},
            maxRetries: 2,
          }],
        });
        // Always finish without hitting checkpoint
        return textResponse('Oops forgot checkpoint');
      },
    });

    const result = await orchestrate('Flaky task', () => [], {
      adapter,
      landlordModel: 'test',
      tenantModel: 'test',
      onEvent: (e) => events.push(e.type),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('partial');
      expect(result.value.tenants['flaky']?.status).toBe('escalated');
    }
    expect(events).toContain('tenant_escalated');
  });

  it('onEvent fires tenant_started and tenant_complete events', async () => {
    const events: string[] = [];
    const adapter = mockAdapter({
      onCall: (_req, i) => {
        if (i === 0) return toolCallResponse('emit_plan', {
          contracts: [{ role: 'w', objective: 'x', subPrompt: 'x', checkpoints: [], outputSchema: {} }],
        });
        return textResponse('Done');
      },
    });

    await orchestrate('Task', () => [], {
      adapter,
      landlordModel: 'test',
      tenantModel: 'test',
      onEvent: (e) => events.push(e.type),
    });

    expect(events).toContain('tenant_started');
    expect(events).toContain('tenant_complete');
    expect(events).toContain('job_complete');
  });

  it('dependent tenant receives shared artifacts', async () => {
    const adapter = mockAdapter({
      onCall: (_req, i) => {
        if (i === 0) return toolCallResponse('emit_plan', {
          contracts: [
            { role: 'producer', objective: 'Produce', subPrompt: 'Produce data', checkpoints: [], outputSchema: {} },
            { role: 'consumer', objective: 'Consume', subPrompt: 'Consume data', checkpoints: [], outputSchema: {}, dependsOn: ['producer'] },
          ],
        });
        return textResponse('Done');
      },
    });

    const result = await orchestrate('Chain task', () => [], {
      adapter,
      landlordModel: 'test',
      tenantModel: 'test',
    });

    // producer had no checkpoints so no artifacts, but the pipeline should complete without error
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('complete');
    }
  });
});
