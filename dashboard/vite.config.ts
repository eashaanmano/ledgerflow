import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: gateway, changeOrigin: true },
      '/gateway-health': { target: gateway, changeOrigin: true, rewrite: () => '/health' },
    },
  },
});
