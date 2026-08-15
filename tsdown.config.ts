import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: ['src/index.ts', 'src/startup.ts'],
  fixedExtension: false,
  format: ['esm'],
  outDir: 'lib',
  platform: 'node',
  sourcemap: true,
  target: 'node22.19',
})
