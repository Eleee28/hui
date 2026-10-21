/**
 * The Vite plugin every development entry point shares: it serves the `/__hui/` API from the dev and preview
 * servers, starts and stops the backend with them, attaches terminal and live-stream upgrades, and carries the
 * Vite settings Gespenst (the terminal renderer) needs.
 */
import type { Plugin } from "vite";
import { attachLiveStreams, middleware } from "./hui.ts";
import { startBackend, stopBackend } from "./backend.ts";
import { attachTerminalTransport } from "./terminals/transport.ts";
import { recordDiagnosticEvent } from "./observability.ts";

const GESPENST_NODE_STUB = "\0hui:gespenst-node-builtin";

export function huiConfig(): Plugin {
  return {
    name: "hui-config",
    // Gespenst (the terminal renderer) loads its worker and WebAssembly relative to its own module; pre-bundling
    // would move the module away from them. Every entry point (vite.config.ts, hui-dev, the visual-verification
    // server) shares this plugin.
    config: () => ({ optimizeDeps: { exclude: ["@gespenst/core"] }, worker: { format: "es" as const } }),
    // Its WebAssembly loader reads file: URLs through node:fs/promises and node:url when it runs under Node; the
    // browser only fetches. An empty module replaces those two imports instead of Vite's externalization warning.
    resolveId: {
      order: "pre",
      handler(id, importer) {
        if ((id === "node:fs/promises" || id === "node:url") && importer?.includes("/node_modules/@gespenst/core/")) return GESPENST_NODE_STUB;
        return undefined;
      },
    },
    load(id) { return id === GESPENST_NODE_STUB ? "export {};" : undefined; },
    configureServer(server) {
      if (server.httpServer) {
        // Vite restarts by creating this server, closing the previous one (its
        // `closeBundle` stops that backend and releases the Durable store) and
        // only then listening. Starting here keeps the two backends apart.
        server.httpServer.once("listening", () => { void startBackend(); });
        const detach = attachTerminalTransport(server.httpServer);
        const detachStreams = attachLiveStreams(server.httpServer);
        server.httpServer.once("close", () => { detach(); detachStreams(); });
      } else {
        void startBackend();
      }
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      void startBackend();
      const detach = attachTerminalTransport(server.httpServer);
      const detachStreams = attachLiveStreams(server.httpServer);
      server.httpServer.once("close", () => { detach(); detachStreams(); });
      server.middlewares.use(middleware);
    },
    // Called once per Vite environment; the calls share one store close. Vite
    // discards a failed hook, so the failure is reported instead.
    async closeBundle() {
      await stopBackend().catch((error: unknown) => recordDiagnosticEvent({
        area: "gateway", level: "error", action: "stop_failed",
        summary: "The development backend did not stop cleanly",
        detail: error instanceof Error ? error.message : String(error),
      }));
    },
  };
}
