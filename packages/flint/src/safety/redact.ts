import type { Transform } from '../compress.ts';
import type { ContentPart, Message } from '../types.ts';

export type RedactOptions = {
  patterns: RegExp[];
  replacement?: string;
};

function redactString(s: string, patterns: RegExp[], replacement: string): string {
  return patterns.reduce((acc, p) => acc.replace(p, replacement), s);
}

function redactMessage(msg: Message, patterns: RegExp[], replacement: string): Message {
  if (typeof msg.content === 'string') {
    return { ...msg, content: redactString(msg.content, patterns, replacement) };
  }
  // msg.content is ContentPart[] (only user can have this)
  const parts: ContentPart[] = msg.content.map((part) =>
    part.type === 'text' ? { ...part, text: redactString(part.text, patterns, replacement) } : part,
  );
  // Since only user role can have ContentPart[], this is safe
  return {
    ...msg,
    content: parts,
  } as Message;
}

export function redact(opts: RedactOptions): Transform {
  const replacement = opts.replacement ?? '[REDACTED]';
  return async (messages) => messages.map((m) => redactMessage(m, opts.patterns, replacement));
}

export const secretPatterns: RegExp[] = [
  /sk-[a-zA-Z0-9]{32,}/g,
  /sk-ant-[a-zA-Z0-9_-]{32,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /ghs_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/g,
  /sk_(?:live|test)_[a-zA-Z0-9]{24,}/g,
  /-----BEGIN (?:[A-Z0-9 -]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z0-9 -]+ )?PRIVATE KEY-----/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
];
