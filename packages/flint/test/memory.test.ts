import { describe, expect, it } from 'vitest';
import { conversationMemory, messages, scratchpad } from '../src/memory.ts';
import { NotImplementedError } from '../src/errors.ts';

describe('memory', () => {
  it('messages() returns helpers', () => {
    const m = messages();
    expect(typeof m.push).toBe('function');
    expect(typeof m.slice).toBe('function');
    expect(typeof m.replace).toBe('function');
    expect(typeof m.all).toBe('function');
    expect(() => m.push({ role: 'user', content: 'x' })).toThrow(NotImplementedError);
  });

  it('scratchpad() returns helpers', () => {
    const p = scratchpad();
    expect(typeof p.note).toBe('function');
    expect(typeof p.notes).toBe('function');
    expect(typeof p.clear).toBe('function');
    expect(() => p.note('x')).toThrow(NotImplementedError);
  });

  it('conversationMemory() returns helpers', () => {
    const mem = conversationMemory({
      max: 10,
      summarizeAt: 8,
      summarizer: async () => 'summary',
    });
    expect(typeof mem.append).toBe('function');
    expect(typeof mem.messages).toBe('function');
    expect(typeof mem.summary).toBe('function');
    expect(typeof mem.clear).toBe('function');
    expect(() => mem.append({ role: 'user', content: 'x' })).toThrow(NotImplementedError);
  });
});
