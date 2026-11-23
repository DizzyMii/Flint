import type { ProviderAdapter } from './adapter.ts';
import { toTurns } from './transcript.ts';
import type { Message } from './types.ts';

export type CompressCtx = {
  budget?: { remaining(): { tokens?: number } };
  model?: string;
};

export type Transform = (messages: Message[], ctx: CompressCtx) => Promise<Message[]>;

export function pipeline(...transforms: Transform[]): Transform {
  return async (messages, ctx) => {
    let current = messages;
    for (const t of transforms) {
      current = await t(current, ctx);
    }
    return current;
  };
}

export function dedup(): Transform {
  return async (messages) => {
    const seen = new Set<string>();
    const result: Message[] = [];
    for (const msg of messages) {
      // Tool results and tool-calling turns are bound to call ids; dropping one orphans its pair.
      if (
        msg.role === 'system' ||
        msg.role === 'tool' ||
        (msg.role === 'assistant' && msg.toolCalls?.length)
      ) {
        result.push(msg);
        continue;
      }
      const contentKey =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const key = `${msg.role}:${contentKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(msg);
    }
    return result;
  };
}

export type TruncateOpts = { maxChars: number };

export function truncateToolResults(opts: TruncateOpts): Transform {
  if (opts.maxChars <= 50) {
    throw new TypeError(`truncateToolResults: maxChars must be > 50 (got ${opts.maxChars})`);
  }
  const { maxChars } = opts;
  return async (messages) => {
    return messages.map((msg) => {
      if (msg.role !== 'tool') return msg;
      if (msg.content.length <= maxChars) return msg;
      const dropped = msg.content.length - maxChars;
      const marker = `…[truncated, ${dropped} chars dropped]`;
      const sliceLen = Math.max(0, maxChars - marker.length);
      return {
        ...msg,
        content: msg.content.slice(0, sliceLen) + marker,
      };
    });
  };
}

export type WindowOpts = {
  keep: number;
  alwaysKeep?: Array<Message['role']>;
};

function validateWindow(opts: WindowOpts, name: string): void {
  if (opts.keep < 0 || !Number.isInteger(opts.keep)) {
    throw new TypeError(`${name}: keep must be a non-negative integer (got ${opts.keep})`);
  }
}

function applyWindow(
  messages: Message[],
  keep: number,
  alwaysKeepRoles: Array<Message['role']>,
  take: 'first' | 'last',
): Message[] {
  const pinned = (m: Message) => alwaysKeepRoles.includes(m.role);
  const turns = toTurns(messages);
  const eligible = turns.filter(
    (t) => !(t.messages.length === 1 && pinned(t.messages[0] as Message)),
  );
  const ordered = take === 'last' ? [...eligible].reverse() : eligible;
  const chosen = new Set<number>();
  let budget = keep;
  for (const turn of ordered) {
    const size = turn.messages.filter((m) => !pinned(m)).length;
    if (size > budget) break;
    budget -= size;
    chosen.add(turn.start);
  }
  const out: Message[] = [];
  for (const turn of turns) {
    if (chosen.has(turn.start)) out.push(...turn.messages);
    else out.push(...turn.messages.filter(pinned).filter(() => turn.messages.length === 1));
  }
  return out;
}

export function windowLast(opts: WindowOpts): Transform {
  validateWindow(opts, 'windowLast');
  const alwaysKeepRoles = opts.alwaysKeep ?? ['system'];
  return async (messages) => applyWindow(messages, opts.keep, alwaysKeepRoles, 'last');
}

export function windowFirst(opts: WindowOpts): Transform {
  validateWindow(opts, 'windowFirst');
  const alwaysKeepRoles = opts.alwaysKeep ?? ['system'];
  return async (messages) => applyWindow(messages, opts.keep, alwaysKeepRoles, 'first');
}

export type SummarizeOpts = {
  when: (messages: Message[]) => boolean;
  adapter: ProviderAdapter;
  model: string;
  keepLast?: number;
  promptPrefix?: string;
};

const DEFAULT_SUMMARIZE_PREFIX =
  'Summarize the following conversation concisely, preserving key facts, decisions, and user intent:';

export function summarize(opts: SummarizeOpts): Transform {
  const keepLast = opts.keepLast ?? 4;
  const promptPrefix = opts.promptPrefix ?? DEFAULT_SUMMARIZE_PREFIX;

  return async (messages) => {
    if (!opts.when(messages)) return messages;
    if (messages.length < keepLast + 2) return messages;

    // Move the cut back to a turn boundary so no tool result is separated from its call.
    let cut = messages.length - keepLast;
    for (const turn of toTurns(messages)) {
      if (turn.start < cut && turn.start + turn.messages.length > cut) cut = turn.start;
    }
    if (cut <= 0) return messages;
    const toSummarize = messages.slice(0, cut);
    const toKeep = messages.slice(cut);

    let summary: string;
    try {
      const resp = await opts.adapter.call({
        model: opts.model,
        messages: [
          { role: 'system', content: promptPrefix },
          { role: 'user', content: JSON.stringify(toSummarize, null, 2) },
        ],
      });
      summary = resp.message.content;
    } catch {
      // Fail-open: compression is best-effort
      return messages;
    }

    return [{ role: 'system', content: `Summary of prior conversation: ${summary}` }, ...toKeep];
  };
}

export function orderForCache(): Transform {
  return async (messages) => {
    const systems: Message[] = [];
    const rest: Message[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') systems.push(msg);
      else rest.push(msg);
    }
    return [...systems, ...rest];
  };
}
