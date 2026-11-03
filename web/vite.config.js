import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Read by this config only, never by browser code (no VITE_ prefix). Docker Compose sets it to the
// backend's service name; on the host it stays the loopback default.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API key and every document stay server-side (PRD 20). The browser
    // only ever talks to our own backend, never to an LLM provider.
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
