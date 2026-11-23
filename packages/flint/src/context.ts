import type { ProviderAdapter } from './adapter.ts';
import type { Budget } from './budget.ts';
import type { ModelPricing } from './pricing.ts';
import { approxCount } from './primitives/approx-count.ts';
import { call } from './primitives/call.ts';
import { toTurns } from './transcript.ts';
import type { Logger, Message } from './types.ts';

export type CompactionRecord = {
  /** Transcript index (exclusive) up to which messages are replaced by `summary`. */
  upto: number;
  summary: string;
  reason: 'pressure' | 'economics' | 'forced';
  /** Tokens removed from the prompt (compacted messages plus any previous summary). */
  compactedTokens: number;
  summaryTokens: number;
  /** Expected dollar saving over the horizon, when pricing is known. */
  projectedSavings?: number;
};

export type ContextInfo = {
  model: string;
  step: number;
  budget?: Budget;
  /** Set after the provider rejected the prompt as too long: compact regardless of economics. */
  force?: boolean;
};

export interface ContextStrategy {
  prepare(
    transcript: Message[],
    info: ContextInfo,
  ): Promise<{ messages: Message[]; compaction?: CompactionRecord }>;
}

export type CompactionInput = {
  /** Tokens that would be summarized. */
  compactable: number;
  /** Tokens kept verbatim after the cut. */
  tail: number;
  /** Expected number of further requests that would re-send the prompt. */
  horizon: number;
  /** Pricing of the model doing the work. */
  pricing: ModelPricing;
  /** Pricing of the summarizer model (defaults to `pricing`). */
  summarizerPricing?: ModelPricing;
  /** Expected summary length in tokens. */
  summaryTokens: number;
};

export type CompactionDecision = { compact: boolean; keepCost: number; compactCost: number };

/**
 * Whether summarizing now is cheaper than continuing to re-read the history from cache.
 *
 * Keep: every future request reads the compactable span from cache.
 * Compact: pay the summarizer once (full input + summary output), write the new prefix
 * (summary + tail) to cache once, then read only the summary on every future request.
 *
 * With prompt caching this is usually "keep": cached reads are cheap, so compaction pays off only
 * for large spans over long horizons. That is the point: compaction is a cost decision, not a reflex.
 */
export function compactionDecision(x: CompactionInput): CompactionDecision {
  const p = x.pricing;
  const s = x.summarizerPricing ?? p;
  const read = (p.cacheRead ?? p.input * 0.1) / 1e6;
  const write = (p.cacheWrite ?? p.input * 1.25) / 1e6;
  const keepCost = x.horizon * x.compactable * read;
  const compactCost =
    (x.compactable * s.input) / 1e6 +
    (x.summaryTokens * s.output) / 1e6 +
    (x.summaryTokens + x.tail) * (write - read) +
    x.horizon * x.summaryTokens * read;
  return { compact: compactCost < keepCost, keepCost, compactCost };
}

export type ContextManagerOptions = {
  summarizer: { adapter: ProviderAdapter; model: string; maxTokens?: number };
  /** The working model's context window in tokens. */
  contextWindow: number;
  /** Compact when the prompt exceeds this fraction of the window. Default 0.8. */
  highWater?: number;
  /** Tokens of most recent history always kept verbatim. Default min(20k, 25% of window). */
  keepRecentTokens?: number;
  /** Working-model pricing. Enables economic compaction; without it only window pressure compacts. */
  pricing?: ModelPricing;
  /** Expected remaining requests. Default: budget's remaining steps, else 8. */
  horizon?: (info: ContextInfo) => number;
  /** Do not compact spans smaller than this. Default 4096. */
  minCompactTokens?: number;
  count?: (messages: Message[]) => number;
  /** Resume from a compaction recorded in an event log. */
  restore?: CompactionRecord;
  promptPrefix?: string;
  logger?: Logger;
};

const DEFAULT_PROMPT =
  'You are compacting the history of an agent run so it can continue with less context. Write a dense summary that preserves: the task and its constraints, decisions made and why, facts learned from tool results (exact identifiers, paths, numbers), work completed, and open threads. Omit pleasantries and anything the agent will not need. Output only the summary.';

function render(messages: Message[], previous: string | undefined): string {
  const lines: string[] = [];
  if (previous) lines.push(`[earlier summary]\n${previous}`);
  for (const m of messages) {
    if (m.role === 'tool') {
      lines.push(`[tool result ${m.toolCallId}${m.isError ? ' (error)' : ''}]\n${m.content}`);
    } else if (m.role === 'assistant') {
      if (m.content) lines.push(`[assistant]\n${m.content}`);
      for (const tc of m.toolCalls ?? []) {
        lines.push(`[tool call ${tc.id}] ${tc.name}(${JSON.stringify(tc.arguments)})`);
      }
    } else {
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
      lines.push(`[${m.role}]\n${content}`);
    }
  }
  return lines.join('\n\n');
}

/**
 * Stateful, prefix-stable context management for one conversation.
 *
 * Between compactions the prompt is `system + summary + transcript[upto..]`: it only grows at the
 * end, so the provider cache keeps hitting. A compaction is a single committed event that moves
 * `upto` forward on a turn boundary — never a per-request rewrite that would invalidate the cache.
 */
export function contextManager(opts: ContextManagerOptions): ContextStrategy & {
  readonly state: CompactionRecord | undefined;
} {
  const count = opts.count ?? approxCount;
  const highWater = opts.highWater ?? 0.8;
  const keepRecent = opts.keepRecentTokens ?? Math.min(20_000, Math.floor(opts.contextWindow / 4));
  const minCompact = opts.minCompactTokens ?? 4096;
  let state: CompactionRecord | undefined = opts.restore;

  function leadingSystems(transcript: Message[]): number {
    let i = 0;
    while (i < transcript.length && transcript[i]?.role === 'system') i++;
    return i;
  }

  function view(transcript: Message[], upto: number, summary: string | undefined): Message[] {
    const sys = leadingSystems(transcript);
    const from = Math.max(upto, sys);
    return [
      ...transcript.slice(0, sys),
      // The summary is a user turn: it leaves the system prompt (and its cache entry) untouched,
      // and the view always opens with a user message even when the cut lands before an
      // assistant tool call.
      ...(summary !== undefined
        ? [
            {
              role: 'user' as const,
              content: `Summary of earlier work in this session:\n${summary}`,
            },
          ]
        : []),
      ...transcript.slice(from),
    ];
  }

  /** The latest turn boundary that keeps at least `keepRecent` tokens verbatim. */
  function findCut(transcript: Message[], from: number, minTail: number): number | undefined {
    const turns = toTurns(transcript).filter((t) => t.start > from);
    let best: number | undefined;
    for (const t of turns) {
      if (t.start >= transcript.length - 1) break;
      if (count(transcript.slice(t.start)) < minTail) break;
      best = t.start;
    }
    return best;
  }

  return {
    get state() {
      return state;
    },
    async prepare(transcript, info) {
      if (state && state.upto > transcript.length) state = undefined;
      const sys = leadingSystems(transcript);
      const upto = Math.max(state?.upto ?? sys, sys);
      const current = view(transcript, upto, state?.summary);
      const total = count(current);

      const pressure = total > highWater * opts.contextWindow;
      const cut = findCut(transcript, upto, info.force ? 0 : keepRecent);
      if (cut === undefined) return { messages: current };

      const previousSummaryTokens = state ? count([{ role: 'system', content: state.summary }]) : 0;
      const compactable = count(transcript.slice(upto, cut)) + previousSummaryTokens;
      const tail = count(transcript.slice(cut));
      const summaryTokens = Math.min(
        opts.summarizer.maxTokens ?? 2000,
        Math.ceil(compactable * 0.1),
      );

      let reason: CompactionRecord['reason'] | undefined;
      let projectedSavings: number | undefined;
      if (info.force) reason = 'forced';
      else if (pressure) reason = 'pressure';
      if (opts.pricing && compactable >= minCompact) {
        const remainingSteps = info.budget?.remaining().steps;
        const horizon = opts.horizon?.(info) ?? remainingSteps ?? 8;
        const summarizerPricing = opts.summarizer.adapter.pricing?.(opts.summarizer.model);
        const d = compactionDecision({
          compactable,
          tail,
          horizon,
          pricing: opts.pricing,
          ...(summarizerPricing ? { summarizerPricing } : {}),
          summaryTokens,
        });
        projectedSavings = d.keepCost - d.compactCost;
        if (reason === undefined && d.compact) reason = 'economics';
      }
      if (reason === undefined) return { messages: current };

      const res = await call({
        adapter: opts.summarizer.adapter,
        model: opts.summarizer.model,
        maxTokens: opts.summarizer.maxTokens ?? 2000,
        messages: [
          { role: 'system', content: opts.promptPrefix ?? DEFAULT_PROMPT },
          { role: 'user', content: render(transcript.slice(upto, cut), state?.summary) },
        ],
        ...(info.budget !== undefined ? { budget: info.budget, budgetSteps: 0 } : {}),
      });
      if (!res.ok || !res.value.message.content.trim()) {
        opts.logger?.warn?.('contextManager: summarization failed; continuing uncompacted', {
          error: res.ok ? 'empty summary' : res.error.message,
        });
        return { messages: current };
      }

      state = {
        upto: cut,
        summary: res.value.message.content.trim(),
        reason,
        compactedTokens: compactable,
        summaryTokens: res.value.usage.output,
        ...(projectedSavings !== undefined ? { projectedSavings } : {}),
      };
      return { messages: view(transcript, cut, state.summary), compaction: state };
    },
  };
}
