import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const pkg = (name: string) => `${root}packages/${name}/src/index.ts`;

export default defineConfig({
  resolve: {
    alias: {
      "@josharsh/pixelpi-ai": pkg("ai"),
      "@josharsh/pixelpi-core": pkg("core"),
      "@josharsh/pixelpi-cdp": pkg("cdp"),
      "pixelpi": pkg("agent"),
    },
  },
  test: {
    include: ["packages/**/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
  },
});
