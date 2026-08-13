import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// electron-vite builds three independent bundles from one config:
// main (Node, has fs/DuckDB access), preload (the contextBridge boundary),
// and renderer (the React + Univer UI, sandboxed, no Node access).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()], // keep @duckdb/node-api as a real native require, don't bundle it
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html',
      },
    },
  },
});
