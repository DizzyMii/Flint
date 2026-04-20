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

export type Graph<S> = {
  run(initialState: S, ctx: RunContext): Promise<Result<S>>;
  runStream(initialState: S, ctx: RunContext): AsyncIterable<GraphEvent<S>>;
};

/** Duck-type check for BudgetExhausted — avoids cross-bundle instanceof failures */
function isBudgetExhausted(e: unknown): e is Error {
  return e instanceof Error && (e as { name?: unknown }).name === 'BudgetExhausted';
}

function matchesFrom(from: string | string[], nodeName: string): boolean {
  return Array.isArray(from) ? from.includes(nodeName) : from === nodeName;
}

function resolveNext(
  to: string | string[],
): { fanOut: false; next: string } | { fanOut: true; targets: string[] } {
  if (Array.isArray(to)) {
    if (to.length > 1) {
      return { fanOut: true, targets: to };
    }
    const next = to[0];
    if (next === undefined) {
      throw new FlintError('Edge has empty to array', { code: 'graph.invalid_edge' });
    }
    return { fanOut: false, next };
  }
  return { fanOut: false, next: to };
}

export function graph<S>(def: GraphDefinition<S>): Graph<S> {
  function findEdgesFrom(nodeName: string): Edge<S>[] {
    return def.edges.filter((e) => matchesFrom(e.from, nodeName));
  }

  async function executeNodeFn(nodeName: string, st: S, ctx: RunContext): Promise<S> {
    const n = def.nodes[nodeName];
    if (n === undefined) {
      throw new FlintError(`Node "${nodeName}" not found in graph`, {
        code: 'graph.node_not_found',
      });
    }
    return n.fn(st, ctx);
  }

  return {
    async run(initialState, ctx) {
      let st = initialState;
      let currentNode = def.entry;

      for (;;) {
        // Consume budget before each node execution
        try {
          ctx.budget.consume({ input: 0, output: 0 });
        } catch (e) {
          if (isBudgetExhausted(e)) {
            return { ok: false, error: e };
          }
          throw e;
        }

        // Execute current node
        st = await executeNodeFn(currentNode, st, ctx);

        // Find all outgoing edges from current node
        const outgoing = findEdgesFrom(currentNode);

        if (outgoing.length === 0) {
          // Terminal node — no outgoing edges
          return { ok: true, value: st };
        }

        // Find first matching edge
        const matching = outgoing.find((e) => e.when === undefined || e.when(st));

        if (matching === undefined) {
          return {
            ok: false,
            error: new FlintError(`No matching edge from node ${currentNode}`, {
              code: 'graph.no_matching_edge',
              cause: { node: currentNode, state: st },
            }),
          };
        }

        // Determine next node(s)
        const resolved = resolveNext(matching.to);
        if (resolved.fanOut) {
          // Fan-out: execute all targets concurrently with pre-fan-out state
          const preState = st;
          const resolvedStates = await Promise.all(
            resolved.targets.map((targetNode) => executeNodeFn(targetNode, preState, ctx)),
          );
          // Shallow merge all resolved states
          st = Object.assign({} as object, ...(resolvedStates as object[])) as S;
          // Use first target for next edge lookup (targets.length > 1 guaranteed by resolveNext)
          const firstTarget = resolved.targets[0];
          if (firstTarget === undefined)
            throw new FlintError('Internal: fan-out targets empty', { code: 'graph.invalid_edge' });
          currentNode = firstTarget;
        } else {
          currentNode = resolved.next;
        }
      }
    },

    async *runStream(initialState, ctx) {
      let st = initialState;
      let currentNode = def.entry;

      for (;;) {
        // Consume budget — if BudgetExhausted is thrown, it propagates from the iterator
        ctx.budget.consume({ input: 0, output: 0 });

        // Enter event before node fn
        yield { type: 'enter' as const, node: currentNode, state: st };

        // Execute current node
        st = await executeNodeFn(currentNode, st, ctx);

        // Exit event after node fn
        yield { type: 'exit' as const, node: currentNode, state: st };

        // Find all outgoing edges from current node
        const outgoing = findEdgesFrom(currentNode);

        if (outgoing.length === 0) {
          // Terminal node — return naturally
          return;
        }

        // Find first matching edge
        const matching = outgoing.find((e) => e.when === undefined || e.when(st));

        if (matching === undefined) {
          throw new FlintError(`No matching edge from node ${currentNode}`, {
            code: 'graph.no_matching_edge',
            cause: { node: currentNode, state: st },
          });
        }

        // Determine next node(s)
        const fromNode = currentNode;
        const resolved = resolveNext(matching.to);

        if (resolved.fanOut) {
          // Fan-out: execute all targets concurrently with pre-fan-out state
          const preState = st;
          const resolvedStates = await Promise.all(
            resolved.targets.map((targetNode) => executeNodeFn(targetNode, preState, ctx)),
          );
          // Shallow merge all resolved states
          st = Object.assign({} as object, ...(resolvedStates as object[])) as S;
          const firstTarget = resolved.targets[0];
          if (firstTarget === undefined)
            throw new FlintError('Internal: fan-out targets empty', { code: 'graph.invalid_edge' });
          yield { type: 'edge' as const, from: fromNode, to: firstTarget, state: st };
          currentNode = firstTarget;
        } else {
          yield { type: 'edge' as const, from: fromNode, to: resolved.next, state: st };
          currentNode = resolved.next;
        }
      }
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
