import { NotImplementedError } from './errors.ts';
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
  append(m: Message): void;
  messages(): Message[];
  summary(): string | undefined;
  clear(): void;
};

export function conversationMemory(_opts: ConversationMemoryOpts): ConversationMemory {
  return {
    append() {
      throw new NotImplementedError('memory.conversationMemory.append');
    },
    messages() {
      throw new NotImplementedError('memory.conversationMemory.messages');
    },
    summary() {
      throw new NotImplementedError('memory.conversationMemory.summary');
    },
    clear() {
      throw new NotImplementedError('memory.conversationMemory.clear');
    },
  };
}
