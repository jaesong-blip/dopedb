/// <reference types="vitest/config" />

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri v2 dev server config. Fixed port so the Rust side can point WKWebView at it.
export default defineConfig({
  plugins: [tailwindcss(), react()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  test: {
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      // UI 하네스는 Playwright가 실행한다. vitest가 수집하면 안 된다.
      "tests/ui-harness/**",
      "tests/ui-benchmark/**",
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: false,
  },
  build: {
    target: "esnext",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](?:react|react-dom|@tanstack[\\/]react-query)[\\/]/,
              includeDependenciesRecursively: true,
              priority: 20,
            },
          ],
        },
      },
    },
  },
});
