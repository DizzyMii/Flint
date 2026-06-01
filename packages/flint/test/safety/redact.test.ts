import { describe, expect, it } from 'vitest';
import { redact, secretPatterns } from '../../src/safety/redact.ts';
import type { Message } from '../../src/types.ts';

describe('redact', () => {
  it('returns a Transform function', () => {
    const t = redact({ patterns: [/x/g] });
    expect(typeof t).toBe('function');
  });

  it('replaces pattern in user string content', async () => {
    const t = redact({ patterns: [/secret-\w+/g] });
    const msgs: Message[] = [{ role: 'user', content: 'my secret-abc123 here' }];
    const out = await t(msgs, {});
    expect(out[0]?.content).toBe('my [REDACTED] here');
  });

  it('replaces pattern in assistant string content', async () => {
    const t = redact({ patterns: [/key/g] });
    const msgs: Message[] = [{ role: 'assistant', content: 'the key is used' }];
    const out = await t(msgs, {});
    expect(out[0]?.content).toBe('the [REDACTED] is used');
  });

  it('replaces pattern in tool message content', async () => {
    const t = redact({ patterns: [/private/g] });
    const msgs: Message[] = [{ role: 'tool', content: 'private info', toolCallId: 'c1' }];
    const out = await t(msgs, {});
    expect(out[0]?.content).toBe('[REDACTED] info');
  });

  it('replaces pattern in system content', async () => {
    const t = redact({ patterns: [/bad/g] });
    const msgs: Message[] = [{ role: 'system', content: 'a bad token' }];
    const out = await t(msgs, {});
    expect(out[0]?.content).toBe('a [REDACTED] token');
  });

  it('replaces pattern in ContentPart text parts; leaves images untouched', async () => {
    const t = redact({ patterns: [/redactme/g] });
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'please redactme now' },
          { type: 'image', url: 'https://example.com/redactme.png' },
        ],
      },
    ];
    const out = await t(msgs, {});
    const parts = out[0]?.content;
    expect(Array.isArray(parts)).toBe(true);
    if (Array.isArray(parts)) {
      expect(parts[0]).toEqual({ type: 'text', text: 'please [REDACTED] now' });
      // image URL is NOT redacted (we only scan text parts)
      expect(parts[1]).toEqual({ type: 'image', url: 'https://example.com/redactme.png' });
    }
  });

  it('applies multiple patterns in order', async () => {
    const t = redact({ patterns: [/foo/g, /bar/g] });
    const msgs: Message[] = [{ role: 'user', content: 'foo bar baz' }];
    const out = await t(msgs, {});
    expect(out[0]?.content).toBe('[REDACTED] [REDACTED] baz');
  });

  it('uses custom replacement string', async () => {
    const t = redact({ patterns: [/x/g], replacement: '***' });
    const msgs: Message[] = [{ role: 'user', content: 'xylophone' }];
    const out = await t(msgs, {});
    expect(out[0]?.content).toBe('***ylophone');
  });

  it('does not mutate input messages', async () => {
    const t = redact({ patterns: [/secret/g] });
    const msg: Message = { role: 'user', content: 'secret stuff' };
    const msgs = [msg];
    const out = await t(msgs, {});
    expect(msg.content).toBe('secret stuff');
    expect(out[0]?.content).toBe('[REDACTED] stuff');
  });
});

describe('secretPatterns preset', () => {
  const cases: Array<[string, string]> = [
    ['OpenAI key', 'my key is sk-abcdefghijklmnopqrstuvwxyz01234567'],
    ['Anthropic key', 'use sk-ant-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['AWS access key', 'AKIA0123456789ABCDEF'],
    ['GitHub PAT', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['Slack token', 'xoxb-1234567890-abcdefg'],
    ['Stripe live key', 'sk_live_abcdefghijklmnopqrstuvwx'],
    ['SSN', 'SSN: 123-45-6789'],
    ['Credit card', 'card 4111-1111-1111-1111'],
    [
      'RSA private key',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj\n-----END RSA PRIVATE KEY-----',
    ],
    [
      'generic PKCS#8 private key',
      '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGBy\n-----END PRIVATE KEY-----',
    ],
    [
      'encrypted private key',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFLTBXBgkq\n-----END ENCRYPTED PRIVATE KEY-----',
    ],
  ];

  for (const [label, text] of cases) {
    it(`redacts ${label}`, async () => {
      const t = redact({ patterns: secretPatterns });
      const msgs: Message[] = [{ role: 'user', content: text }];
      const out = await t(msgs, {});
      expect(out[0]?.content).toContain('[REDACTED]');
    });
  }
});
