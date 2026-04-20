import type { ProviderAdapter } from './adapter.ts';
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
      if (msg.role === 'system') {
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
    throw new TypeError(
      `truncateToolResults: maxChars must be > 50 (got ${opts.maxChars})`,
    );
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
  // Partition with original indices
  const kept: Array<{ index: number; msg: Message }> = [];
  const eligible: Array<{ index: number; msg: Message }> = [];
  messages.forEach((msg, index) => {
    if (alwaysKeepRoles.includes(msg.role)) {
      kept.push({ index, msg });
    } else {
      eligible.push({ index, msg });
    }
  });

  const taken =
    take === 'last' ? eligible.slice(Math.max(0, eligible.length - keep)) : eligible.slice(0, keep);

  const merged = [...kept, ...taken].sort((a, b) => a.index - b.index);
  return merged.map((x) => x.msg);
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

    const toSummarize = messages.slice(0, messages.length - keepLast);
    const toKeep = messages.slice(messages.length - keepLast);

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

    return [
      { role: 'system', content: `Summary of prior conversation: ${summary}` },
      ...toKeep,
    ];
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
