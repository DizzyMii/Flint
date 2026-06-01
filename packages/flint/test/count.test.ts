import { describe, expect, it } from 'vitest';
import { approxCount } from '../src/primitives/approx-count.ts';
import { count } from '../src/primitives/count.ts';
import { mockAdapter } from '../src/testing/mock-adapter.ts';
import type { Message } from '../src/types.ts';

describe('approxCount', () => {
  it('returns 0 for empty array', () => {
    expect(approxCount([])).toBe(0);
  });

  it('accounts for role overhead on every message', () => {
    // Empty content still costs ROLE_OVERHEAD (4).
    const msgs: Message[] = [
      { role: 'user', content: '' },
      { role: 'assistant', content: '' },
    ];
    expect(approxCount(msgs)).toBe(8);
  });

  it('counts ~1 token per 3.5 chars for string content', () => {
    // "hello world" is 11 chars -> ceil(11/3.5) = 4 tokens + 4 role overhead = 8.
    const msgs: Message[] = [{ role: 'user', content: 'hello world' }];
    expect(approxCount(msgs)).toBe(8);
  });

  it('handles ContentPart[] arrays', () => {
    // text: 10 chars -> ceil(10/3.5) = 3 tokens, image: 512 tokens, role: 4 -> 519.
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'abcdefghij' },
          { type: 'image', url: 'https://example.com/x.png' },
        ],
      },
    ];
    expect(approxCount(msgs)).toBe(519);
  });

  it('counts tool call arguments', () => {
    // role 4, empty assistant content 0, tool call overhead 4, JSON "{\"q\":\"hi\"}" 10 chars -> ceil(10/3.5)=3.
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'hi' } }],
      },
    ];
    expect(approxCount(msgs)).toBe(4 + 4 + 3);
  });

  it('is monotonic: adding a message never decreases the count', () => {
    const base: Message[] = [{ role: 'user', content: 'hi' }];
    const more: Message[] = [...base, { role: 'assistant', content: 'hi back' }];
    expect(approxCount(more)).toBeGreaterThanOrEqual(approxCount(base));
  });

  it('does not throw on non-serializable tool arguments', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'circular', arguments: circular },
          { id: 'c2', name: 'bigint', arguments: { n: 1n } },
          { id: 'c3', name: 'undef', arguments: undefined },
        ],
      },
    ];
    // role 4 + 3 tool-call overheads (4 each); unserializable args contribute 0.
    expect(() => approxCount(msgs)).not.toThrow();
    expect(approxCount(msgs)).toBe(4 + 4 * 3);
  });
});

describe('count', () => {
  const msgs: Message[] = [{ role: 'user', content: 'hello' }];

  it('falls back to approxCount when no adapter provided', () => {
    expect(count(msgs, 'm')).toBe(approxCount(msgs));
  });

  it('falls back to approxCount when adapter has no count method', () => {
    const a = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
    });
    expect(count(msgs, 'm', a)).toBe(approxCount(msgs));
  });

  it('dispatches to adapter.count when present', () => {
    const a = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
      count: (_m, _model) => 42,
    });
    expect(count(msgs, 'm', a)).toBe(42);
  });
});
