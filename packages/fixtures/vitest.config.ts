import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const directory = path.dirname(fileURLToPath(import.meta.url));

function markdownTextModules(): Plugin {
  return {
    name: "markdown-text-modules",
    enforce: "pre",
    async load(id) {
      const filename = id.split("?", 1)[0];
      if (filename?.endsWith(".md") !== true) return null;
      const markdown = await readFile(filename, "utf8");
      return `export default ${JSON.stringify(markdown)};`;
    },
  };
}

export default defineConfig({
  plugins: [markdownTextModules()],
  resolve: {
    alias: {
      "@knowledge-gardener/domain": path.resolve(
        directory,
        "../domain/src/index.ts",
      ),
      "@knowledge-gardener/source": path.resolve(
        directory,
        "../source/src/index.ts",
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
