import { describe, expect, it } from 'vitest';
import type { NormalizedResponse } from '../src/adapter.ts';
import {
  type AgentEvent,
  agent,
  agentStream,
  eventLog,
  parseEventLog,
  partialRun,
  transcriptFrom,
} from '../src/agent.ts';
import { budget } from '../src/budget.ts';
import type { Transform } from '../src/compress.ts';
import { dedup, summarize, windowLast } from '../src/compress.ts';
import { compactionDecision, contextManager } from '../src/context.ts';
import { AdapterError, BudgetExhausted, type FlintError } from '../src/errors.ts';
import { costOf } from '../src/pricing.ts';
import { call } from '../src/primitives/call.ts';
import { execute } from '../src/primitives/execute.ts';
import { tool } from '../src/primitives/tool.ts';
import { mockAdapter, scriptedAdapter } from '../src/testing/mock-adapter.ts';
import { checkTranscript } from '../src/transcript.ts';
import type { Message, StandardSchemaV1 } from '../src/types.ts';

const any: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 't', validate: (v) => ({ value: v }) },
};
const user = (content: string): Message => ({ role: 'user', content });
const text = (content: string): NormalizedResponse => ({
  message: { role: 'assistant', content },
  usage: { input: 10, output: 5 },
  stopReason: 'end',
});
const calls = (...ids: string[]): NormalizedResponse => ({
  message: {
    role: 'assistant',
    content: '',
    toolCalls: ids.map((id) => ({ id, name: 'echo', arguments: { id } })),
  },
  usage: { input: 10, output: 5 },
  stopReason: 'tool_call',
});
const echo = tool({ name: 'echo', description: 'echo', input: any, handler: (i) => i });

describe('transcript invariants', () => {
  const turn: Message[] = [
    user('u'),
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 't', arguments: {} }] },
    { role: 'tool', content: 'r', toolCallId: 'a' },
    { role: 'assistant', content: 'done' },
  ];

  it('accepts a well-formed transcript and a trailing pending call', () => {
    expect(checkTranscript(turn)).toEqual([]);
    expect(checkTranscript(turn.slice(0, 2))).toEqual([]);
  });

  it('flags orphans, duplicates and unanswered calls', () => {
    expect(checkTranscript([user('u'), turn[2] as Message])).toHaveLength(1);
    expect(checkTranscript([...turn.slice(0, 3), turn[2] as Message])).toHaveLength(1);
    expect(checkTranscript([turn[0] as Message, turn[1] as Message, user('next')])).toHaveLength(1);
  });

  it('windowLast never splits a tool turn', async () => {
    const out = await windowLast({ keep: 2 })([{ role: 'system', content: 's' }, ...turn], {});
    expect(checkTranscript(out)).toEqual([]);
    expect(out.map((m) => m.role)).toEqual(['system', 'assistant']);
  });

  it('dedup keeps identical results of distinct calls', async () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 't', arguments: {} },
          { id: 'b', name: 't', arguments: {} },
        ],
      },
      { role: 'tool', content: 'ok', toolCallId: 'a' },
      { role: 'tool', content: 'ok', toolCallId: 'b' },
    ];
    expect(await dedup()(msgs, {})).toHaveLength(3);
  });

  it('summarize moves its cut to a turn boundary', async () => {
    const adapter = scriptedAdapter([text('S')]);
    const t = summarize({ when: () => true, adapter, model: 'm', keepLast: 2 });
    const out = await t([user('a'), user('b'), ...turn], {});
    expect(checkTranscript(out)).toEqual([]);
  });

  it('call() rejects a compress transform that breaks the transcript', async () => {
    const dropTools: Transform = async (m) => m.filter((x) => x.role !== 'tool');
    const adapter = scriptedAdapter([text('x')]);
    const res = await call({
      adapter,
      model: 'm',
      messages: turn,
      compress: dropTools,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.error as FlintError).code).toBe('compress.malformed');
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('budget', () => {
  it('reservations reduce remaining until released', () => {
    const b = budget({ maxTokens: 100 });
    const hold = b.reserve?.({ tokens: 60 });
    expect(b.remaining().tokens).toBe(40);
    hold?.release();
    hold?.release();
    expect(b.remaining().tokens).toBe(100);
  });

  it('child budgets charge the parent and see its limits', () => {
    const parent = budget({ maxDollars: 1 });
    const child = parent.child?.({ maxDollars: 5 });
    child?.consume({ cost: 0.75 });
    expect(parent.remaining().dollars).toBeCloseTo(0.25);
    expect(child?.remaining().dollars).toBeCloseTo(0.25);
    expect(() => child?.consume({ cost: 0.5 })).toThrow(BudgetExhausted);
  });

  it('pre-flight clamps max_tokens to the remaining token budget', async () => {
    const adapter = scriptedAdapter([text('x')], { capabilities: { defaultMaxTokens: 16000 } });
    await call({ adapter, model: 'm', messages: [user('hi')], budget: budget({ maxTokens: 500 }) });
    const sent = adapter.calls[0]?.maxTokens ?? 0;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(500);
  });

  it('refuses a call whose prompt alone exceeds the remaining budget, without calling', async () => {
    const adapter = scriptedAdapter([text('x')]);
    const res = await call({
      adapter,
      model: 'm',
      messages: [user('x'.repeat(4000))],
      budget: budget({ maxTokens: 100 }),
    });
    expect(res.ok).toBe(false);
    expect(adapter.calls).toHaveLength(0);
  });

  it('clamps by dollars when the adapter can price the model', async () => {
    const adapter = mockAdapter({
      onCall: () => text('x'),
      capabilities: { defaultMaxTokens: 16000 },
    });
    const priced = { ...adapter, pricing: () => ({ input: 5, output: 25 }) };
    const res = await call({
      adapter: priced,
      model: 'm',
      messages: [user('hi')],
      budget: budget({ maxDollars: 0.01 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok)
      expect(res.value.cost).toBeCloseTo(
        costOf({ input: 10, output: 5 }, { input: 5, output: 25 }),
      );
    // $0.01 buys ~400 output tokens at $25/MTok.
    expect(adapter.calls[0]?.maxTokens).toBeLessThanOrEqual(400);
  });

  it('fails closed when maxDollars is set but nothing can price the call', async () => {
    const res = await call({
      adapter: scriptedAdapter([text('x')]),
      model: 'm',
      messages: [user('hi')],
      budget: budget({ maxDollars: 1 }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.error as FlintError).code).toBe('budget.unpriced');
  });
});

describe('retries', () => {
  const flaky = (failures: AdapterError[]) =>
    mockAdapter({
      onCall: (_r, i) => {
        const f = failures[i];
        if (f) throw f;
        return text('ok');
      },
    });
  const overloaded = () =>
    new AdapterError('overloaded', {
      code: 'adapter.http.529',
      kind: 'overloaded',
      retryable: true,
    });

  it('retries retryable errors with backoff', async () => {
    const adapter = flaky([overloaded(), overloaded()]);
    const res = await call({
      adapter,
      model: 'm',
      messages: [user('x')],
      retry: { baseDelayMs: 1 },
    });
    expect(res.ok).toBe(true);
    expect(adapter.calls).toHaveLength(3);
  });

  it('does not retry non-retryable errors or when disabled', async () => {
    const bad = new AdapterError('bad', { code: 'adapter.http.400', kind: 'invalid_request' });
    const a1 = flaky([bad]);
    expect((await call({ adapter: a1, model: 'm', messages: [user('x')] })).ok).toBe(false);
    expect(a1.calls).toHaveLength(1);
    const a2 = flaky([overloaded()]);
    expect((await call({ adapter: a2, model: 'm', messages: [user('x')], retry: false })).ok).toBe(
      false,
    );
    expect(a2.calls).toHaveLength(1);
  });

  it('honours retryAfterMs', async () => {
    const err = new AdapterError('slow', {
      code: 'adapter.http.429',
      kind: 'rate_limit',
      retryable: true,
      retryAfterMs: 30,
    });
    const delays: number[] = [];
    await call({
      adapter: flaky([err]),
      model: 'm',
      messages: [user('x')],
      onRetry: (r) => delays.push(r.delayMs),
    });
    expect(delays).toEqual([30]);
  });
});

describe('structured output', () => {
  it('extracts JSON from fenced or prefixed responses', async () => {
    const schema: StandardSchemaV1<unknown, { a: number }> = {
      '~standard': { version: 1, vendor: 't', validate: (v) => ({ value: v as { a: number } }) },
    };
    const res = await call({
      adapter: scriptedAdapter([text('Here you go:\n```json\n{"a": 1}\n```')]),
      model: 'm',
      messages: [user('x')],
      schema,
    });
    expect(res.ok && res.value.value).toEqual({ a: 1 });
  });
});

describe('tools', () => {
  it('passes an abort signal that fires on timeout', async () => {
    let aborted = false;
    const slow = tool({
      name: 'slow',
      description: 's',
      input: any,
      timeout: 10,
      handler: (_i, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            resolve('late');
          });
        }),
    });
    const res = await execute(slow, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res.error as FlintError).code).toBe('tool.timeout');
    expect(aborted).toBe(true);
  });

  it('agent does not run a tool whose arguments failed to parse', async () => {
    let ran = false;
    const t = tool({
      name: 'rm',
      description: 'rm',
      input: any,
      handler: () => {
        ran = true;
      },
    });
    const adapter = scriptedAdapter([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'a', name: 'rm', arguments: {}, parseError: 'Unexpected end of JSON' }],
        },
        usage: { input: 1, output: 1 },
        stopReason: 'tool_call',
      },
      text('ok'),
    ]);
    const out = await agent({
      adapter,
      model: 'm',
      messages: [user('x')],
      tools: [t],
      budget: budget({ maxSteps: 5 }),
    });
    expect(ran).toBe(false);
    expect(out.ok && out.value.steps[0]?.toolResults[0]?.isError).toBe(true);
  });

  it('runs a batch sequentially when it contains a destructive tool', async () => {
    const log: string[] = [];
    const mk = (name: string, destructive: boolean) =>
      tool({
        name,
        description: name,
        input: any,
        permissions: { destructive },
        handler: async () => {
          log.push(`${name}:start`);
          await new Promise((r) => setTimeout(r, 5));
          log.push(`${name}:end`);
          return name;
        },
      });
    const adapter = scriptedAdapter([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: '1', name: 'write', arguments: {} },
            { id: '2', name: 'read', arguments: {} },
          ],
        },
        usage: { input: 1, output: 1 },
        stopReason: 'tool_call',
      },
      text('ok'),
    ]);
    await agent({
      adapter,
      model: 'm',
      messages: [user('x')],
      tools: [mk('write', true), mk('read', false)],
      budget: budget({ maxSteps: 5 }),
    });
    expect(log).toEqual(['write:start', 'write:end', 'read:start', 'read:end']);
  });

  it('rejects duplicate tool names', async () => {
    await expect(
      agent({
        adapter: scriptedAdapter([text('x')]),
        model: 'm',
        messages: [user('x')],
        tools: [echo, echo],
        budget: budget({ maxSteps: 1 }),
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('event-log core', () => {
  it('emits a log that rebuilds the transcript and survives JSONL', async () => {
    const log = eventLog();
    const out = await agent({
      adapter: scriptedAdapter([calls('a', 'b'), text('done')]),
      model: 'm',
      messages: [user('go')],
      tools: [echo],
      budget: budget({ maxSteps: 5 }),
      onEvent: log.sink,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const types = log.events.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types.at(-1)).toBe('done');
    expect(types).toContain('tool_end');
    expect(transcriptFrom(parseEventLog(log.toJSONL()))).toEqual(out.value.messages);
    expect(out.value.steps[0]?.messagesSent).toEqual([user('go')]);
  });

  it('drops a dangling tool turn when rebuilding after a crash', () => {
    const events: AgentEvent[] = [
      { type: 'start', model: 'm', messages: [user('go')] },
      { type: 'message', message: calls('a', 'b').message },
      { type: 'message', message: { role: 'tool', content: 'r', toolCallId: 'a' } },
    ];
    expect(transcriptFrom(events)).toEqual([user('go')]);
  });

  it('keeps the partial run on failure', async () => {
    const out = await agent({
      adapter: scriptedAdapter([calls('a'), calls('b'), calls('c')]),
      model: 'm',
      messages: [user('go')],
      tools: [echo],
      budget: budget({ maxSteps: 2 }),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const partial = partialRun(out.error);
    expect(partial?.steps).toHaveLength(2);
    expect(checkTranscript(partial?.messages ?? [])).toEqual([]);
  });

  it('streams chunks and returns the same result', async () => {
    const events: AgentEvent[] = [];
    const it = agentStream({
      adapter: scriptedAdapter([text('hello')]),
      model: 'm',
      messages: [user('x')],
      budget: budget({ maxSteps: 2 }),
      streaming: true,
    });
    let res: Awaited<ReturnType<typeof it.next>>;
    while (!(res = await it.next()).done) events.push(res.value);
    expect(events.some((e) => e.type === 'chunk')).toBe(true);
    expect(res.value.ok && res.value.value.message.content).toBe('hello');
  });

  it('aborts between steps', async () => {
    const ac = new AbortController();
    const out = await agent({
      adapter: scriptedAdapter([calls('a'), text('never')]),
      model: 'm',
      messages: [user('x')],
      tools: [echo],
      budget: budget({ maxSteps: 5 }),
      signal: ac.signal,
      onStep: () => ac.abort(),
    });
    expect(!out.ok && (out.error as FlintError).code).toBe('agent.aborted');
  });
});

describe('context manager', () => {
  const pricing = { input: 4, output: 20, cacheRead: 0.2 };

  it('compaction economics: cached history is usually cheaper to keep', () => {
    const small = compactionDecision({
      compactable: 20_000,
      tail: 5000,
      horizon: 5,
      pricing,
      summaryTokens: 1500,
    });
    expect(small.compact).toBe(false);
    const huge = compactionDecision({
      compactable: 400_000,
      tail: 5000,
      horizon: 200,
      pricing,
      summaryTokens: 2000,
    });
    expect(huge.compact).toBe(true);
  });

  it('compacts under window pressure on a turn boundary and keeps the prefix stable after', async () => {
    const summarizer = scriptedAdapter([text('SUMMARY')]);
    const cm = contextManager({
      summarizer: { adapter: summarizer, model: 's' },
      contextWindow: 2000,
      keepRecentTokens: 200,
    });
    const big = 'x'.repeat(2000);
    const transcript: Message[] = [{ role: 'system', content: 'sys' }, user('go')];
    for (const id of ['a', 'b', 'c', 'd']) {
      transcript.push(calls(id).message, { role: 'tool', content: big, toolCallId: id });
    }
    const first = await cm.prepare(transcript, { model: 'm', step: 4 });
    expect(first.compaction?.reason).toBe('pressure');
    expect(checkTranscript(first.messages)).toEqual([]);
    expect(first.messages[1]).toMatchObject({ role: 'user' });
    expect(first.messages[2]?.role).toBe('assistant');

    transcript.push(text('next').message);
    const second = await cm.prepare(transcript, { model: 'm', step: 5 });
    expect(second.compaction).toBeUndefined();
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(summarizer.calls).toHaveLength(1);
  });

  it('agent forces compaction and retries once on context overflow', async () => {
    let n = 0;
    const adapter = mockAdapter({
      onCall: (req) => {
        n++;
        if (n === 2) {
          throw new AdapterError('prompt is too long', {
            code: 'adapter.http.400',
            kind: 'context_overflow',
          });
        }
        if (
          req.messages.some(
            (m) =>
              m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Summary'),
          )
        ) {
          return text('done after compaction');
        }
        return n === 1 ? calls('a') : text('SUMMARY');
      },
    });
    const events: AgentEvent[] = [];
    const out = await agent({
      adapter,
      model: 'm',
      messages: [user('go')],
      tools: [echo],
      budget: budget({ maxSteps: 10 }),
      context: contextManager({ summarizer: { adapter, model: 'm' }, contextWindow: 1_000_000 }),
      onEvent: (e) => events.push(e),
    });
    expect(out.ok).toBe(true);
    expect(events.find((e) => e.type === 'compaction')).toMatchObject({
      record: { reason: 'forced' },
    });
  });

  it('restores from a recorded compaction', async () => {
    const cm = contextManager({
      summarizer: { adapter: scriptedAdapter([]), model: 's' },
      contextWindow: 1_000_000,
      restore: { upto: 2, summary: 'S', reason: 'pressure', compactedTokens: 10, summaryTokens: 1 },
    });
    const { messages } = await cm.prepare([user('a'), text('b').message, user('c')], {
      model: 'm',
      step: 0,
    });
    expect(messages).toEqual([
      { role: 'user', content: 'Summary of earlier work in this session:\nS' },
      user('c'),
    ]);
  });
});

describe('record / replay', () => {
  it('replays a recorded agent run deterministically and fails on drift', async () => {
    const { recordingAdapter, replayAdapter } = await import('../src/testing/mock-adapter.ts');
    const rec = recordingAdapter(scriptedAdapter([calls('a'), text('done')]));
    const opts = {
      model: 'm',
      messages: [user('go')],
      tools: [echo],
      budget: budget({ maxSteps: 5 }),
    };
    const live = await agent({ adapter: rec, ...opts });
    const cassette = JSON.parse(JSON.stringify(rec.cassette));
    const replayed = await agent({
      adapter: replayAdapter(cassette),
      ...opts,
      budget: budget({ maxSteps: 5 }),
    });
    expect(replayed.ok && replayed.value.messages).toEqual(live.ok && live.value.messages);
    const drifted = await agent({
      adapter: replayAdapter(cassette),
      ...opts,
      messages: [user('changed prompt')],
      budget: budget({ maxSteps: 5 }),
    });
    expect(!drifted.ok && (drifted.error.cause as FlintError).code).toBe('testing.cassette_miss');
  });
});

describe('callStream', () => {
  it('releases its budget reservation when the consumer stops early', async () => {
    const { callStream } = await import('../src/primitives/call.ts');
    const b = budget({ maxTokens: 100_000 });
    const before = b.remaining().tokens;
    for await (const _ of callStream({
      adapter: scriptedAdapter([text('hello')]),
      model: 'm',
      messages: [user('x')],
      budget: b,
    })) {
      break;
    }
    expect(b.remaining().tokens).toBe(before);
  });
});

describe('review regressions', () => {
  it('does not invent max_tokens when the adapter has no default', async () => {
    const adapter = scriptedAdapter([text('x')]);
    await call({
      adapter,
      model: 'm',
      messages: [user('hi')],
      budget: budget({ maxTokens: 1_000_000 }),
    });
    expect(adapter.calls[0]?.maxTokens).toBeUndefined();
  });

  it('records a response that pushed the budget over its limit', async () => {
    const adapter = mockAdapter({
      onCall: () => ({ ...text('final answer'), usage: { input: 500, output: 100 } }),
      capabilities: { defaultMaxTokens: 100 },
    });
    const events: AgentEvent[] = [];
    const out = await agent({
      adapter,
      model: 'm',
      messages: [user('x')],
      budget: budget({ maxTokens: 300 }),
      onEvent: (e) => events.push(e),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const partial = partialRun(out.error);
    expect(partial?.usage).toEqual({ input: 500, output: 100 });
    expect(partial?.messages.at(-1)).toMatchObject({ content: 'final answer' });
    expect(events.some((e) => e.type === 'response')).toBe(true);
  });

  it('refuses when the clamp would leave no room beyond the thinking budget', async () => {
    const adapter = scriptedAdapter([text('x')], { capabilities: { defaultMaxTokens: 16000 } });
    const res = await call({
      adapter,
      model: 'm',
      messages: [user('hi')],
      extra: { thinking: { type: 'enabled', budget_tokens: 10_000 } },
      budget: budget({ maxTokens: 8000 }),
    });
    expect(res.ok).toBe(false);
    expect(adapter.calls).toHaveLength(0);
  });

  it('releases the reservation when onRetry throws', async () => {
    const b = budget({ maxTokens: 100_000 });
    const before = b.remaining().tokens;
    const adapter = mockAdapter({
      onCall: () => {
        throw new AdapterError('x', {
          code: 'adapter.http.529',
          kind: 'overloaded',
          retryable: true,
        });
      },
    });
    await expect(
      call({
        adapter,
        model: 'm',
        messages: [user('x')],
        budget: b,
        onRetry: () => {
          throw new Error('sink');
        },
      }),
    ).rejects.toThrow('sink');
    expect(b.remaining().tokens).toBe(before);
  });

  it('resuming into the same event log does not duplicate the transcript', async () => {
    const log = eventLog();
    const opts = { model: 'm', tools: [echo], budget: budget({ maxSteps: 9 }), onEvent: log.sink };
    await agent({ adapter: scriptedAdapter([text('a')]), messages: [user('1')], ...opts });
    const resumed = await agent({
      adapter: scriptedAdapter([text('b')]),
      messages: [...log.transcript(), user('2')],
      ...opts,
    });
    expect(log.transcript()).toEqual(resumed.ok && resumed.value.messages);
  });
});
