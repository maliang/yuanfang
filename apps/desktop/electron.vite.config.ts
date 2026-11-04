import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/main/index.ts"),
        output: { format: "es", entryFileNames: "index.js" },
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        "@yuanfang/shared": resolve(import.meta.dirname, "../../packages/shared/src/index.ts"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/preload/index.ts"),
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/renderer/index.html"),
      },
    },
  },
});
