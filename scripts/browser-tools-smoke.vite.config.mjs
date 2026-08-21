import { defineConfig } from "vite";

export default defineConfig({
  esbuild: { target: "esnext" },
  build: {
    target: "esnext",
    ssr: "scripts/browser-tools-electron-smoke.mjs",
    outDir: "out/browser-tools-smoke",
    emptyOutDir: true,
    rollupOptions: {
      external: ["electron", /^node:/],
      output: {
        format: "es",
        entryFileNames: "index.mjs",
      },
    },
  },
});
