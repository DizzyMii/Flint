import { describe, expect, it } from 'vitest';
import type { Doc, Filter, Match, VectorStore } from '../src/rag.ts';
import { chunk, memoryStore, retrieve } from '../src/rag.ts';

// ---------------------------------------------------------------------------
// memoryStore
// ---------------------------------------------------------------------------

describe('memoryStore', () => {
  it('returns an object with upsert, query, and delete functions', () => {
    const s = memoryStore();
    expect(typeof s.upsert).toBe('function');
    expect(typeof s.query).toBe('function');
    expect(typeof s.delete).toBe('function');
  });

  it('upserts new docs and returns them via query', async () => {
    const s = memoryStore();
    const doc: Doc = { id: 'a', text: 'hello', embedding: [1, 0] };
    await s.upsert([doc]);
    const results = await s.query([1, 0], 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('a');
    expect(results[0]?.text).toBe('hello');
  });

  it('replaces existing doc when upserting same id', async () => {
    const s = memoryStore();
    await s.upsert([{ id: 'a', text: 'old', embedding: [1, 0] }]);
    await s.upsert([{ id: 'a', text: 'new', embedding: [1, 0] }]);
    const results = await s.query([1, 0], 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe('new');
  });

  it('throws TypeError when upserting a doc with mismatched embedding dimension', async () => {
    const s = memoryStore();
    await s.upsert([{ id: 'a', text: 'first', embedding: [1, 0] }]);
    await expect(
      s.upsert([{ id: 'b', text: 'second', embedding: [1, 0, 0] }]),
    ).rejects.toThrow(TypeError);
  });

  it('returns results sorted by cosine similarity descending', async () => {
    const s = memoryStore();
    // doc "b" is perfectly aligned with query, doc "a" is orthogonal
    await s.upsert([
      { id: 'a', text: 'orthogonal', embedding: [0, 1] },
      { id: 'b', text: 'aligned', embedding: [1, 0] },
    ]);
    const results = await s.query([1, 0], 2);
    expect(results[0]?.id).toBe('b');
    expect(results[1]?.id).toBe('a');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('returns only top-k results', async () => {
    const s = memoryStore();
    await s.upsert([
      { id: 'a', text: 'a', embedding: [1, 0] },
      { id: 'b', text: 'b', embedding: [0.9, 0.1] },
      { id: 'c', text: 'c', embedding: [0, 1] },
    ]);
    const results = await s.query([1, 0], 2);
    expect(results).toHaveLength(2);
  });

  it('filter narrows results to docs matching all filter key-value pairs', async () => {
    const s = memoryStore();
    await s.upsert([
      { id: 'a', text: 'a', embedding: [1, 0], metadata: { kind: 'note', lang: 'en' } },
      { id: 'b', text: 'b', embedding: [1, 0], metadata: { kind: 'fact', lang: 'en' } },
      { id: 'c', text: 'c', embedding: [1, 0], metadata: { kind: 'note', lang: 'fr' } },
    ]);
    const results = await s.query([1, 0], 10, { kind: 'note', lang: 'en' });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('a');
  });

  it('filter excludes docs with no metadata', async () => {
    const s = memoryStore();
    await s.upsert([
      { id: 'a', text: 'a', embedding: [1, 0] },
      { id: 'b', text: 'b', embedding: [1, 0], metadata: { kind: 'note' } },
    ]);
    const results = await s.query([1, 0], 10, { kind: 'note' });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('b');
  });

  it('delete removes docs by id', async () => {
    const s = memoryStore();
    await s.upsert([
      { id: 'a', text: 'a', embedding: [1, 0] },
      { id: 'b', text: 'b', embedding: [0, 1] },
    ]);
    await s.delete(['a']);
    const results = await s.query([1, 0], 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('b');
  });

  it('query on empty store returns empty array', async () => {
    const s = memoryStore();
    const results = await s.query([1, 0], 5);
    expect(results).toEqual([]);
  });

  it('does not include deleted ids that were never in store', async () => {
    const s = memoryStore();
    await s.upsert([{ id: 'a', text: 'a', embedding: [1, 0] }]);
    await s.delete(['nonexistent']);
    const results = await s.query([1, 0], 5);
    expect(results).toHaveLength(1);
  });

  it('is immutable — mutating the input Doc after upsert does not affect the store', async () => {
    const s = memoryStore();
    const doc: Doc = { id: 'a', text: 'original', embedding: [1, 0] };
    await s.upsert([doc]);
    // mutate after upsert
    doc.text = 'mutated';
    doc.embedding[0] = 999;
    const results = await s.query([1, 0], 5);
    expect(results[0]?.text).toBe('original');
    expect(results[0]?.score).toBeCloseTo(1, 5);
  });

  it('score is 0 for a zero-norm query vector (no NaN in results)', async () => {
    const s = memoryStore();
    await s.upsert([{ id: 'a', text: 'a', embedding: [1, 0] }]);
    const results = await s.query([0, 0], 5);
    expect(results[0]?.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// chunk
// ---------------------------------------------------------------------------

describe('chunk', () => {
  it('splits text into non-overlapping chunks of the given size', () => {
    expect(chunk('abcdefgh', { size: 3 })).toEqual(['abc', 'def', 'gh']);
  });

  it('overlap=0 produces contiguous non-repeating chunks', () => {
    expect(chunk('abcdef', { size: 2, overlap: 0 })).toEqual(['ab', 'cd', 'ef']);
  });

  it('overlap>0 repeats characters between adjacent chunks', () => {
    // size=4, overlap=2 → step=2
    // 'abcdef' (len=6): starts at 0,2,4 → 'abcd','cdef','ef'
    expect(chunk('abcdef', { size: 4, overlap: 2 })).toEqual(['abcd', 'cdef', 'ef']);
  });

  it('text shorter than size returns a single chunk', () => {
    expect(chunk('hi', { size: 10 })).toEqual(['hi']);
  });

  it('empty string returns empty array', () => {
    expect(chunk('', { size: 5 })).toEqual([]);
  });

  it('throws TypeError when size <= 0', () => {
    expect(() => chunk('abc', { size: 0 })).toThrow(TypeError);
    expect(() => chunk('abc', { size: -1 })).toThrow(TypeError);
  });

  it('throws TypeError when overlap >= size', () => {
    expect(() => chunk('abc', { size: 3, overlap: 3 })).toThrow(TypeError);
    expect(() => chunk('abc', { size: 3, overlap: 4 })).toThrow(TypeError);
  });

  it('last chunk may be shorter than size', () => {
    const chunks = chunk('abcde', { size: 3 });
    expect(chunks[chunks.length - 1]).toBe('de');
  });
});

// ---------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------

describe('retrieve', () => {
  function makeEmbedder(vec: number[]) {
    return {
      embed: async (texts: string[]) => texts.map(() => vec),
      dimensions: vec.length,
    };
  }

  it('calls embedder.embed exactly once with [query]', async () => {
    const calls: string[][] = [];
    const embedder = {
      embed: async (texts: string[]) => {
        calls.push(texts);
        return [[1, 0]];
      },
      dimensions: 2,
    };
    const store = memoryStore();
    await store.upsert([{ id: 'a', text: 'a', embedding: [1, 0] }]);
    await retrieve('hello', { embedder, store, k: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['hello']);
  });

  it('passes the first embedding vector to store.query', async () => {
    const queriedVecs: number[][] = [];
    const fakeStore: VectorStore = {
      async upsert() {},
      async query(vec, _k, _filter) {
        queriedVecs.push(vec);
        return [];
      },
      async delete() {},
    };
    const embedder = makeEmbedder([0.5, 0.5]);
    await retrieve('test', { embedder, store: fakeStore, k: 3 });
    expect(queriedVecs).toHaveLength(1);
    expect(queriedVecs[0]).toEqual([0.5, 0.5]);
  });

  it('forwards k to store.query', async () => {
    const queriedKs: number[] = [];
    const fakeStore: VectorStore = {
      async upsert() {},
      async query(_vec, k) {
        queriedKs.push(k);
        return [];
      },
      async delete() {},
    };
    await retrieve('test', { embedder: makeEmbedder([1, 0]), store: fakeStore, k: 7 });
    expect(queriedKs[0]).toBe(7);
  });

  it('forwards filter to store.query when provided', async () => {
    const capturedFilters: Array<Filter | undefined> = [];
    const fakeStore: VectorStore = {
      async upsert() {},
      async query(_vec, _k, filter) {
        capturedFilters.push(filter);
        return [];
      },
      async delete() {},
    };
    const filter: Filter = { kind: 'note' };
    await retrieve('test', { embedder: makeEmbedder([1, 0]), store: fakeStore, k: 3, filter });
    expect(capturedFilters[0]).toEqual({ kind: 'note' });
  });

  it('does not pass filter when not provided', async () => {
    const callArgs: Array<[number[], number, Filter | undefined]> = [];
    const fakeStore: VectorStore = {
      async upsert() {},
      async query(vec, k, filter) {
        callArgs.push([vec, k, filter]);
        return [];
      },
      async delete() {},
    };
    await retrieve('test', { embedder: makeEmbedder([1, 0]), store: fakeStore, k: 3 });
    // filter arg should not have been passed (undefined means the key wasn't set)
    expect(callArgs[0]?.[2]).toBeUndefined();
  });

  it('returns the Match[] results from store.query', async () => {
    const fakeMatches: Match[] = [{ id: 'x', text: 'hello', score: 0.99 }];
    const fakeStore: VectorStore = {
      async upsert() {},
      async query() { return fakeMatches; },
      async delete() {},
    };
    const results = await retrieve('q', { embedder: makeEmbedder([1, 0]), store: fakeStore, k: 1 });
    expect(results).toBe(fakeMatches);
  });
});
