import { describe, expect, it } from 'vitest';
import { agent } from '../src/agent.ts';
import { NotImplementedError } from '../src/errors.ts';
import { budget } from '../src/budget.ts';
import type { ProviderAdapter } from '../src/adapter.ts';

const mockAdapter: ProviderAdapter = {
  name: 'mock',
  capabilities: {},
  async call() {
    throw new Error('should not reach');
  },
  async *stream() {
    // no-op
  },
};

describe('agent', () => {
  it('is a function and stub throws NotImplementedError', async () => {
    expect(typeof agent).toBe('function');
    await expect(
      agent({
        adapter: mockAdapter,
        model: 'm',
        messages: [],
        budget: budget({ maxSteps: 5 }),
      }),
    ).rejects.toThrow(NotImplementedError);
  });
});
