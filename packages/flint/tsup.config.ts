import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/memory.ts',
    'src/rag.ts',
    'src/compress.ts',
    'src/recipes.ts',
    'src/budget.ts',
    'src/errors.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  sourcemap: true,
});
