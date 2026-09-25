import { defineConfig } from 'vite';
import { zoodUi } from '@zood/ui/vite';

// Chrome MV3 extension: the same UI as an extension page (index.html) + a background service worker.
export default defineConfig({
  base: './',
  plugins: [zoodUi()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: { index: 'index.html', background: 'src/background.ts' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
