import { describe, expect, it, vi } from 'vitest';
import { conversationMemory, messages, scratchpad } from '../src/memory.ts';
import type { Message } from '../src/types.ts';

// ---------------------------------------------------------------------------
// messages()
// ---------------------------------------------------------------------------

describe('messages()', () => {
  it('starts empty', () => {
    const m = messages();
    expect(m.all()).toEqual([]);
  });

  it('push + all round-trips', () => {
    const m = messages();
    const msg: Message = { role: 'user', content: 'hello' };
    m.push(msg);
    expect(m.all()).toEqual([msg]);
  });

  it('all() returns a defensive copy', () => {
    const m = messages();
    m.push({ role: 'user', content: 'x' });
    const copy = m.all();
    copy.push({ role: 'assistant', content: 'y' });
    expect(m.all()).toHaveLength(1);
  });

  it('slice() follows Array.prototype.slice semantics', () => {
    const m = messages();
    const msgs: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    msgs.forEach((msg) => m.push(msg));
    expect(m.slice(0, 2)).toEqual([msgs[0], msgs[1]]);
    expect(m.slice(1)).toEqual([msgs[1], msgs[2]]);
    expect(m.slice(-1)).toEqual([msgs[2]]);
    expect(m.slice(0, 0)).toEqual([]);
  });

  it('replace() swaps the message at the given index', () => {
    const m = messages();
    m.push({ role: 'user', content: 'old' });
    const replacement: Message = { role: 'user', content: 'new' };
    m.replace(0, replacement);
    expect(m.all()).toEqual([replacement]);
  });

  it('replace() is a no-op for out-of-range index', () => {
    const m = messages();
    m.push({ role: 'user', content: 'only' });
    m.replace(5, { role: 'assistant', content: 'ignored' });
    expect(m.all()).toHaveLength(1);
    expect(m.all()[0]).toEqual({ role: 'user', content: 'only' });
  });

  it('replace() is a no-op for negative out-of-range index', () => {
    const m = messages();
    m.push({ role: 'user', content: 'only' });
    m.replace(-10, { role: 'assistant', content: 'ignored' });
    expect(m.all()).toHaveLength(1);
  });

  it('clear() empties the store', () => {
    const m = messages();
    m.push({ role: 'user', content: 'x' });
    m.clear();
    expect(m.all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scratchpad()
// ---------------------------------------------------------------------------

describe('scratchpad()', () => {
  it('starts empty', () => {
    const p = scratchpad();
    expect(p.notes()).toEqual([]);
  });

  it('note() appends text', () => {
    const p = scratchpad();
    p.note('first');
    p.note('second');
    expect(p.notes()).toEqual(['first', 'second']);
  });

  it('notes() returns a defensive copy', () => {
    const p = scratchpad();
    p.note('hello');
    const copy = p.notes();
    copy.push('injected');
    expect(p.notes()).toHaveLength(1);
  });

  it('clear() empties notes', () => {
    const p = scratchpad();
    p.note('x');
    p.clear();
    expect(p.notes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// conversationMemory()
// ---------------------------------------------------------------------------

describe('conversationMemory()', () => {
  const makeMsg = (content: string): Message => ({ role: 'user', content });

  it('starts with empty messages and no summary', async () => {
    const mem = conversationMemory({
      max: 5,
      summarizeAt: 4,
      summarizer: async () => 'never called',
    });
    expect(mem.messages()).toEqual([]);
    expect(mem.summary()).toBeUndefined();
  });

  it('append() adds messages below summarizeAt without summarizing', async () => {
    const summarizer = vi.fn(async () => 'summary');
    const mem = conversationMemory({ max: 5, summarizeAt: 4, summarizer });
    await mem.append(makeMsg('a'));
    await mem.append(makeMsg('b'));
    await mem.append(makeMsg('c'));
    expect(mem.messages()).toHaveLength(3);
    expect(summarizer).not.toHaveBeenCalled();
  });

  it('messages() returns a defensive copy', async () => {
    const mem = conversationMemory({
      max: 5,
      summarizeAt: 4,
      summarizer: async () => 's',
    });
    await mem.append(makeMsg('x'));
    const copy = mem.messages();
    copy.push(makeMsg('injected'));
    expect(mem.messages()).toHaveLength(1);
  });

  it('triggers summarization when count reaches summarizeAt', async () => {
    // max=5, summarizeAt=4 → keep last (5-4)=1 message, summarize the rest
    const summarizer = vi.fn(async (msgs: Message[]) => `summary of ${msgs.length}`);
    const mem = conversationMemory({ max: 5, summarizeAt: 4, summarizer });
    await mem.append(makeMsg('a')); // 1
    await mem.append(makeMsg('b')); // 2
    await mem.append(makeMsg('c')); // 3
    await mem.append(makeMsg('d')); // 4 → trigger
    expect(summarizer).toHaveBeenCalledOnce();
    // summarizer received the first 3 messages (all but last 1)
    expect(summarizer.mock.calls[0]![0]).toHaveLength(3);
    // stored messages: 1 system summary + 1 kept message = 2
    expect(mem.messages()).toHaveLength(2);
    expect(mem.messages()[0]).toMatchObject({ role: 'system' });
    expect((mem.messages()[0] as { role: string; content: string }).content).toContain(
      'Summary of prior conversation:',
    );
  });

  it('summary() returns the latest summary string after summarization', async () => {
    const mem = conversationMemory({
      max: 5,
      summarizeAt: 4,
      summarizer: async () => 'the summary text',
    });
    for (let i = 0; i < 4; i++) await mem.append(makeMsg(`msg${i}`));
    expect(mem.summary()).toBe('the summary text');
  });

  it('fail-open: summarizer throw keeps messages unchanged and does not bubble', async () => {
    const summarizer = vi.fn(async () => {
      throw new Error('boom');
    });
    const mem = conversationMemory({ max: 5, summarizeAt: 4, summarizer });
    await mem.append(makeMsg('a'));
    await mem.append(makeMsg('b'));
    await mem.append(makeMsg('c'));
    // 4th append triggers summarization which throws → must not throw
    await expect(mem.append(makeMsg('d'))).resolves.toBeUndefined();
    // messages must be unchanged (all 4 still present)
    expect(mem.messages()).toHaveLength(4);
    expect(mem.summary()).toBeUndefined();
  });

  it('clear() resets messages and summary', async () => {
    const mem = conversationMemory({
      max: 5,
      summarizeAt: 4,
      summarizer: async () => 'summary',
    });
    for (let i = 0; i < 4; i++) await mem.append(makeMsg(`m${i}`));
    mem.clear();
    expect(mem.messages()).toEqual([]);
    expect(mem.summary()).toBeUndefined();
  });
});
