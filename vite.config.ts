import { defineConfig } from 'vite';

export default defineConfig({
  // The packaged Electron app is loaded through file://, so assets must be
  // resolved relative to dist/index.html instead of from the filesystem root.
  base: './'
});
