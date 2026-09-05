import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  resolve: {
    preserveSymlinks: true,
    alias: {
      "@knowledge-gardener/domain": path.resolve(
        directory,
        "../../packages/domain/src/index.ts",
      ),
    },
  },
});
