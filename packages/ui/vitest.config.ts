import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { zoodAssetAliases } from './vite/index.ts';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: zoodAssetAliases() },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'vite/**/*.test.ts'],
    restoreMocks: true,
  },
});
