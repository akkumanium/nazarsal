import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 15000,
    maxWorkers: 1, fileParallelism: false,
    execArgv: ["--wasm-num-compilation-tasks=1", "--liftoff-only", "--no-opt"]
  }
});
