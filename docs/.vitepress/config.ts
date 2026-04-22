import { defineConfig } from 'vitepress';

// biome-ignore lint/style/noDefaultExport: VitePress requires default export
export default defineConfig({
  title: 'Flint',
  description: 'Token-efficient agentic TypeScript runtime',
  base: '/Flint/',
  srcExclude: ['superpowers/**'],

  head: [['link', { rel: 'icon', type: 'image/png', href: '/Flint/logo.png' }]],

  themeConfig: {
    logo: '/logo.png',
    siteTitle: 'Flint',

    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'Primitives', link: '/primitives/call' },
      { text: 'Features', link: '/features/budget' },
      { text: 'Adapters', link: '/adapters/anthropic' },
      { text: 'Examples', link: '/examples/basic-call' },
      {
        text: 'v0',
        items: [
          { text: 'v0 Status & Stability', link: '/guide/v0-status' },
          {
            text: 'Changelog',
            link: 'https://github.com/DizzyMii/flint/blob/main/.changeset/README.md',
          },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'What is Flint?', link: '/guide/' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Quick Start', link: '/guide/quick-start' },
            { text: 'v0 Status', link: '/guide/v0-status' },
          ],
        },
      ],
      '/primitives/': [
        {
          text: 'Primitives',
          items: [
            { text: 'call()', link: '/primitives/call' },
            { text: 'stream()', link: '/primitives/stream' },
            { text: 'validate()', link: '/primitives/validate' },
            { text: 'tool()', link: '/primitives/tool' },
            { text: 'execute()', link: '/primitives/execute' },
            { text: 'count()', link: '/primitives/count' },
            { text: 'agent()', link: '/primitives/agent' },
          ],
        },
      ],
      '/features/': [
        {
          text: 'Features',
          items: [
            { text: 'Budget', link: '/features/budget' },
            { text: 'Compress & Pipeline', link: '/features/compress' },
            { text: 'Memory', link: '/features/memory' },
            { text: 'RAG', link: '/features/rag' },
            { text: 'Recipes', link: '/features/recipes' },
            { text: 'Safety', link: '/features/safety' },
            { text: 'Graph', link: '/features/graph' },
          ],
        },
      ],
      '/adapters/': [
        {
          text: 'Adapters',
          items: [
            { text: 'Anthropic', link: '/adapters/anthropic' },
            { text: 'OpenAI-Compatible', link: '/adapters/openai-compat' },
            { text: 'Writing an Adapter', link: '/adapters/custom' },
          ],
        },
      ],
      '/examples/': [
        {
          text: 'Examples',
          items: [
            { text: 'Basic Call', link: '/examples/basic-call' },
            { text: 'Tool Use', link: '/examples/tools' },
            { text: 'Agent Loop', link: '/examples/agent' },
            { text: 'Streaming', link: '/examples/streaming' },
            { text: 'ReAct Pattern', link: '/examples/react-pattern' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/DizzyMii/flint' }],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 DizzyMii',
    },

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/DizzyMii/flint/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
});
