/** Test-only Vite entrypoint. Never imported by the product or its build. */
import { createServer } from "vite";
import { fetchProviderQuota } from "../server/pi/provider-quota.ts";
import { quotaFixture } from "./fixtures/provider-quota-fixture.mjs";
import { huiConfig } from "../server/vite-plugin.ts";
import { readFile } from "node:fs/promises";

const identity = JSON.parse(process.env.HUI_VERIFICATION_IDENTITY);
const token = process.env.HUI_VERIFICATION_TOKEN;
delete process.env.HUI_VERIFICATION_IDENTITY;
delete process.env.HUI_VERIFICATION_TOKEN;

const server = await createServer({
  root: identity.checkout.root,
  configFile: false,
  envDir: false,
  cacheDir: process.env.HUI_VERIFICATION_CACHE,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
  plugins: [{
    name: "hui-visual-verification-identity",
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const quota = /^\/__hui\/providers\/(openai-codex|anthropic|opencode-go)\/accounts\/([^/]+)\/quota$/.exec(request.url ?? "");
        if (process.env.HUI_VERIFICATION_QUOTAS === "1" && quota && request.method === "GET" && request.headers["x-hui"] === "1") {
          response.setHeader("content-type", "application/json");
          response.setHeader("cache-control", "no-store");
          return response.end(JSON.stringify(await fetchProviderQuota(quota[1], "synthetic-credential", undefined, async (url) => new Response(JSON.stringify(
            String(url).endsWith("/profile") ? { account: { email_address: "alex.claude@example.com" } } : quotaFixture(quota[1], quota[2])
          )))));
        }
        // The demo recorder's stage frames HUI from HUI's own origin, since widgets refuse other ancestors.
        if (process.env.HUI_DEMO_STAGE && request.url === "/__demo/stage") {
          response.setHeader("content-type", "text/html; charset=utf-8");
          return response.end(await readFile(process.env.HUI_DEMO_STAGE));
        }
        if (request.url !== "/__verification" && request.url !== "/__verification/shutdown") return next();
        response.setHeader("content-type", "application/json");
        response.setHeader("cache-control", "no-store");
        if (request.headers["x-hui-verification"] !== token) {
          response.statusCode = 403;
          return response.end(JSON.stringify({ error: "verification token required" }));
        }
        if (request.url === "/__verification" && request.method === "GET") {
          return response.end(JSON.stringify({ ...identity, serverPid: process.pid, cwd: process.cwd() }));
        }
        if (request.url === "/__verification/shutdown" && request.method === "POST") {
          response.end(JSON.stringify({ stopping: true }));
          process.send?.({ type: "shutdown" });
          return;
        }
        response.statusCode = 405;
        response.end(JSON.stringify({ error: "method not allowed" }));
      });
    },
  }, huiConfig()],
});

let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 8_000);
  deadline.unref();
  await server.close();
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("disconnect", stop);
await server.listen();
const address = server.httpServer.address();
process.send({ type: "ready", url: `http://127.0.0.1:${address.port}` });
