import { MetaError } from './errors.ts';
import type { Meta } from './types.ts';

function skipWs(s: string, i: number): number {
  let pos = i;
  while (pos < s.length) {
    const c = s[pos];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') pos++;
    else break;
  }
  return pos;
}

function parseString(s: string, i: number): { value: string; end: number } {
  const quote = s[i];
  let pos = i + 1;
  let out = '';
  while (pos < s.length && s[pos] !== quote) {
    if (s[pos] === '\\') {
      const n = s[pos + 1];
      out +=
        n === 'n'
          ? '\n'
          : n === 't'
            ? '\t'
            : n === 'r'
              ? '\r'
              : n === '\\'
                ? '\\'
                : n === quote
                  ? quote
                  : (n ?? '');
      pos += 2;
    } else {
      out += s[pos];
      pos++;
    }
  }
  if (s[pos] !== quote) throw new MetaError('Unterminated string in meta literal');
  return { value: out, end: pos + 1 };
}

function parseNumber(s: string, i: number): { value: number; end: number } {
  const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
  if (!m) throw new MetaError('Invalid number in meta literal');
  return { value: Number(m[0]), end: i + m[0].length };
}

function parseKey(s: string, i: number): { value: string; end: number } {
  const c = s[i];
  if (c === '"' || c === "'") return parseString(s, i);
  const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
  if (!m) throw new MetaError(`Invalid object key at index ${i}`);
  return { value: m[0], end: i + m[0].length };
}

export function parseLiteral(s: string, start = 0): { value: unknown; end: number } {
  const i = skipWs(s, start);
  const ch = s[i];
  if (ch === '{') {
    let j = skipWs(s, i + 1);
    const obj: Record<string, unknown> = {};
    if (s[j] === '}') return { value: obj, end: j + 1 };
    while (j < s.length) {
      j = skipWs(s, j);
      const key = parseKey(s, j);
      j = skipWs(s, key.end);
      if (s[j] !== ':') throw new MetaError(`Expected ':' at index ${j}`);
      const val = parseLiteral(s, j + 1);
      obj[key.value] = val.value;
      j = skipWs(s, val.end);
      if (s[j] === ',') {
        j = skipWs(s, j + 1);
        if (s[j] === '}') return { value: obj, end: j + 1 };
        continue;
      }
      if (s[j] === '}') return { value: obj, end: j + 1 };
      throw new MetaError(`Expected ',' or '}' at index ${j}`);
    }
    throw new MetaError('Unterminated object in meta literal');
  }
  if (ch === '[') {
    let j = skipWs(s, i + 1);
    const arr: unknown[] = [];
    if (s[j] === ']') return { value: arr, end: j + 1 };
    while (j < s.length) {
      const val = parseLiteral(s, j);
      arr.push(val.value);
      j = skipWs(s, val.end);
      if (s[j] === ',') {
        j = skipWs(s, j + 1);
        if (s[j] === ']') return { value: arr, end: j + 1 };
        continue;
      }
      if (s[j] === ']') return { value: arr, end: j + 1 };
      throw new MetaError(`Expected ',' or ']' at index ${j}`);
    }
    throw new MetaError('Unterminated array in meta literal');
  }
  if (ch === '"' || ch === "'") return parseString(s, i);
  if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) return parseNumber(s, i);
  if (s.startsWith('true', i)) return { value: true, end: i + 4 };
  if (s.startsWith('false', i)) return { value: false, end: i + 5 };
  if (s.startsWith('null', i)) return { value: null, end: i + 4 };
  throw new MetaError(`Unexpected token in meta literal at index ${i}: '${s.slice(i, i + 12)}'`);
}

export function parseMeta(source: string): Meta {
  const m = /export\s+const\s+meta\s*=/.exec(source);
  if (!m) throw new MetaError('Script is missing `export const meta = { ... }`');
  const { value } = parseLiteral(source, m.index + m[0].length);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MetaError('meta must be an object literal');
  }
  const meta = value as Record<string, unknown>;
  if (typeof meta.name !== 'string' || typeof meta.description !== 'string') {
    throw new MetaError('meta requires string `name` and `description`');
  }
  return meta as unknown as Meta;
}
