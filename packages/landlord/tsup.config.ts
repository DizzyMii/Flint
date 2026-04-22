import { defineConfig } from 'tsup';

// biome-ignore lint/style/noDefaultExport: tsup config requires default export
export default defineConfig({
  entry: ['src/index.ts', 'src/tools/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  sourcemap: true,
  external: ['flint'],
});
