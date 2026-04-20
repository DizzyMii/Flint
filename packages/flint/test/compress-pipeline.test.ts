import { describe, expect, it } from 'vitest';
import { pipeline } from '../src/compress.ts';
import type { Transform } from '../src/compress.ts';
import type { Message } from '../src/types.ts';

const tagTransform = (tag: string): Transform => async (messages) => {
  return messages.map((m) =>
    m.role === 'user' && typeof m.content === 'string'
      ? { ...m, content: `${m.content}[${tag}]` }
      : m,
  );
};

describe('compress.pipeline', () => {
  const base: Message[] = [{ role: 'user', content: 'hi' }];

  it('with zero transforms returns messages unchanged', async () => {
    const p = pipeline();
    const out = await p(base, {});
    expect(out).toEqual(base);
  });

  it('runs transforms in order', async () => {
    const p = pipeline(tagTransform('a'), tagTransform('b'));
    const out = await p(base, {});
    expect(out[0]?.content).toBe('hi[a][b]');
  });

  it('awaits async transforms', async () => {
    const slow: Transform = async (messages) => {
      await new Promise((r) => setTimeout(r, 10));
      return messages.map((m) =>
        m.role === 'user' && typeof m.content === 'string'
          ? { ...m, content: `${m.content}[slow]` }
          : m,
      );
    };
    const p = pipeline(slow, tagTransform('end'));
    const out = await p(base, {});
    expect(out[0]?.content).toBe('hi[slow][end]');
  });

  it('propagates errors from transforms', async () => {
    const boom: Transform = async () => {
      throw new Error('pipeline boom');
    };
    const p = pipeline(boom);
    await expect(p(base, {})).rejects.toThrow('pipeline boom');
  });
});
