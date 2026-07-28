import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["frontend/src/**/*.test.{ts,tsx}", "src/**/*.test.ts"],
    environment: "jsdom",
  },
});
