import { describe, expect, it } from 'vitest';
import { validateCheckpoint } from '../src/validate.ts';
import { mockAdapter } from 'flint/testing';
import type { Checkpoint } from '../src/contract.ts';
import type { NormalizedResponse } from 'flint';

function judgeResponse(passed: boolean): NormalizedResponse {
  return {
    message: { role: 'assistant', content: JSON.stringify({ passed, explanation: passed ? 'Looks good' : 'Missing required field' }) },
    usage: { input: 15, output: 8 },
    stopReason: 'end',
  };
}

const checkpoint: Checkpoint = {
  name: 'api_ready',
  description: 'API endpoints have been created',
  schema: {
    type: 'object',
    properties: { endpoints: { type: 'array' } },
    required: ['endpoints'],
  },
};

describe('validateCheckpoint', () => {
  it('tier 1 fails immediately when JSON Schema is violated — no LLM call made', async () => {
    const adapter = mockAdapter({ onCall: () => { throw new Error('should not be called') } });

    const result = await validateCheckpoint(
      { wrongField: 'value' },
      checkpoint,
      { adapter, model: 'test-model' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(false);
      expect(result.value.explanation).toMatch(/endpoints/);
    }
  });

  it('tier 2 LLM judge is called when JSON Schema passes', async () => {
    let judgeCallCount = 0;
    const adapter = mockAdapter({
      onCall: () => { judgeCallCount++; return judgeResponse(true); },
    });

    const result = await validateCheckpoint(
      { endpoints: ['/api/users', '/api/posts'] },
      checkpoint,
      { adapter, model: 'test-model' },
    );

    expect(judgeCallCount).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(true);
    }
  });

  it('tier 2 can return failed verdict', async () => {
    const adapter = mockAdapter({ onCall: () => judgeResponse(false) });

    const result = await validateCheckpoint(
      { endpoints: [] },
      checkpoint,
      { adapter, model: 'test-model' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.passed).toBe(false);
      expect(result.value.explanation).toBeDefined();
    }
  });

  it('returns error when LLM response is not valid JSON', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'not json at all' },
        usage: { input: 5, output: 3 },
        stopReason: 'end',
      }),
    });

    const result = await validateCheckpoint(
      { endpoints: ['/foo'] },
      checkpoint,
      { adapter, model: 'test-model' },
    );

    expect(result.ok).toBe(false);
  });
});
