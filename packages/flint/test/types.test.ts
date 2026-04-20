import { describe, expectTypeOf, it } from 'vitest';
import type {
  ContentPart,
  Message,
  Result,
  Tool,
  ToolCall,
} from '../src/types.ts';

describe('types surface', () => {
  it('Message union is exhaustive', () => {
    const sys: Message = { role: 'system', content: 'x' };
    const usr: Message = { role: 'user', content: 'x' };
    const asst: Message = { role: 'assistant', content: 'x' };
    const tool: Message = { role: 'tool', content: 'x', toolCallId: 'id' };
    expectTypeOf(sys).toMatchTypeOf<Message>();
    expectTypeOf(usr).toMatchTypeOf<Message>();
    expectTypeOf(asst).toMatchTypeOf<Message>();
    expectTypeOf(tool).toMatchTypeOf<Message>();
  });

  it('ToolCall has id/name/arguments', () => {
    const tc: ToolCall = { id: '1', name: 'fn', arguments: {} };
    expectTypeOf(tc).toMatchTypeOf<ToolCall>();
  });

  it('Result is discriminated union', () => {
    const ok: Result<number> = { ok: true, value: 1 };
    const err: Result<number> = { ok: false, error: new Error('x') };
    expectTypeOf(ok).toMatchTypeOf<Result<number>>();
    expectTypeOf(err).toMatchTypeOf<Result<number>>();
  });

  it('ContentPart covers text and images', () => {
    const t: ContentPart = { type: 'text', text: 'x' };
    const u: ContentPart = { type: 'image', url: 'https://x' };
    const b: ContentPart = { type: 'image_b64', data: 'x', mediaType: 'image/png' };
    expectTypeOf(t).toMatchTypeOf<ContentPart>();
    expectTypeOf(u).toMatchTypeOf<ContentPart>();
    expectTypeOf(b).toMatchTypeOf<ContentPart>();
  });

  it('Tool exposes name/description/input/handler', () => {
    // type-level only
    type T = Tool<{ a: number }, string>;
    type _Name = T['name'];       // string
    type _Desc = T['description']; // string
    expectTypeOf<T['name']>().toEqualTypeOf<string>();
  });
});
