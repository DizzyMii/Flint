import { describe, expect, it, vi } from 'vitest';
import type { NormalizedResponse } from '../src/adapter.ts';
import { agent } from '../src/agent.ts';
import { budget } from '../src/budget.ts';
import { BudgetExhausted, FlintError } from '../src/errors.ts';
import { tool } from '../src/primitives/tool.ts';
import { mockAdapter } from '../src/testing/mock-adapter.ts';
import type { Message, StandardSchemaV1 } from '../src/types.ts';

const textResponse = (content: string): NormalizedResponse => ({
  message: { role: 'assistant', content },
  usage: { input: 10, output: 5 },
  stopReason: 'end',
});

const toolCallResponse = (
  calls: Array<{ id: string; name: string; arguments: unknown }>,
): NormalizedResponse => ({
  message: { role: 'assistant', content: '', toolCalls: calls },
  usage: { input: 20, output: 8 },
  stopReason: 'tool_call',
});

function anySchema(): StandardSchemaV1<unknown, unknown> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (raw) => ({ value: raw }),
    },
  };
}

const searchTool = tool({
  name: 'search',
  description: 'search the web',
  input: anySchema(),
  handler: async (q: unknown) => ({ hits: ['a', 'b'], query: q }),
});

const boomTool = tool({
  name: 'boom',
  description: 'always throws',
  input: anySchema(),
  handler: () => {
    throw new Error('kaboom');
  },
});

const startMsgs: Message[] = [{ role: 'user', content: 'hello' }];

describe('agent', () => {
  it('returns Result.ok on terminal response with no tool calls', async () => {
    const adapter = mockAdapter({ onCall: () => textResponse('final answer') });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.message.content).toBe('final answer');
      expect(res.value.steps).toHaveLength(0);
    }
  });

  it('round-trips tool calls until terminal', async () => {
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'search', arguments: { q: 'ts' } }]),
      textResponse('done'),
    ];
    let i = 0;
    const adapter = mockAdapter({
      onCall: () => {
        const resp = responses[i];
        if (!resp) throw new Error('Response not found');
        i += 1;
        return resp;
      },
    });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [searchTool],
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.message.content).toBe('done');
      expect(res.value.steps).toHaveLength(1);
      expect(res.value.steps[0]?.toolResults[0]?.content).toContain('hits');
    }
  });

  it('feeds tool handler errors back as tool messages', async () => {
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'boom', arguments: {} }]),
      textResponse('apology'),
    ];
    let i = 0;
    const adapter = mockAdapter({
      onCall: () => {
        const resp = responses[i];
        if (!resp) throw new Error('Response not found');
        i += 1;
        return resp;
      },
    });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [boomTool],
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const toolMsg = res.value.steps[0]?.toolResults[0];
      expect(toolMsg?.content.toLowerCase()).toContain('error');
      expect(toolMsg?.content).toContain('kaboom');
    }
  });

  it('feeds unknown-tool errors back', async () => {
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'nonexistent', arguments: {} }]),
      textResponse('recovered'),
    ];
    let i = 0;
    const adapter = mockAdapter({
      onCall: () => {
        const resp = responses[i];
        if (!resp) throw new Error('Response not found');
        i += 1;
        return resp;
      },
    });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [searchTool],
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const toolMsg = res.value.steps[0]?.toolResults[0];
      expect(toolMsg?.content).toContain('unknown tool');
      expect(toolMsg?.content).toContain('nonexistent');
    }
  });

  it('returns Result.error on max steps exceeded', async () => {
    const adapter = mockAdapter({
      onCall: () => toolCallResponse([{ id: 'c1', name: 'search', arguments: { q: 'x' } }]),
    });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [searchTool],
      budget: budget({ maxSteps: 100 }),
      maxSteps: 2,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(FlintError);
      expect((res.error as FlintError).code).toBe('agent.max_steps_exceeded');
    }
  });

  it('propagates BudgetExhausted from call as Result.error', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 60, output: 60 },
        stopReason: 'end',
      }),
    });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      budget: budget({ maxTokens: 100 }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(BudgetExhausted);
    }
  });

  it('invokes onStep once per step with correct shape', async () => {
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'search', arguments: { q: 'x' } }]),
      textResponse('done'),
    ];
    let i = 0;
    const adapter = mockAdapter({
      onCall: () => {
        const resp = responses[i];
        if (!resp) throw new Error('Response not found');
        i += 1;
        return resp;
      },
    });
    const onStep = vi.fn();
    await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [searchTool],
      budget: budget({ maxSteps: 5 }),
      onStep,
    });
    expect(onStep).toHaveBeenCalledTimes(1);
    const step = onStep.mock.calls[0]?.[0];
    expect(step.assistant.role).toBe('assistant');
    expect(step.toolCalls).toHaveLength(1);
    expect(step.toolResults).toHaveLength(1);
    expect(step.usage.input).toBeGreaterThan(0);
  });

  it('calls lazy tools function with messages and step index', async () => {
    const lazy = vi.fn(() => [searchTool]);
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'search', arguments: {} }]),
      textResponse('ok'),
    ];
    let i = 0;
    const adapter = mockAdapter({
      onCall: () => {
        const resp = responses[i];
        if (!resp) throw new Error('Response not found');
        i += 1;
        return resp;
      },
    });
    await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: lazy,
      budget: budget({ maxSteps: 5 }),
    });
    expect(lazy).toHaveBeenCalledTimes(2); // once for first call, once for second
    const firstCall = lazy.mock.calls[0] as unknown;
    expect(Array.isArray(firstCall)).toBe(true);
    if (Array.isArray(firstCall) && firstCall.length > 0) {
      expect((firstCall[0] as Record<string, number>).step).toBe(0);
    }
    const secondCall = lazy.mock.calls[1] as unknown;
    expect(Array.isArray(secondCall)).toBe(true);
    if (Array.isArray(secondCall) && secondCall.length > 0) {
      expect((secondCall[0] as Record<string, number>).step).toBe(1);
    }
  });

  it('executes parallel tool calls all at once', async () => {
    const callOrder: string[] = [];
    const parallelTool = tool({
      name: 'p',
      description: 'p',
      input: anySchema(),
      handler: async (x: unknown) => {
        callOrder.push(`start-${(x as { id: string }).id}`);
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push(`end-${(x as { id: string }).id}`);
        return { done: true };
      },
    });
    const responses = [
      toolCallResponse([
        { id: 'c1', name: 'p', arguments: { id: 'a' } },
        { id: 'c2', name: 'p', arguments: { id: 'b' } },
        { id: 'c3', name: 'p', arguments: { id: 'c' } },
      ]),
      textResponse('ok'),
    ];
    let i = 0;
    const adapter = mockAdapter({
      onCall: () => {
        const resp = responses[i];
        if (!resp) throw new Error('Response not found');
        i += 1;
        return resp;
      },
    });
    await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [parallelTool],
      budget: budget({ maxSteps: 5 }),
    });
    // All starts before any end if truly parallel
    const firstEndIndex = callOrder.findIndex((s) => s.startsWith('end-'));
    const startsBeforeFirstEnd = callOrder.slice(0, firstEndIndex);
    expect(startsBeforeFirstEnd).toHaveLength(3);
    expect(startsBeforeFirstEnd.every((s) => s.startsWith('start-'))).toBe(true);
  });

  it('aggregates usage across steps', async () => {
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'search', arguments: {} }]),
      textResponse('done'),
    ];
    let i = 0;
    const adapter = mockAdapter({
      onCall: () => {
        const resp = responses[i];
        if (!resp) throw new Error('Response not found');
        i += 1;
        return resp;
      },
    });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [searchTool],
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Step 1 usage { input: 20, output: 8 } + terminal { input: 10, output: 5 } = { input: 30, output: 13 }
      expect(res.value.usage.input).toBe(30);
      expect(res.value.usage.output).toBe(13);
    }
  });

  it('treats tool_call stopReason with empty toolCalls as terminal', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'hmm', toolCalls: [] },
        usage: { input: 1, output: 1 },
        stopReason: 'tool_call',
      }),
    });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.steps).toHaveLength(0);
    }
  });
});
