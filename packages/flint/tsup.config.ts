import { defineConfig } from 'tsup';

// biome-ignore lint/style/noDefaultExport: tsup config requires default export
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/memory.ts',
    'src/rag.ts',
    'src/compress.ts',
    'src/recipes.ts',
    'src/budget.ts',
    'src/errors.ts',
    'src/testing/mock-adapter.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  sourcemap: true,
});
