import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone Vite config to serve the Electron renderer in a browser.
// NOTE: This is for previewing the UI layout only. The Electron preload bridge
// (window.kozum.*) will not be available, so backend IPC calls will fail and
// the app will show error states. Full functionality requires running under
// Electron (npm run dev) on a desktop with a display.
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer"),
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
  server: {
    port: 3000,
    host: true,
  },
  build: {
    outDir: resolve(__dirname, "../public/kozum-preview"),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } },
  },
});
