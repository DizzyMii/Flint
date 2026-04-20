import type {
  AdapterCapabilities,
  NormalizedRequest,
  NormalizedResponse,
  ProviderAdapter,
} from '../adapter.ts';
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
  onStream?: (
    req: NormalizedRequest,
    callIndex: number,
  ) => AsyncIterable<StreamChunk>;
  count?: (messages: Message[], model: string) => number;
};

export function mockAdapter(opts: MockAdapterOptions): MockAdapter {
  const calls: NormalizedRequest[] = [];
  let callIndex = 0;

  async function* defaultStream(
    req: NormalizedRequest,
    index: number,
  ): AsyncIterable<StreamChunk> {
    const resp = await opts.onCall(req, index);
    if (resp.message.content) {
      yield { type: 'text', delta: resp.message.content };
    }
    yield { type: 'usage', usage: resp.usage, ...(resp.cost !== undefined ? { cost: resp.cost } : {}) };
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
      const iter = opts.onStream
        ? opts.onStream(req, index)
        : defaultStream(req, index);
      return iter;
    },
    ...(opts.count ? { count: opts.count } : {}),
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
