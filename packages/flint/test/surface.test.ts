import { describe, expect, it } from 'vitest';

describe('public surface (source)', () => {
  it('root exports resolve', async () => {
    const mod = await import('../src/index.ts');
    for (const name of [
      'call',
      'stream',
      'validate',
      'tool',
      'execute',
      'count',
      'agent',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('memory subpath resolves', async () => {
    const mod = await import('../src/memory.ts');
    expect(typeof mod.messages).toBe('function');
    expect(typeof mod.scratchpad).toBe('function');
    expect(typeof mod.conversationMemory).toBe('function');
  });

  it('rag subpath resolves', async () => {
    const mod = await import('../src/rag.ts');
    expect(typeof mod.memoryStore).toBe('function');
    expect(typeof mod.chunk).toBe('function');
    expect(typeof mod.retrieve).toBe('function');
  });

  it('compress subpath resolves', async () => {
    const mod = await import('../src/compress.ts');
    for (const name of [
      'pipeline',
      'dedup',
      'truncateToolResults',
      'windowLast',
      'windowFirst',
      'pinSystem',
      'summarize',
      'orderForCache',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('recipes subpath resolves', async () => {
    const mod = await import('../src/recipes.ts');
    for (const name of ['react', 'retryValidate', 'reflect', 'summarize']) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('budget subpath resolves', async () => {
    const mod = await import('../src/budget.ts');
    expect(typeof mod.budget).toBe('function');
  });

  it('errors subpath resolves', async () => {
    const mod = await import('../src/errors.ts');
    for (const name of [
      'FlintError',
      'AdapterError',
      'ValidationError',
      'ToolError',
      'BudgetExhausted',
      'ParseError',
      'TimeoutError',
      'NotImplementedError',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
