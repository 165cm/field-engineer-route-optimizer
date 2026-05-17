import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  // loadEnv only reads .env* files. In CI (GitHub Actions) the keys are
  // injected via the workflow's env: block into process.env, so we have to
  // fall through to process.env to pick those up.
  const env = loadEnv(mode, '.', '');
  const pick = (k: string) => process.env[k] ?? env[k] ?? '';
  // For GitHub Pages project sites the app lives at /<repo>/ — set the base
  // via VITE_BASE at build time (the deploy workflow sets it).
  const base = pick('VITE_BASE') || '/';
  return {
    base,
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(pick('GEMINI_API_KEY')),
      'process.env.GOOGLE_MAPS_PLATFORM_KEY': JSON.stringify(pick('GOOGLE_MAPS_PLATFORM_KEY')),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
