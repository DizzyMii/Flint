import { describe, expect, it } from 'vitest';
import { mockAdapter, scriptedAdapter } from '../src/testing/mock-adapter.ts';
import type { NormalizedResponse, StreamChunk } from '../src/adapter.ts';
import type { Message } from '../src/types.ts';

const textResponse = (content: string): NormalizedResponse => ({
  message: { role: 'assistant', content },
  usage: { input: 10, output: 5 },
  stopReason: 'end',
});

describe('mockAdapter', () => {
  it('records calls in order', async () => {
    const a = mockAdapter({ onCall: () => textResponse('hi') });
    await a.call({ model: 'm', messages: [{ role: 'user', content: 'a' }] });
    await a.call({ model: 'm', messages: [{ role: 'user', content: 'b' }] });
    expect(a.calls).toHaveLength(2);
    expect(a.calls[0]?.messages[0]?.content).toBe('a');
    expect(a.calls[1]?.messages[0]?.content).toBe('b');
  });

  it('increments callIndex across call and stream', async () => {
    const indices: number[] = [];
    const a = mockAdapter({
      onCall: (_req, i) => {
        indices.push(i);
        return textResponse(`r${i}`);
      },
    });
    await a.call({ model: 'm', messages: [] });
    for await (const _ of a.stream({ model: 'm', messages: [] })) {
      // drain
    }
    await a.call({ model: 'm', messages: [] });
    expect(indices).toEqual([0, 1, 2]);
  });

  it('default name is "mock" and capabilities default to {}', () => {
    const a = mockAdapter({ onCall: () => textResponse('x') });
    expect(a.name).toBe('mock');
    expect(a.capabilities).toEqual({});
  });

  it('accepts custom name and capabilities', () => {
    const a = mockAdapter({
      name: 'fake',
      capabilities: { promptCache: true },
      onCall: () => textResponse('x'),
    });
    expect(a.name).toBe('fake');
    expect(a.capabilities.promptCache).toBe(true);
  });

  it('default onStream yields text delta, usage, end', async () => {
    const a = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'hello' },
        usage: { input: 3, output: 2 },
        stopReason: 'end',
      }),
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of a.stream({ model: 'm', messages: [] })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'usage', usage: { input: 3, output: 2 } },
      { type: 'end', reason: 'end' },
    ]);
  });

  it('custom onStream is used when supplied', async () => {
    const a = mockAdapter({
      onCall: () => textResponse('x'),
      onStream: async function* () {
        yield { type: 'text', delta: 'A' };
        yield { type: 'text', delta: 'B' };
        yield { type: 'end', reason: 'end' };
      },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of a.stream({ model: 'm', messages: [] })) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => (c.type === 'text' ? c.delta : c.type))).toEqual([
      'A',
      'B',
      'end',
    ]);
  });

  it('count delegates to opts.count when provided', () => {
    const a = mockAdapter({
      onCall: () => textResponse('x'),
      count: (messages: Message[]) => messages.length * 100,
    });
    expect(a.count!([{ role: 'user', content: 'hi' }], 'm')).toBe(100);
  });

  it('count is undefined when not provided', () => {
    const a = mockAdapter({ onCall: () => textResponse('x') });
    expect(a.count).toBeUndefined();
  });
});

describe('scriptedAdapter', () => {
  it('returns scripted responses in order', async () => {
    const a = scriptedAdapter([textResponse('one'), textResponse('two')]);
    const r1 = await a.call({ model: 'm', messages: [] });
    const r2 = await a.call({ model: 'm', messages: [] });
    expect(r1.message.content).toBe('one');
    expect(r2.message.content).toBe('two');
  });

  it('throws when past end of script', async () => {
    const a = scriptedAdapter([textResponse('only')]);
    await a.call({ model: 'm', messages: [] });
    await expect(a.call({ model: 'm', messages: [] })).rejects.toThrow(
      /past end of scripted responses/i,
    );
  });
});
