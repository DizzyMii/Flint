import { describe, expect, it } from 'vitest';
import { chunk, memoryStore, retrieve } from '../src/rag.ts';
import { NotImplementedError } from '../src/errors.ts';

describe('rag', () => {
  it('memoryStore() returns VectorStore methods', () => {
    const s = memoryStore();
    expect(typeof s.upsert).toBe('function');
    expect(typeof s.query).toBe('function');
    expect(typeof s.delete).toBe('function');
  });

  it('memoryStore methods throw NotImplementedError', async () => {
    const s = memoryStore();
    await expect(s.upsert([])).rejects.toThrow(NotImplementedError);
    await expect(s.query([0], 5)).rejects.toThrow(NotImplementedError);
    await expect(s.delete([])).rejects.toThrow(NotImplementedError);
  });

  it('chunk() is a function and stub throws', () => {
    expect(typeof chunk).toBe('function');
    expect(() => chunk('x', { size: 100, overlap: 10 })).toThrow(NotImplementedError);
  });

  it('retrieve() is a function and stub throws', async () => {
    expect(typeof retrieve).toBe('function');
    const store = memoryStore();
    const embedder = { embed: async (_: string[]) => [[0]], dimensions: 1 };
    await expect(retrieve('q', { embedder, store, k: 3 })).rejects.toThrow(
      NotImplementedError,
    );
  });
});
