import type { Message } from './types.ts';

export type Messages = {
  push(m: Message): void;
  slice(from: number, to?: number): Message[];
  replace(index: number, m: Message): void;
  all(): Message[];
  clear(): void;
};

export function messages(): Messages {
  const store: Message[] = [];
  return {
    push(m) {
      store.push(m);
    },
    slice(from, to) {
      return store.slice(from, to);
    },
    replace(index, m) {
      if (index < 0 || index >= store.length) return;
      store[index] = m;
    },
    all() {
      return [...store];
    },
    clear() {
      store.length = 0;
    },
  };
}

export type Scratchpad = {
  note(text: string): void;
  notes(): string[];
  clear(): void;
};

export function scratchpad(): Scratchpad {
  const store: string[] = [];
  return {
    note(text) {
      store.push(text);
    },
    notes() {
      return [...store];
    },
    clear() {
      store.length = 0;
    },
  };
}

export type ConversationMemoryOpts = {
  max: number;
  summarizeAt: number;
  summarizer: (messages: Message[]) => Promise<string>;
};

export type ConversationMemory = {
  append(m: Message): Promise<void>;
  messages(): Message[];
  summary(): string | undefined;
  clear(): void;
};

export function conversationMemory(opts: ConversationMemoryOpts): ConversationMemory {
  const store: Message[] = [];
  let latestSummary: string | undefined;

  return {
    async append(m) {
      store.push(m);
      if (store.length >= opts.summarizeAt) {
        const keepCount = opts.max - opts.summarizeAt;
        const toSummarize = store.slice(0, store.length - keepCount);
        const kept = store.slice(store.length - keepCount);
        try {
          const text = await opts.summarizer(toSummarize);
          latestSummary = text;
          const summaryMessage: Message = {
            role: 'system',
            content: `Summary of prior conversation: ${text}`,
          };
          store.length = 0;
          store.push(summaryMessage, ...kept);
        } catch {
          // fail-open: leave store unchanged, do not store summary
        }
      }
    },
    messages() {
      return [...store];
    },
    summary() {
      return latestSummary;
    },
    clear() {
      store.length = 0;
      latestSummary = undefined;
    },
  };
}
