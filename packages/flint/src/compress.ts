import type { ProviderAdapter } from './adapter.ts';
import { NotImplementedError } from './errors.ts';
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
  return async () => {
    throw new NotImplementedError('compress.dedup');
  };
}

export type TruncateOpts = { maxChars: number };
export function truncateToolResults(_opts: TruncateOpts): Transform {
  return async () => {
    throw new NotImplementedError('compress.truncateToolResults');
  };
}

export type WindowOpts = { keep: number; alwaysKeep?: Array<Message['role']> };
export function windowLast(_opts: WindowOpts): Transform {
  return async () => {
    throw new NotImplementedError('compress.windowLast');
  };
}

export function windowFirst(_opts: WindowOpts): Transform {
  return async () => {
    throw new NotImplementedError('compress.windowFirst');
  };
}

export function pinSystem(): Transform {
  return async () => {
    throw new NotImplementedError('compress.pinSystem');
  };
}

export type SummarizeOpts = {
  when: (messages: Message[]) => boolean;
  adapter: ProviderAdapter;
  model: string;
  keepLast?: number;
};
export function summarize(_opts: SummarizeOpts): Transform {
  return async () => {
    throw new NotImplementedError('compress.summarize');
  };
}

export function orderForCache(): Transform {
  return async () => {
    throw new NotImplementedError('compress.orderForCache');
  };
}
