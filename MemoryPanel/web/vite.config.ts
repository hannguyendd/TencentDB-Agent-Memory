import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// team-memory-control backend address (the backend hosting chain A `/api/v1/meta/*` and similar endpoints).
const TMC_BACKEND_TARGET = process.env.VITE_TMC_BACKEND_URL || 'http://127.0.0.1:8123';

// Skill Gateway address (the memory gateway hosting `/v3/skill/*` and similar endpoints).
const SKILL_GATEWAY_TARGET = process.env.VITE_SKILL_GATEWAY_URL || 'http://127.0.0.1:8420';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api/v1': {
        target: TMC_BACKEND_TARGET,
        changeOrigin: true,
      },
      '/health': {
        target: TMC_BACKEND_TARGET,
        changeOrigin: true,
      },
      '/v3': {
        target: SKILL_GATEWAY_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
