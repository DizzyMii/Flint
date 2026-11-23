import type { ProviderAdapter } from 'flint';
import { budget } from 'flint/budget';
import { FlintError } from 'flint/errors';
import { describe, expect, it } from 'vitest';
import {
  type CheckpointStore,
  edge,
  graph,
  memoryCheckpointStore,
  node,
  state,
} from '../src/index.ts';

const noopAdapter: ProviderAdapter = {
  name: 'noop',
  capabilities: {},
  async call() {
    throw new Error('adapter.call not expected in graph tests');
  },
  async *stream() {},
};

function makeCtx(maxSteps = 100) {
  return { adapter: noopAdapter, model: 'test', budget: budget({ maxSteps }) };
}

type V = { visited: string[] };

function visit(name: string) {
  return node<V>(async (s) => ({ visited: [...s.visited, name] }));
}

describe('graph – fan-out / join', () => {
  it('runs each fan-out target once and continues at the join', async () => {
    const seen: string[] = [];
    const track = (name: string) =>
      node<V>(async (s) => {
        seen.push(name);
        return s;
      });
    const g = graph<V>({
      state: state<V>(),
      entry: 'start',
      nodes: { start: track('start'), a: track('a'), b: track('b'), afterB: track('afterB') },
      edges: [edge<V>('start', ['a', 'b']), edge<V>('b', 'afterB')],
    });

    const result = await g.run({ visited: [] }, makeCtx());
    expect(result.ok).toBe(true);
    expect(seen[0]).toBe('start');
    expect(seen.slice(1, 3).sort()).toEqual(['a', 'b']);
    expect(seen[3]).toBe('afterB');
    expect(seen).toHaveLength(4);
  });

  it('evaluates join edges against the merged state', async () => {
    type M = { a?: boolean; b?: boolean; joined?: boolean };
    const g = graph<M>({
      state: state<M>(),
      entry: 'start',
      nodes: {
        start: node<M>((s) => s),
        a: node<M>((s) => ({ ...s, a: true })),
        b: node<M>((s) => ({ ...s, b: true })),
        join: node<M>((s) => ({ ...s, joined: true })),
      },
      edges: [
        edge<M>('start', ['a', 'b']),
        // a only sees its own output, but the guard runs on the merged state
        edge<M>('a', 'join', (s) => s.a === true && s.b === true),
        edge<M>('b', 'join'),
      ],
    });
    const result = await g.run({}, makeCtx());
    expect(result).toEqual({ ok: true, value: { a: true, b: true, joined: true } });
  });

  it('merges only changed keys, later targets winning on conflicts', async () => {
    type M = { a: number; b: number; c: number };
    const g = graph<M>({
      state: state<M>(),
      entry: 'start',
      nodes: {
        start: node<M>((s) => s),
        x: node<M>((s) => ({ ...s, a: 1, c: 1 })),
        y: node<M>((s) => ({ ...s, b: 2, c: 2 })),
      },
      edges: [edge<M>('start', ['x', 'y'])],
    });
    expect(await g.run({ a: 0, b: 0, c: 0 }, makeCtx())).toEqual({
      ok: true,
      value: { a: 1, b: 2, c: 2 },
    });
  });

  it('returns graph.ambiguous_join when targets lead to different nodes', async () => {
    const g = graph<V>({
      state: state<V>(),
      entry: 'start',
      nodes: { start: visit('start'), a: visit('a'), b: visit('b'), x: visit('x'), y: visit('y') },
      edges: [edge<V>('start', ['a', 'b']), edge<V>('a', 'x'), edge<V>('b', 'y')],
    });
    const result = await g.run({ visited: [] }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(FlintError);
      expect((result.error as FlintError).code).toBe('graph.ambiguous_join');
      expect(result.error.message).toContain('a → x');
      expect(result.error.message).toContain('b → y');
    }
  });

  it('ends the graph when every fan-out target is terminal', async () => {
    type M = { a?: number; b?: number };
    const g = graph<M>({
      state: state<M>(),
      entry: 'start',
      nodes: {
        start: node<M>((s) => s),
        a: node<M>((s) => ({ ...s, a: 1 })),
        b: node<M>((s) => ({ ...s, b: 2 })),
      },
      edges: [edge<M>('start', ['a', 'b'])],
    });
    expect(await g.run({}, makeCtx())).toEqual({ ok: true, value: { a: 1, b: 2 } });
  });

  it('supports a nested fan-out from the join node', async () => {
    const seen: string[] = [];
    const track = (name: string) =>
      node<V>((s) => {
        seen.push(name);
        return s;
      });
    const g = graph<V>({
      state: state<V>(),
      entry: 's',
      nodes: {
        s: track('s'),
        a: track('a'),
        b: track('b'),
        j: track('j'),
        c: track('c'),
        d: track('d'),
      },
      edges: [edge<V>('s', ['a', 'b']), edge<V>(['a', 'b'], 'j'), edge<V>('j', ['c', 'd'])],
    });
    const result = await g.run({ visited: [] }, makeCtx());
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(6);
    expect(seen[3]).toBe('j');
  });

  it('emits edge events for fan-out and join transitions in runStream', async () => {
    const g = graph<V>({
      state: state<V>(),
      entry: 'start',
      nodes: { start: visit('start'), a: visit('a'), b: visit('b'), join: visit('join') },
      edges: [edge<V>('start', ['a', 'b']), edge<V>(['a', 'b'], 'join')],
    });
    const edges: string[] = [];
    for await (const ev of g.runStream({ visited: [] }, makeCtx())) {
      if (ev.type === 'edge') edges.push(`${ev.from}->${ev.to}`);
    }
    expect(edges).toEqual(['start->a', 'start->b', 'a->join', 'b->join']);
  });

  it('charges one budget step per fan-out target', async () => {
    const g = graph<V>({
      state: state<V>(),
      entry: 'start',
      nodes: { start: visit('start'), a: visit('a'), b: visit('b'), c: visit('c') },
      edges: [edge<V>('start', ['a', 'b', 'c'])],
    });
    // start + 3 targets = 4 steps
    expect((await g.run({ visited: [] }, makeCtx(4))).ok).toBe(true);
    const result = await g.run({ visited: [] }, makeCtx(3));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.name).toBe('BudgetExhausted');
  });
});

describe('graph – node errors', () => {
  it('returns a thrown node error as Result with code graph.node_failed', async () => {
    const boom = new Error('boom');
    const g = graph<V>({
      state: state<V>(),
      entry: 'a',
      nodes: {
        a: visit('a'),
        b: node<V>(() => {
          throw boom;
        }),
      },
      edges: [edge<V>('a', 'b')],
    });
    const result = await g.run({ visited: [] }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(FlintError);
      expect((result.error as FlintError).code).toBe('graph.node_failed');
      expect(result.error.message).toContain('"b"');
      expect(result.error.cause).toBe(boom);
    }
  });

  it('passes FlintErrors thrown by a node through unchanged', async () => {
    const err = new FlintError('custom', { code: 'custom.code' });
    const g = graph<V>({
      state: state<V>(),
      entry: 'a',
      nodes: {
        a: node<V>(() => {
          throw err;
        }),
      },
      edges: [],
    });
    expect(await g.run({ visited: [] }, makeCtx())).toEqual({ ok: false, error: err });
  });

  it('runStream throws the wrapped node error', async () => {
    const g = graph<V>({
      state: state<V>(),
      entry: 'a',
      nodes: {
        a: node<V>(() => {
          throw new Error('boom');
        }),
      },
      edges: [],
    });
    await expect(async () => {
      for await (const _ev of g.runStream({ visited: [] }, makeCtx())) {
        // drain
      }
    }).rejects.toMatchObject({ code: 'graph.node_failed' });
  });
});

describe('graph – checkpointing', () => {
  function pipeline(seen: string[], failC: boolean) {
    const track = (name: string) =>
      node<V>((s) => {
        seen.push(name);
        if (name === 'c' && failC) throw new Error('crash');
        return { visited: [...s.visited, name] };
      });
    return graph<V>({
      state: state<V>(),
      entry: 'a',
      nodes: { a: track('a'), b: track('b'), c: track('c'), d: track('d') },
      edges: [edge<V>('a', 'b'), edge<V>('b', 'c'), edge<V>('c', 'd')],
    });
  }

  it('resumes from the failed node without re-running earlier nodes', async () => {
    const store = memoryCheckpointStore<V>();
    const checkpoint = { store, runId: 'run-1' };

    const firstSeen: string[] = [];
    const first = await pipeline(firstSeen, true).run({ visited: [] }, makeCtx(), { checkpoint });
    expect(first.ok).toBe(false);
    expect(firstSeen).toEqual(['a', 'b', 'c']);
    expect(await store.load('run-1')).toEqual({ nodeId: 'c', state: { visited: ['a', 'b'] } });

    const secondSeen: string[] = [];
    const second = await pipeline(secondSeen, false).run({ visited: [] }, makeCtx(), {
      checkpoint,
    });
    expect(secondSeen).toEqual(['c', 'd']);
    expect(second).toEqual({ ok: true, value: { visited: ['a', 'b', 'c', 'd'] } });
  });

  it('saves after each node and deletes the checkpoint on completion', async () => {
    const calls: string[] = [];
    const inner = memoryCheckpointStore<V>();
    const store: CheckpointStore<V> = {
      async save(runId, nodeId, st) {
        calls.push(`save:${nodeId}`);
        await inner.save(runId, nodeId, st);
      },
      load: (runId) => inner.load(runId),
      async delete(runId) {
        calls.push('delete');
        await inner.delete(runId);
      },
    };
    const result = await pipeline([], false).run({ visited: [] }, makeCtx(), {
      checkpoint: { store, runId: 'r' },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['save:b', 'save:c', 'save:d', 'delete']);
    expect(await inner.load('r')).toBeNull();
  });

  it('checkpoints at the join after a fan-out', async () => {
    const store = memoryCheckpointStore<V>();
    const saves: string[] = [];
    const g = graph<V>({
      state: state<V>(),
      entry: 'start',
      nodes: {
        start: visit('start'),
        a: visit('a'),
        b: visit('b'),
        join: node<V>(async (s) => {
          saves.push(((await store.load('f')) ?? { nodeId: 'none' }).nodeId);
          return s;
        }),
      },
      edges: [edge<V>('start', ['a', 'b']), edge<V>(['a', 'b'], 'join')],
    });
    const result = await g.run({ visited: [] }, makeCtx(), { checkpoint: { store, runId: 'f' } });
    expect(result.ok).toBe(true);
    expect(saves).toEqual(['join']);
    expect(await store.load('f')).toBeNull();
  });

  it('runStream resumes from the checkpoint too', async () => {
    const store = memoryCheckpointStore<V>();
    await store.save('s', 'c', { visited: ['a', 'b'] });
    const entered: string[] = [];
    for await (const ev of pipeline([], false).runStream({ visited: [] }, makeCtx(), {
      checkpoint: { store, runId: 's' },
    })) {
      if (ev.type === 'enter') entered.push(ev.node);
    }
    expect(entered).toEqual(['c', 'd']);
    expect(await store.load('s')).toBeNull();
  });
});

describe('graph – definition validation', () => {
  const nodes = { a: visit('a'), b: visit('b') };

  it('throws TypeError for an unknown entry node', () => {
    expect(() => graph<V>({ state: state<V>(), entry: 'nope', nodes, edges: [] })).toThrow(
      TypeError,
    );
  });

  it('throws TypeError for an edge to an unknown node', () => {
    expect(() =>
      graph<V>({ state: state<V>(), entry: 'a', nodes, edges: [edge<V>('a', 'missing')] }),
    ).toThrow(/unknown to node "missing"/);
  });

  it('throws TypeError for an edge from an unknown node', () => {
    expect(() =>
      graph<V>({ state: state<V>(), entry: 'a', nodes, edges: [edge<V>(['a', 'ghost'], 'b')] }),
    ).toThrow(/unknown from node "ghost"/);
  });

  it('throws TypeError for an empty to array', () => {
    expect(() =>
      graph<V>({ state: state<V>(), entry: 'a', nodes, edges: [edge<V>('a', [])] }),
    ).toThrow(TypeError);
  });
});
