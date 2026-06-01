import type { Message } from '../types.ts';

const APPROX_CHARS_PER_TOKEN = 3.5;
const ROLE_OVERHEAD = 4;
const IMAGE_TOKENS = 512;

function textTokens(s: string): number {
  if (s.length === 0) return 0;
  return Math.ceil(s.length / APPROX_CHARS_PER_TOKEN);
}

export function approxCount(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += ROLE_OVERHEAD;

    if (typeof msg.content === 'string') {
      total += textTokens(msg.content);
    } else {
      for (const part of msg.content) {
        if (part.type === 'text') {
          total += textTokens(part.text);
        } else {
          total += IMAGE_TOKENS;
        }
      }
    }

    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += ROLE_OVERHEAD;
        // tc.arguments is `unknown` — JSON.stringify can throw (circular refs,
        // BigInt) or return undefined (a bare undefined value). Either case must
        // not crash a pure token estimate, so fall back to 0 for the arguments.
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(tc.arguments);
        } catch {
          serialized = undefined;
        }
        total += serialized === undefined ? 0 : textTokens(serialized);
      }
    }
  }
  return total;
}
