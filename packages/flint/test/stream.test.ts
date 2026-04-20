import { describe, expect, it } from 'vitest';
import { stream } from '../src/primitives/stream.ts';
import { mockAdapter } from '../src/testing/mock-adapter.ts';
import type { StreamChunk } from '../src/types.ts';
import type { Message } from '../src/types.ts';

const msg: Message[] = [{ role: 'user', content: 'hi' }];

describe('stream', () => {
  it('yields chunks from the adapter stream in order', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'hello' },
        usage: { input: 3, output: 2 },
        stopReason: 'end',
      }),
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of stream({ adapter, model: 'm', messages: msg })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'usage', usage: { input: 3, output: 2 } },
      { type: 'end', reason: 'end' },
    ]);
  });

  it('propagates adapter errors mid-stream', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
      onStream: async function* () {
        yield { type: 'text', delta: 'ok' };
        throw new Error('stream broke');
      },
    });
    const iter = stream({ adapter, model: 'm', messages: msg });
    await expect(async () => {
      for await (const _chunk of iter) {
        // drain until error
      }
    }).rejects.toThrow('stream broke');
  });

  it('runs compress pipeline before starting the stream', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
    });
    const compress = async () => [{ role: 'user', content: 'compressed' } as const];
    for await (const _ of stream({ adapter, model: 'm', messages: msg, compress })) {
      // drain
    }
    expect(adapter.calls[0]?.messages).toEqual([
      { role: 'user', content: 'compressed' },
    ]);
  });

  it('forwards signal to adapter request', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
    });
    const controller = new AbortController();
    for await (const _ of stream({
      adapter,
      model: 'm',
      messages: msg,
      signal: controller.signal,
    })) {
      // drain
    }
    expect(adapter.calls[0]?.signal).toBe(controller.signal);
  });

  it('throws TypeError when adapter is missing', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional bad input for test
    const iter = stream({ model: 'm', messages: msg } as any);
    await expect(async () => {
      for await (const _ of iter) {
        // unreachable
      }
    }).rejects.toThrow(TypeError);
  });
});
