import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5177,
    strictPort: true,
    proxy: {
      "/qgis": {
        target: process.env.QGIS_SERVER_PROXY_TARGET ?? "http://127.0.0.1:8085",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/qgis/, ""),
      },
    },
  },
});
