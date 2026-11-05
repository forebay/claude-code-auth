import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["siblings/**", "node_modules/**", "src/driver/**", "src/__tests__/**"],
  },
});
