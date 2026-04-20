import type { ProviderAdapter } from 'flint';
import { budget } from 'flint/budget';
import { FlintError } from 'flint/errors';
import { describe, expect, it } from 'vitest';
import { edge, graph, memoryCheckpointStore, node, state } from '../src/index.ts';

// ---------------------------------------------------------------------------
// Noop adapter used wherever RunContext requires one but no LLM calls happen
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helpers for constructing typical graphs
// ---------------------------------------------------------------------------
type S = { x: number };

function linearGraph() {
  return graph<S>({
    state: state<S>(),
    entry: 'a',
    nodes: {
      a: node<S>(async (s) => ({ x: s.x + 1 })),
      b: node<S>(async (s) => ({ x: s.x * 2 })),
      c: node<S>(async (s) => ({ x: s.x + 10 })),
    },
    edges: [edge<S>('a', 'b'), edge<S>('b', 'c')],
  });
}

// ---------------------------------------------------------------------------
// Structural primitives
// ---------------------------------------------------------------------------
describe('primitives', () => {
  it('node/edge/state return correctly shaped values', () => {
    const s = state<S>();
    expect(s.__type).toBe('state');

    const n = node<S>(async (st) => ({ x: st.x + 1 }));
    expect(n.__type).toBe('node');

    const e = edge<S>('a', 'b', (st) => st.x > 0);
    expect(e.__type).toBe('edge');
    expect(e.from).toBe('a');
    expect(e.to).toBe('b');
    expect(typeof e.when).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// run() — happy paths
// ---------------------------------------------------------------------------
describe('graph.run – linear traversal', () => {
  it('executes a linear multi-node graph and returns final state', async () => {
    const g = linearGraph();
    const result = await g.run({ x: 1 }, makeCtx());
    // a: 1+1=2, b: 2*2=4, c: 4+10=14
    expect(result).toEqual({ ok: true, value: { x: 14 } });
  });

  it('terminal node (no outgoing edges) returns Result.ok immediately', async () => {
    const g = graph<S>({
      state: state<S>(),
      entry: 'only',
      nodes: { only: node<S>(async (s) => ({ x: s.x + 99 })) },
      edges: [],
    });
    const result = await g.run({ x: 0 }, makeCtx());
    expect(result).toEqual({ ok: true, value: { x: 99 } });
  });
});

// ---------------------------------------------------------------------------
// run() — edge conditions (when guards)
// ---------------------------------------------------------------------------
describe('graph.run – edge when guards', () => {
  it('follows the true path when when() returns true', async () => {
    const g = graph<S>({
      state: state<S>(),
      entry: 'start',
      nodes: {
        start: node<S>(async (s) => s),
        positive: node<S>(async (s) => ({ x: s.x + 100 })),
        negative: node<S>(async (s) => ({ x: s.x - 100 })),
      },
      edges: [
        edge<S>('start', 'positive', (s) => s.x > 0),
        edge<S>('start', 'negative', (s) => s.x <= 0),
      ],
    });

    const pos = await g.run({ x: 5 }, makeCtx());
    expect(pos).toEqual({ ok: true, value: { x: 105 } });

    const neg = await g.run({ x: 0 }, makeCtx());
    expect(neg).toEqual({ ok: true, value: { x: -100 } });
  });

  it('returns Result.error with code graph.no_matching_edge when no guard matches', async () => {
    const g = graph<S>({
      state: state<S>(),
      entry: 'start',
      nodes: {
        start: node<S>(async (s) => s),
        other: node<S>(async (s) => s),
      },
      edges: [edge<S>('start', 'other', (s) => s.x > 1000)], // impossible guard
    });

    const result = await g.run({ x: 1 }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(FlintError);
      expect((result.error as FlintError).code).toBe('graph.no_matching_edge');
    }
  });
});

// ---------------------------------------------------------------------------
// run() — fan-out
// ---------------------------------------------------------------------------
describe('graph.run – fan-out', () => {
  it('executes fan-out targets concurrently and shallow-merges state', async () => {
    type FanState = { a: number; b: number; merged?: boolean };
    const g = graph<FanState>({
      state: state<FanState>(),
      entry: 'start',
      nodes: {
        start: node<FanState>(async (s) => s),
        branch1: node<FanState>(async (s) => ({ ...s, a: s.a + 10 })),
        branch2: node<FanState>(async (s) => ({ ...s, b: s.b + 20 })),
      },
      edges: [edge<FanState>('start', ['branch1', 'branch2'])],
    });

    const result = await g.run({ a: 0, b: 0 }, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      // branch1 sets a=10, branch2 sets b=20; shallow merge gives both
      expect(result.value.a).toBe(10);
      expect(result.value.b).toBe(20);
    }
  });

  it('fan-out uses first target in array for next edge lookup', async () => {
    // After fan-out to ['branch1','branch2'], edge from 'branch1' should be followed
    type FanState = { a: number; b: number; terminal: boolean };
    const g = graph<FanState>({
      state: state<FanState>(),
      entry: 'start',
      nodes: {
        start: node<FanState>(async (s) => s),
        branch1: node<FanState>(async (s) => ({ ...s, a: s.a + 1 })),
        branch2: node<FanState>(async (s) => ({ ...s, b: s.b + 1 })),
        done: node<FanState>(async (s) => ({ ...s, terminal: true })),
      },
      edges: [
        edge<FanState>('start', ['branch1', 'branch2']),
        edge<FanState>('branch1', 'done'), // edge from first fan-out target
      ],
    });

    const result = await g.run({ a: 0, b: 0, terminal: false }, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.terminal).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// run() — budget exhaustion
// ---------------------------------------------------------------------------
describe('graph.run – budget exhaustion', () => {
  it('returns Result.error wrapping BudgetExhausted when budget is exceeded', async () => {
    // maxSteps:0 means first consume (stepsUsed becomes 1, 1 > 0) throws immediately
    const g = linearGraph();
    const result = await g.run({ x: 0 }, makeCtx(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Use name check to avoid cross-bundle instanceof failures (tsup inlines classes)
      expect((result.error as Error).name).toBe('BudgetExhausted');
    }
  });

  it('allows exactly maxSteps node executions before exhausting', async () => {
    // With maxSteps:1, first consume (stepsUsed=1, 1>1=false) passes,
    // second consume (stepsUsed=2, 2>1=true) exhausts on node 'b'
    const g = linearGraph(); // a→b→c
    const result = await g.run({ x: 0 }, makeCtx(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as Error).name).toBe('BudgetExhausted');
    }
  });
});

// ---------------------------------------------------------------------------
// runStream() — event ordering
// ---------------------------------------------------------------------------
describe('graph.runStream – event ordering', () => {
  it('yields enter/exit/edge events in correct order for linear graph', async () => {
    const g = linearGraph();
    const events: Array<{ type: string; node?: string; from?: string; to?: string }> = [];

    for await (const ev of g.runStream({ x: 1 }, makeCtx())) {
      if (ev.type === 'enter' || ev.type === 'exit') {
        events.push({ type: ev.type, node: ev.node });
      } else {
        events.push({ type: ev.type, from: ev.from, to: ev.to });
      }
    }

    expect(events).toEqual([
      { type: 'enter', node: 'a' },
      { type: 'exit', node: 'a' },
      { type: 'edge', from: 'a', to: 'b' },
      { type: 'enter', node: 'b' },
      { type: 'exit', node: 'b' },
      { type: 'edge', from: 'b', to: 'c' },
      { type: 'enter', node: 'c' },
      { type: 'exit', node: 'c' },
      // no edge event after terminal node
    ]);
  });

  it('enter event carries pre-execution state, exit event carries post-execution state', async () => {
    const g = graph<S>({
      state: state<S>(),
      entry: 'inc',
      nodes: { inc: node<S>(async (s) => ({ x: s.x + 1 })) },
      edges: [],
    });

    const events: Array<{ type: string; state: S }> = [];
    for await (const ev of g.runStream({ x: 5 }, makeCtx())) {
      events.push({ type: ev.type, state: ev.state });
    }

    expect(events[0]).toEqual({ type: 'enter', state: { x: 5 } });
    expect(events[1]).toEqual({ type: 'exit', state: { x: 6 } });
  });

  it('yields final state in exit event of terminal node', async () => {
    const g = linearGraph();
    const exitEvents: Array<{ node: string; state: S }> = [];
    for await (const ev of g.runStream({ x: 1 }, makeCtx())) {
      if (ev.type === 'exit') {
        exitEvents.push({ node: ev.node, state: ev.state });
      }
    }
    // c: (1+1)*2+10 = 14
    const last = exitEvents[exitEvents.length - 1];
    expect(last).toEqual({ node: 'c', state: { x: 14 } });
  });
});

// ---------------------------------------------------------------------------
// runStream() — error paths (throws, not Result)
// ---------------------------------------------------------------------------
describe('graph.runStream – error propagation', () => {
  it('throws (not Result) on budget exhaustion', async () => {
    const g = linearGraph();
    let caughtError: unknown;
    try {
      for await (const _ev of g.runStream({ x: 0 }, makeCtx(0))) {
        // consume events
      }
    } catch (e) {
      caughtError = e;
    }
    // Use name check to avoid cross-bundle instanceof failures (tsup inlines classes)
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).name).toBe('BudgetExhausted');
  });

  it('throws FlintError with graph.no_matching_edge on unmatched guards', async () => {
    const g = graph<S>({
      state: state<S>(),
      entry: 'start',
      nodes: {
        start: node<S>(async (s) => s),
        other: node<S>(async (s) => s),
      },
      edges: [edge<S>('start', 'other', (s) => s.x > 9999)],
    });

    let caughtError: unknown;
    try {
      for await (const _ev of g.runStream({ x: 1 }, makeCtx())) {
        // consume events
      }
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(FlintError);
    expect((caughtError as FlintError).code).toBe('graph.no_matching_edge');
  });
});

// ---------------------------------------------------------------------------
// memoryCheckpointStore
// ---------------------------------------------------------------------------
describe('memoryCheckpointStore', () => {
  it('save then load returns the saved checkpoint', async () => {
    const store = memoryCheckpointStore<S>();
    await store.save('run-1', 'nodeA', { x: 42 });
    const loaded = await store.load('run-1');
    expect(loaded).toEqual({ nodeId: 'nodeA', state: { x: 42 } });
  });

  it('load returns null for unknown runId', async () => {
    const store = memoryCheckpointStore<S>();
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('save overwrites previous checkpoint for same runId', async () => {
    const store = memoryCheckpointStore<S>();
    await store.save('run-1', 'nodeA', { x: 1 });
    await store.save('run-1', 'nodeB', { x: 2 });
    const loaded = await store.load('run-1');
    expect(loaded).toEqual({ nodeId: 'nodeB', state: { x: 2 } });
  });

  it('delete removes the checkpoint and subsequent load returns null', async () => {
    const store = memoryCheckpointStore<S>();
    await store.save('run-1', 'nodeA', { x: 10 });
    await store.delete('run-1');
    const loaded = await store.load('run-1');
    expect(loaded).toBeNull();
  });

  it('each store instance has independent state', async () => {
    const store1 = memoryCheckpointStore<S>();
    const store2 = memoryCheckpointStore<S>();
    await store1.save('run-1', 'nodeA', { x: 1 });
    const loaded = await store2.load('run-1');
    expect(loaded).toBeNull();
  });
});
