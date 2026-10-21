import { defineConfig } from "vite";

import { huiConfig } from "./server/vite-plugin.ts";

export default defineConfig({
  plugins: [huiConfig()],
});
