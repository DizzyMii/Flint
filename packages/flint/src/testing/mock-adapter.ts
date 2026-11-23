import type {
  AdapterCapabilities,
  NormalizedRequest,
  NormalizedResponse,
  ProviderAdapter,
} from '../adapter.ts';
import { FlintError } from '../errors.ts';
import type { ModelPricing } from '../pricing.ts';
import type { Message, StreamChunk } from '../types.ts';

export type MockAdapter = ProviderAdapter & {
  calls: NormalizedRequest[];
};

export type MockAdapterOptions = {
  name?: string;
  capabilities?: AdapterCapabilities;
  onCall: (
    req: NormalizedRequest,
    callIndex: number,
  ) => NormalizedResponse | Promise<NormalizedResponse>;
  onStream?: (req: NormalizedRequest, callIndex: number) => AsyncIterable<StreamChunk>;
  count?: (messages: Message[], model: string) => number;
  pricing?: (model: string) => ModelPricing | undefined;
};

export function mockAdapter(opts: MockAdapterOptions): MockAdapter {
  const calls: NormalizedRequest[] = [];
  let callIndex = 0;

  async function* defaultStream(req: NormalizedRequest, index: number): AsyncIterable<StreamChunk> {
    const resp = await opts.onCall(req, index);
    if (resp.message.content) {
      yield { type: 'text', delta: resp.message.content };
    }
    yield {
      type: 'usage',
      usage: resp.usage,
      ...(resp.cost !== undefined ? { cost: resp.cost } : {}),
    };
    yield { type: 'end', reason: resp.stopReason };
  }

  const adapter: MockAdapter = {
    name: opts.name ?? 'mock',
    capabilities: opts.capabilities ?? {},
    calls,
    async call(req) {
      calls.push(req);
      const index = callIndex++;
      return opts.onCall(req, index);
    },
    stream(req) {
      calls.push(req);
      const index = callIndex++;
      const iter = opts.onStream ? opts.onStream(req, index) : defaultStream(req, index);
      return iter;
    },
    ...(opts.count ? { count: opts.count } : {}),
    ...(opts.pricing ? { pricing: opts.pricing } : {}),
  };

  return adapter;
}

export function scriptedAdapter(
  responses: NormalizedResponse[],
  opts?: { name?: string; capabilities?: AdapterCapabilities },
): MockAdapter {
  return mockAdapter({
    ...(opts?.name !== undefined ? { name: opts.name } : {}),
    ...(opts?.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    onCall: (_req, index) => {
      const resp = responses[index];
      if (resp === undefined) {
        throw new Error(
          `scriptedAdapter: reached past end of scripted responses (index ${index}, length ${responses.length})`,
        );
      }
      return resp;
    },
  });
}

/** Responses recorded per request fingerprint. JSON-serializable: commit it next to the test. */
export type Cassette = Record<string, NormalizedResponse[]>;

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(',')}}`;
}

/** Fingerprint of everything that determines a model response. Ignores signals, schemas and handlers. */
export function requestKey(req: NormalizedRequest): string {
  const material = stable({
    model: req.model,
    messages: req.messages,
    tools: req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.jsonSchema,
    })),
    jsonSchema: req.jsonSchema,
    temperature: req.temperature,
    stopSequences: req.stopSequences,
    extra: req.extra,
  });
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < material.length; i++) {
    const c = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

/** Wraps a real adapter and records every response into `cassette`. */
export function recordingAdapter(
  inner: ProviderAdapter,
  cassette: Cassette = {},
): ProviderAdapter & {
  cassette: Cassette;
} {
  return {
    name: inner.name,
    capabilities: inner.capabilities,
    cassette,
    ...(inner.count ? { count: inner.count.bind(inner) } : {}),
    ...(inner.pricing ? { pricing: inner.pricing.bind(inner) } : {}),
    async call(req) {
      const resp = await inner.call(req);
      const key = requestKey(req);
      const { raw: _raw, ...stored } = resp;
      (cassette[key] ??= []).push(stored);
      return resp;
    },
    stream(req) {
      return inner.stream(req);
    },
  };
}

/**
 * Serves responses from a cassette, keyed by request fingerprint. Any request the cassette has not
 * seen fails loudly, so a prompt or tool change is caught instead of silently replaying stale output.
 */
export function replayAdapter(
  cassette: Cassette,
  opts: {
    name?: string;
    capabilities?: AdapterCapabilities;
    pricing?: (model: string) => ModelPricing | undefined;
  } = {},
): MockAdapter {
  const used = new Map<string, number>();
  return mockAdapter({
    name: opts.name ?? 'replay',
    ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    ...(opts.pricing !== undefined ? { pricing: opts.pricing } : {}),
    onCall: (req) => {
      const key = requestKey(req);
      const n = used.get(key) ?? 0;
      const resp = cassette[key]?.[n];
      if (resp === undefined) {
        throw new FlintError(`replayAdapter: no recorded response for request ${key} (#${n + 1})`, {
          code: 'testing.cassette_miss',
        });
      }
      used.set(key, n + 1);
      return resp;
    },
  });
}
