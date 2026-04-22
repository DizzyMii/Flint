# Installation

## Prerequisites

- **Node.js 20+** (Flint uses Web API primitives — `fetch`, `ReadableStream`, `TextDecoder`)
- A package manager: npm, pnpm, or yarn

## Install

Choose one adapter. The Anthropic adapter is the default; the OpenAI-compatible adapter works with any OpenAI-format endpoint.

::: code-group

```sh [Anthropic]
npm install flint @flint/adapter-anthropic
```

```sh [OpenAI-compatible]
npm install flint @flint/adapter-openai-compat
```

```sh [Both]
npm install flint @flint/adapter-anthropic @flint/adapter-openai-compat
```

:::

## Optional packages

```sh
# State machine workflows
npm install @flint/graph
```

## TypeScript configuration

Flint requires `"moduleResolution": "bundler"` or `"node16"/"nodenext"` to resolve subpath exports correctly.

```json
// tsconfig.json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "target": "ES2022",
    "strict": true
  }
}
```

## Set up your API key

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

Or use a `.env` file with your preferred dotenv loader (Flint does not load `.env` automatically).

## Verify the install

```ts
import { call } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Say hello' }],
});

console.log(res.ok ? res.value.message.content : res.error.message);
```

> [!NOTE]
> Flint is not yet published to npm. Install from the repository directly during v0:
> `npm install github:DizzyMii/flint`

## Monorepo setup

In a monorepo, install at the workspace level:

```sh
pnpm add flint @flint/adapter-anthropic --filter my-app
# or
npm install flint @flint/adapter-anthropic -w packages/my-app
```

## Runtime support

| Runtime | Support |
|---------|---------|
| Node.js 20+ | Full support |
| Bun 1.0+ | Full support |
| Deno 1.40+ | Full support (use npm: specifier) |
| Browser | Core works; adapters require CORS |
| Cloudflare Workers | Use `fetch` — no Node.js specifics needed |
| AWS Lambda | Node.js 20 runtime |

## Common installation errors

**`ERR_REQUIRE_ESM`**: Add `"type": "module"` to `package.json`.

**`Cannot find module 'flint/budget'`**: Requires `moduleResolution: "bundler"` or `"node16"` in `tsconfig.json`.

**`Cannot find module '@standard-schema/spec'`**: Run `npm install` again — peer dependency may not have been auto-installed.

## See also

- [Quick Start](/guide/quick-start) — first working example
- [Setup](/guide/#setup) — API key and TypeScript config
