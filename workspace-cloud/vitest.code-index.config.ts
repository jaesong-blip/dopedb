import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/knowledge/code-index-core.harness.ts"],
  },
});
