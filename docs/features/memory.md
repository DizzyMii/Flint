# Memory

Manage conversation history and agent scratchpad state.

Flint ships three memory primitives — `messages()`, `scratchpad()`, and `conversationMemory()` — that cover the full range from simple REPL loops to long-running agents that need automatic history compression.

## Importing

```ts
import { messages, scratchpad, conversationMemory } from 'flint/memory';
import type { Messages, Scratchpad, ConversationMemory, ConversationMemoryOpts } from 'flint/memory';
```

---

## `messages()`

A lightweight, ordered store for `Message` objects. Use this when you control the conversation loop yourself and just need a reliable place to accumulate turns.

### Type

```ts
type Messages = {
  push(m: Message): void;
  slice(from: number, to?: number): Message[];
  replace(index: number, m: Message): void;
  all(): Message[];
  clear(): void;
};

function messages(): Messages;
```

### Methods

| Method | Description |
|--------|-------------|
| `push(m)` | Append a message to the store. |
| `all()` | Return a snapshot copy of all messages. |
| `slice(from, to?)` | Return a sub-range of messages (same semantics as `Array.prototype.slice`). |
| `replace(index, m)` | Overwrite a specific message by index — useful for tool-result injection. |
| `clear()` | Remove all messages. |

### Example

```ts
import { messages } from 'flint/memory';
import { call } from 'flint/call';

const history = messages();

// First turn
history.push({ role: 'user', content: 'Hello!' });
const reply = await call({ messages: history.all(), model: 'gpt-4o' });
history.push({ role: 'assistant', content: reply.content });

// Second turn — full history is passed automatically
history.push({ role: 'user', content: 'What did I just say?' });
const reply2 = await call({ messages: history.all(), model: 'gpt-4o' });
history.push({ role: 'assistant', content: reply2.content });
```

**When to use:** Multi-turn chat loops where you want explicit control over every message. The `replace()` method is especially useful when you need to retrofit a tool-call result into a prior turn rather than appending it.

---

## `scratchpad()`

An append-only note store for an agent's intermediate reasoning. Use this when your agent needs to accumulate observations, plans, or working notes across multiple steps before producing a final answer.

### Type

```ts
type Scratchpad = {
  note(text: string): void;
  notes(): string[];
  clear(): void;
};

function scratchpad(): Scratchpad;
```

### Methods

| Method | Description |
|--------|-------------|
| `note(text)` | Append a string note. |
| `notes()` | Return a snapshot copy of all notes. |
| `clear()` | Remove all notes. |

### Example

```ts
import { scratchpad } from 'flint/memory';
import { call } from 'flint/call';

const pad = scratchpad();

// Agent accumulates observations across tool calls
pad.note('User is asking about flight prices to Tokyo.');
pad.note('Tool returned: cheapest fare is $780 on March 15.');
pad.note('User previously mentioned a $700 budget constraint.');

// Inject notes into the final prompt
const context = pad.notes().join('\n');
const answer = await call({
  messages: [
    { role: 'system', content: `Working notes:\n${context}` },
    { role: 'user', content: 'What should I do?' },
  ],
  model: 'gpt-4o',
});
```

**When to use:** Agentic loops where intermediate steps produce context that should influence the final response but shouldn't be part of the user-visible conversation history.

---

## `conversationMemory()`

A rolling-window store with automatic summarization. When the message count reaches `summarizeAt`, it compresses older messages into a summary and keeps only the most recent `max - summarizeAt` turns in full.

Use this for long-running assistants where you cannot afford unbounded token growth but still need the model to have awareness of earlier parts of the conversation.

### Type

```ts
type ConversationMemoryOpts = {
  max: number;
  summarizeAt: number;
  summarizer: (messages: Message[]) => Promise<string>;
};

type ConversationMemory = {
  append(m: Message): void;
  messages(): Message[];
  summary(): string | undefined;
  clear(): void;
};

function conversationMemory(opts: ConversationMemoryOpts): ConversationMemory;
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `max` | `number` | Maximum number of messages to retain after a summarization pass. |
| `summarizeAt` | `number` | Trigger summarization when the store reaches this many messages. Must be less than `max`. |
| `summarizer` | `(messages: Message[]) => Promise<string>` | Async function that receives the messages to compress and returns a summary string. |

### Methods

| Method | Description |
|--------|-------------|
| `append(m)` | Add a message; triggers summarization automatically if the threshold is met. |
| `messages()` | Return the current in-memory messages (may include a leading summary system message). |
| `summary()` | Return the most recent summary text, or `undefined` if none has been generated. |
| `clear()` | Remove all messages and reset the summary. |

### Example

```ts
import { conversationMemory } from 'flint/memory';
import { call } from 'flint/call';

// Build a summarizer using any LLM call
async function summarize(msgs: Message[]): Promise<string> {
  const transcript = msgs
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  const result = await call({
    messages: [
      {
        role: 'user',
        content: `Summarize this conversation in 2-3 sentences:\n\n${transcript}`,
      },
    ],
    model: 'gpt-4o-mini',
  });
  return result.content as string;
}

const mem = conversationMemory({
  max: 20,          // keep at most 20 messages after compression
  summarizeAt: 30,  // compress when we hit 30 messages
  summarizer: summarize,
});

// Use with agent()
import { agent } from 'flint/agent';

const myAgent = agent({
  model: 'gpt-4o',
  memory: mem,
  // ...
});
```

**Fail-open behavior:** If `summarizer` throws, the store is left unchanged and the conversation continues without compression. Check `summary()` to verify whether summarization has occurred.

**When to use:** Production chatbots or long-running sessions where you need to bound token costs without abruptly losing conversation context.

---

## See Also

- [Compress & Pipeline](../primitives/compress.md) — token-level compression and message pipeline transforms
- [RAG](./rag.md) — retrieve relevant documents and inject them into the context window
- [Recipes](../guide/recipes.md) — end-to-end patterns combining memory with agents
