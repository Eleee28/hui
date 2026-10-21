// Vitest settings behind `npm test`. Kept apart from vite.config.ts so tests run without the dev gateway plugin.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{bin,cli,desktop,evals,scripts,server,src}/**/*.test.{ts,mjs,js}"],
    // A test or hook that never ends fails after five minutes, far past the slowest one, and the log names it.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    restoreMocks: true,
    unstubGlobals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
