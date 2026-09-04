import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@knowledge-gardener/domain": path.resolve(
        directory,
        "../../packages/domain/src/index.ts",
      ),
      "@knowledge-gardener/fixtures": path.resolve(
        directory,
        "../../packages/fixtures/src/index.ts",
      ),
      "@knowledge-gardener/source": path.resolve(
        directory,
        "../../packages/source/src/index.ts",
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
