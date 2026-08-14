import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/index.harness.ts"],
    environment: "node",
  },
});
