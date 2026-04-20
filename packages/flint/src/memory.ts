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
  return {
    push() {
      throw new NotImplementedError('memory.messages.push');
    },
    slice() {
      throw new NotImplementedError('memory.messages.slice');
    },
    replace() {
      throw new NotImplementedError('memory.messages.replace');
    },
    all() {
      throw new NotImplementedError('memory.messages.all');
    },
    clear() {
      throw new NotImplementedError('memory.messages.clear');
    },
  };
}

export type Scratchpad = {
  note(text: string): void;
  notes(): string[];
  clear(): void;
};

export function scratchpad(): Scratchpad {
  return {
    note() {
      throw new NotImplementedError('memory.scratchpad.note');
    },
    notes() {
      throw new NotImplementedError('memory.scratchpad.notes');
    },
    clear() {
      throw new NotImplementedError('memory.scratchpad.clear');
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
