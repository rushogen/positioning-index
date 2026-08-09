import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Root-served static SPA. HashRouter is used (see main.tsx) so the deploy needs
// no server-side rewrite rules -- it is a pure static mirror, rsynced to the VPS
// exactly like the old site. Everything is bundled and self-hosted: no runtime
// third-party request, which keeps the project's no-consent-banner property.
export default defineConfig({
  // Root for the VPS (index.rushogen.com); the GitHub Pages build sets
  // BASE_PATH=/positioning-index/ for the project subpath. The app reads asset,
  // font and /api paths off import.meta.env.BASE_URL, so one codebase serves both.
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    // Big libraries (three, echarts) get their own chunks so the Positioning tab
    // does not pay to download the 3D globe it never shows.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/three/') || id.includes('@react-three')) return 'three';
          if (id.includes('/echarts/') || id.includes('/zrender/')) return 'echarts';
          if (id.includes('/d3-') || id.includes('/d3/')) return 'd3';
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
});
