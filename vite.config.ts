import { defineConfig } from 'vite';

export default defineConfig({
  // Tauri serves the bundled frontend from its application protocol. Relative
  // assets keep development and packaged builds on the same path semantics.
  base: './'
});
