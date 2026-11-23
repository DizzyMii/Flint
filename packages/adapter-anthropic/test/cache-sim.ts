/**
 * A fake Anthropic endpoint that bills like the real prompt cache: prefix hashes are written at
 * cache_control breakpoints, and a request reads the longest previously-written prefix found at or
 * up to 20 blocks before one of its breakpoints. Token counts are approximated from block JSON.
 */

type Block = Record<string, unknown>;

function fnv(input: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function strip(block: Block): Block {
  const { cache_control: _cc, ...rest } = block;
  return rest;
}

export type SimResponse = { content: Block[]; stop_reason: string; output_tokens: number };

export type CacheSim = {
  fetch: typeof globalThis.fetch;
  requests: Array<{ body: Record<string, unknown>; usage: Record<string, number> }>;
};

export function cacheSim(
  respond: (index: number, body: Record<string, unknown>) => SimResponse,
  opts: { transformBody?: (body: Record<string, unknown>) => void } = {},
): CacheSim {
  const store = new Set<number>();
  const requests: CacheSim['requests'] = [];

  const fetchFn = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    opts.transformBody?.(body);

    const positions: Block[] = [];
    for (const t of (body.tools as Block[] | undefined) ?? []) positions.push(t);
    for (const s of (body.system as Block[] | undefined) ?? []) positions.push(s);
    for (const m of body.messages as Array<{ role: string; content: string | Block[] }>) {
      if (typeof m.content === 'string')
        positions.push({ type: 'text', text: m.content, role: m.role });
      else for (const b of m.content) positions.push({ ...b, role: m.role });
    }

    const tokens: number[] = [];
    const hashes: number[] = [];
    const breakpoints: number[] = [];
    let h = 0x811c9dc5;
    positions.forEach((p, i) => {
      const s = JSON.stringify(strip(p));
      tokens.push(Math.ceil(s.length / 3.5));
      h = fnv(s, h);
      hashes.push(h);
      if (p.cache_control) breakpoints.push(i);
    });
    const sum = (from: number, to: number) => tokens.slice(from, to).reduce((a, b) => a + b, 0);

    let read = -1;
    for (const bp of breakpoints) {
      for (let j = bp; j >= Math.max(0, bp - 20); j--) {
        if (store.has(hashes[j] as number)) {
          read = Math.max(read, j);
          break;
        }
      }
    }
    const lastBp = breakpoints.length > 0 ? (breakpoints[breakpoints.length - 1] as number) : -1;
    for (const bp of breakpoints) if (bp > read) store.add(hashes[bp] as number);

    const cached = sum(0, read + 1);
    const cacheWrite = lastBp > read ? sum(read + 1, lastBp + 1) : 0;
    const input = sum(Math.max(read, lastBp) + 1, positions.length);

    const r = respond(requests.length, body);
    const usage = {
      input_tokens: input,
      output_tokens: r.output_tokens,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: cacheWrite,
    };
    requests.push({ body, usage });
    return new Response(
      JSON.stringify({
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: r.content,
        stop_reason: r.stop_reason,
        usage,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  return { fetch: fetchFn as typeof globalThis.fetch, requests };
}

/** Strip message-level breakpoints: reproduces the pre-1.1 adapter, which cached only tools + system. */
export function legacyCacheLayout(body: Record<string, unknown>): void {
  for (const m of body.messages as Array<{ content: string | Block[] }>) {
    if (typeof m.content !== 'string') for (const b of m.content) b.cache_control = undefined;
  }
}
