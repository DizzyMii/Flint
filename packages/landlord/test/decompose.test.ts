import { describe, expect, it } from 'vitest';
import { decompose } from '../src/decompose.ts';
import { budget } from 'flint/budget';
import { mockAdapter } from 'flint/testing';
import type { NormalizedResponse } from 'flint';

function toolCallResponse(name: string, args: unknown): NormalizedResponse {
  return {
    message: {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc1', name, arguments: args }],
    },
    usage: { input: 20, output: 10 },
    stopReason: 'tool_call',
  };
}

describe('decompose', () => {
  it('returns contracts from emit_plan tool call', async () => {
    const adapter = mockAdapter({
      onCall: () => toolCallResponse('emit_plan', {
        contracts: [
          {
            role: 'backend_engineer',
            objective: 'Build API',
            subPrompt: 'Create a REST API',
            checkpoints: [{ name: 'api_ready', description: 'API is ready', schema: { type: 'object', properties: { endpoints: { type: 'array' } }, required: ['endpoints'] } }],
            outputSchema: { type: 'object' },
          },
        ],
      }),
    });

    const result = await decompose('Build a REST API', {
      adapter,
      model: 'test-model',
      budget: budget({ maxSteps: 5 }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.role).toBe('backend_engineer');
      expect(result.value[0]!.dependsOn).toEqual([]);
      expect(result.value[0]!.maxRetries).toBe(3);
    }
  });

  it('returns error when LLM does not call emit_plan', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'I cannot do that' },
        usage: { input: 10, output: 5 },
        stopReason: 'end',
      }),
    });

    const result = await decompose('Build something', {
      adapter,
      model: 'test-model',
    });

    expect(result.ok).toBe(false);
  });

  it('skips malformed contracts in array', async () => {
    const adapter = mockAdapter({
      onCall: () => toolCallResponse('emit_plan', {
        contracts: [
          { role: 'good', objective: 'x', subPrompt: 'x', checkpoints: [], outputSchema: {} },
          { objective: 'missing role' },
        ],
      }),
    });

    const result = await decompose('test', { adapter, model: 'test-model' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.role).toBe('good');
    }
  });
});
