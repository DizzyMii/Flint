import type { ProviderAdapter } from 'flint';
import type { Logger, Result } from 'flint';
import type { Budget } from 'flint/budget';
import { FlintError } from 'flint/errors';

export type NodeFn<S, _Input = S> = (state: S, ctx: RunContext) => Promise<S> | S;

export type Node<S> = {
  readonly __type: 'node';
  readonly fn: NodeFn<S>;
};

export function node<S>(fn: NodeFn<S>): Node<S> {
  return { __type: 'node', fn };
}

export type EdgeCondition<S> = (state: S) => boolean;

export type Edge<S> = {
  readonly __type: 'edge';
  readonly from: string | string[];
  readonly to: string | string[];
  readonly when?: EdgeCondition<S>;
};

export function edge<S>(
  from: string | string[],
  to: string | string[],
  when?: EdgeCondition<S>,
): Edge<S> {
  return { __type: 'edge', from, to, ...(when ? { when } : {}) };
}

export function state<S>(): { readonly __type: 'state'; readonly __shape: S } {
  return { __type: 'state', __shape: undefined as S };
}

export type GraphDefinition<S> = {
  state: { readonly __type: 'state'; readonly __shape: S };
  entry: string;
  nodes: Record<string, Node<S>>;
  edges: Edge<S>[];
};

export type RunContext = {
  adapter: ProviderAdapter;
  model: string;
  budget: Budget;
  logger?: Logger;
  signal?: AbortSignal;
};

export type GraphEvent<S> =
  | { type: 'enter'; node: string; state: S }
  | { type: 'exit'; node: string; state: S }
  | { type: 'edge'; from: string; to: string; state: S };

export type RunOptions<S> = {
  checkpoint?: { store: CheckpointStore<S>; runId: string };
};

export type Graph<S> = {
  run(initialState: S, ctx: RunContext, opts?: RunOptions<S>): Promise<Result<S>>;
  runStream(initialState: S, ctx: RunContext, opts?: RunOptions<S>): AsyncIterable<GraphEvent<S>>;
};

/** Duck-type check for BudgetExhausted — avoids cross-bundle instanceof failures */
function isBudgetExhausted(e: unknown): e is Error {
  return e instanceof Error && (e as { name?: unknown }).name === 'BudgetExhausted';
}

function isFlintError(e: unknown): e is Error {
  return e instanceof FlintError || isBudgetExhausted(e);
}

function matchesFrom(from: string | string[], nodeName: string): boolean {
  return Array.isArray(from) ? from.includes(nodeName) : from === nodeName;
}

function targetsOf(to: string | string[]): string[] {
  return Array.isArray(to) ? to : [to];
}

/** Shallow-merges, in target order, only the keys each target changed relative to `pre` */
function mergeFanOut<S>(pre: S, results: S[]): S {
  const base = pre as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base };
  for (const r of results as Record<string, unknown>[]) {
    for (const [k, v] of Object.entries(r)) {
      if (!Object.hasOwn(base, k) || !Object.is(base[k], v)) merged[k] = v;
    }
  }
  return merged as S;
}

function validate<S>(def: GraphDefinition<S>): void {
  const has = (name: string) => Object.hasOwn(def.nodes, name);
  if (!has(def.entry)) {
    throw new TypeError(`graph: entry node "${def.entry}" is not defined in nodes`);
  }
  def.edges.forEach((e, i) => {
    for (const [side, names] of [
      ['from', targetsOf(e.from)],
      ['to', targetsOf(e.to)],
    ] as const) {
      if (names.length === 0) {
        throw new TypeError(`graph: edge #${i} has an empty "${side}" array`);
      }
      for (const name of names) {
        if (!has(name)) {
          throw new TypeError(`graph: edge #${i} references unknown ${side} node "${name}"`);
        }
      }
    }
  });
}

export function graph<S>(def: GraphDefinition<S>): Graph<S> {
  validate(def);

  function findEdgesFrom(nodeName: string): Edge<S>[] {
    return def.edges.filter((e) => matchesFrom(e.from, nodeName));
  }

  function matchEdge(nodeName: string, outgoing: Edge<S>[], st: S): Edge<S> {
    const matching = outgoing.find((e) => e.when === undefined || e.when(st));
    if (matching === undefined) {
      throw new FlintError(`No matching edge from node ${nodeName}`, {
        code: 'graph.no_matching_edge',
        cause: { node: nodeName, state: st },
      });
    }
    return matching;
  }

  async function executeNodeFn(nodeName: string, st: S, ctx: RunContext): Promise<S> {
    const n = def.nodes[nodeName];
    if (n === undefined || !Object.hasOwn(def.nodes, nodeName)) {
      throw new FlintError(`Node "${nodeName}" not found in graph`, {
        code: 'graph.node_not_found',
      });
    }
    try {
      return await n.fn(st, ctx);
    } catch (e) {
      if (isFlintError(e)) throw e;
      const reason = e instanceof Error ? e.message : String(e);
      throw new FlintError(`Node "${nodeName}" failed: ${reason}`, {
        code: 'graph.node_failed',
        cause: e,
      });
    }
  }

  function resolveJoin(targets: string[], st: S): string | undefined {
    const nexts = targets.map((t) => {
      const outgoing = findEdgesFrom(t);
      return outgoing.length === 0 ? undefined : targetsOf(matchEdge(t, outgoing, st).to);
    });
    const distinct = new Set(nexts.flatMap((n) => (n === undefined ? [] : [n.join(',')])));
    if (distinct.size === 0) return undefined;
    const join = nexts.find((n) => n !== undefined);
    if (distinct.size > 1 || join === undefined || join.length !== 1 || join[0] === undefined) {
      const detail = targets
        .map((t, i) => `${t} → ${nexts[i] === undefined ? '(end)' : nexts[i]?.join(', ')}`)
        .join('; ');
      throw new FlintError(`Fan-out targets do not converge on a single join node (${detail})`, {
        code: 'graph.ambiguous_join',
        cause: { targets, next: nexts },
      });
    }
    return join[0];
  }

  async function* execute(
    initialState: S,
    ctx: RunContext,
    opts?: RunOptions<S>,
  ): AsyncGenerator<GraphEvent<S>, S> {
    const cp = opts?.checkpoint;
    let st = initialState;
    let currentNode = def.entry;
    const saved = cp ? await cp.store.load(cp.runId) : null;
    if (saved) {
      currentNode = saved.nodeId;
      st = saved.state;
    }

    for (;;) {
      ctx.budget.consume({ input: 0, output: 0 });
      yield { type: 'enter', node: currentNode, state: st };
      st = await executeNodeFn(currentNode, st, ctx);
      yield { type: 'exit', node: currentNode, state: st };

      const outgoing = findEdgesFrom(currentNode);
      let next: string | undefined;

      if (outgoing.length > 0) {
        const targets = targetsOf(matchEdge(currentNode, outgoing, st).to);
        if (targets.length === 1) {
          next = targets[0];
          if (next !== undefined) yield { type: 'edge', from: currentNode, to: next, state: st };
        } else {
          // Fan-out: every target runs concurrently on the pre-fan-out state
          const preState = st;
          for (const _t of targets) ctx.budget.consume({ input: 0, output: 0 });
          for (const t of targets) {
            yield { type: 'edge', from: currentNode, to: t, state: preState };
            yield { type: 'enter', node: t, state: preState };
          }
          const results = await Promise.all(targets.map((t) => executeNodeFn(t, preState, ctx)));
          for (const [i, t] of targets.entries()) {
            yield { type: 'exit', node: t, state: results[i] as S };
          }
          st = mergeFanOut(preState, results);
          next = resolveJoin(targets, st);
          if (next !== undefined) {
            for (const t of targets) {
              if (findEdgesFrom(t).length > 0) yield { type: 'edge', from: t, to: next, state: st };
            }
          }
        }
      }

      if (next === undefined) {
        if (cp) await cp.store.delete(cp.runId);
        return st;
      }
      if (cp) await cp.store.save(cp.runId, next, st);
      currentNode = next;
    }
  }

  return {
    async run(initialState, ctx, opts) {
      try {
        const it = execute(initialState, ctx, opts);
        for (;;) {
          const r = await it.next();
          if (r.done) return { ok: true, value: r.value };
        }
      } catch (e) {
        if (isFlintError(e)) return { ok: false, error: e };
        return {
          ok: false,
          error: new FlintError('Graph run failed', { code: 'graph.run_failed', cause: e }),
        };
      }
    },

    runStream(initialState, ctx, opts) {
      return execute(initialState, ctx, opts);
    },
  };
}

export interface CheckpointStore<S> {
  save(runId: string, nodeId: string, state: S): Promise<void>;
  load(runId: string): Promise<{ nodeId: string; state: S } | null>;
  delete(runId: string): Promise<void>;
}

export function memoryCheckpointStore<S>(): CheckpointStore<S> {
  const store = new Map<string, { nodeId: string; state: S }>();

  return {
    async save(runId, nodeId, st) {
      store.set(runId, { nodeId, state: st });
    },
    async load(runId) {
      return store.get(runId) ?? null;
    },
    async delete(runId) {
      store.delete(runId);
    },
  };
}
