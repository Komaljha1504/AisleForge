import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The API is reached through a same-origin proxy (dev and preview) or the nginx reverse proxy (containers), so the
// SameSite=Strict, Path=/api/v1/auth refresh cookie and the CSRF Origin check work without CORS.
const api = process.env.AISLEFORGE_API_URL ?? 'http://127.0.0.1:8080';
const proxy = {
  '/api': { target: api },
  '/internal': { target: api },
  '/health': { target: api },
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'AisleForge',
        short_name: 'AisleForge',
        description: 'Retail fulfilment: ordering, offline-first picking and operations',
        start_url: '/',
        display: 'standalone',
        background_color: '#f8fafc',
        theme_color: '#0f766e',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // App shell only. Authenticated API responses are NEVER cached by the service worker (ADR-004);
        // offline data lives in IndexedDB, scoped per user.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/internal\//, /^\/health\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
  build: { sourcemap: true, target: 'es2022' },
});
