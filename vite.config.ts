import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "frontend",
  base: "/static/dist/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../static/dist",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/prompt-vault.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          if (path.includes("/node_modules/monaco-editor/") || path.includes("/node_modules/@monaco-editor/")) return "monaco";
          if (path.includes("/node_modules/react/") || path.includes("/node_modules/react-dom/") || path.includes("/node_modules/scheduler/")) return "react-runtime";
          if (path.includes("/node_modules/@antv/g6-extension-react/")) return "graph-react";
          if (path.includes("/node_modules/@antv/g6/")) return "graph-core";
          if (/\/node_modules\/@antv\/(g|g-canvas|g-svg|g-lite|g-plugin-[^/]+)\//.test(path)) return "graph-renderer";
          if (/\/node_modules\/@antv\/(layout|hierarchy)\//.test(path)) return "graph-layout";
          if (path.includes("/node_modules/@antv/vendor/") || /\/node_modules\/d3-[^/]+\//.test(path)) return "graph-math";
          if (/\/node_modules\/@antv\/(component|scale)\//.test(path)) return "graph-components";
          if (path.includes("/node_modules/@antv/")) return "graph-utils";
          if (path.includes("/node_modules/@radix-ui/") || path.includes("/node_modules/@floating-ui/")) return "ui-primitives";
          if (path.includes("/node_modules/framer-motion/") || path.includes("/node_modules/motion-dom/")) return "motion";
          if (path.includes("/node_modules/@tanstack/") || path.includes("/node_modules/embla-carousel")) return "app-vendor";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8767",
    },
  },
});
