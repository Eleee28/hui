/** Read-only, loopback-only upstream stylesheet oracle for visual diagnostics.
 * Usage: node e2e/fixtures/reference-style-server.mjs /path/to/openclaw-source /path/to/control-ui
 * This does not emulate an OpenClaw Gateway or claim upstream DOM equivalence. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

const [source, assets, portArgument = "43128"] = process.argv.slice(2);
if (!source || !assets) throw new Error("Provide the pinned source checkout and installed Control UI asset directory");
const port = Number(portArgument);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid loopback port");
const styles = resolve(source, "ui/src/styles");
const shipped = resolve(assets);
const sheets = [
  "base", "layout", "layout.mobile", "components", "settings-controls", "select-picker",
  "settings", "config", "sessions", "plugins", "profile", "about",
  "logs", "activity", "usage", "cron", "new-session", "session-menu", "session-menu-compact",
  ...["startup-layout", "layout", "message-layout", "text", "grouped", "tool-cards", "attachments", "progress-card", "question-card", "composer-surface", "composer", "composer-queue", "composer-status", "composer-progress", "sidebar", "split-view"].map((name) => `chat/${name}`),
];
// Missing source files must fail startup, never silently produce false diffs.
await Promise.all(sheets.map((name) => readFile(resolve(styles, `${name}.css`))));
const entry = sheets.map((name) => `@import url('/source/${name}.css');`).join("\n")
  + "\n@import url('/fonts/instrument-sans.css');\n@import url('/fonts/jetbrains-mono.css');\n";
createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const origin = request.headers.origin;
  if (origin && /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin)) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("cache-control", "no-store");
  try {
    const presentationModules = {
      "/assets/hui-original-hovercard-audit.js": {
        file: "session-progress-hovercard.runtime-BEfDEbci.js",
        sha256: "762e7cb4519402fb297e29039af495181c168e552948b9fc5eecb36414341ee4",
        exports: "export { He as auditHovercard, R as auditInit };",
      },
      "/assets/hui-original-sidebar-audit.js": {
        file: "control-ui-boot-shared-DpHhsTHW.js",
        sha256: "97c7352c2b8d85584ec3ba0cc28b01560b9d2f46457bf04dfb3e54830621eb7a",
        exports: "export { og as auditRecentSession, Lb as auditCodeDisclosure, Rb as auditCodeOverflow }; export function auditInit() { ug(); }",
      },
      "/assets/hui-original-theme-audit.js": {
        file: "config-page-BhM2MyN4.js",
        sha256: "296129dac5f27a37f2044b31fc3ad770fbe18c0c07fd51c6fe05765e8968aaa9",
        exports: "export { ma as auditThemeMode };",
      },
      "/assets/hui-original-accent-audit.js": {
        file: "control-ui-core-C5mtYcym.js",
        sha256: "a2f2f9f5b67990b8bf03a82b33f621538a2c3e29c07f38fa53e5262dee47007c",
        exports: "export { Ph as auditAccentInk, Lh as auditApplyAccent };",
      },
    };
    const presentation = presentationModules[path];
    if (presentation) {
      const original = await readFile(resolve(shipped, "assets", presentation.file));
      if (createHash("sha256").update(original).digest("hex") !== presentation.sha256) {
        throw new Error("The audited OpenClaw presentation module changed");
      }
      response.setHeader("content-type", "text/javascript");
      return response.end(original.toString("utf8") + "\n" + presentation.exports + "\n");
    }
    if (path === "/assets/hui-original-chat-audit.js") {
      // Expose the original, otherwise-private renderers for independent DOM
      // proof. No function body is rewritten; the pinned module runs only in a
      // disposable oracle frame, never in HUI or against a Gateway.
      const original = await readFile(resolve(shipped, "assets/control-ui-boot-shared-6jDbGebE.js"));
      if (createHash("sha256").update(original).digest("hex") !== "fd7013446c3acb3a71d93a3d95486936f62bc016499cc83a5368a5a983a5160f") {
        throw new Error("The audited OpenClaw module changed");
      }
      response.setHeader("content-type", "text/javascript");
      return response.end(original.toString("utf8") + "\nexport { Tj as auditComposer, xA as auditPrimaryActions, wN as auditEffort, Gy as auditObserveTextarea, qy as auditScheduleTextarea, Iy as auditMessageGroup, EO as auditMessageContextMenu, Lp as auditCompactAttachment, Iv as auditToolCard }; export function auditInit() { Ej(); TN(); } export function auditInitTranscript() { Ly(); } export function auditPrimitives() { return {html: W, nothing: B}; }\n");
    }
    if (path === "/reference.css" || path === "/reference-state.css") {
      response.setHeader("content-type", "text/css");
      return response.end(path === "/reference-state.css" ? entry.replaceAll("/source/", "/state/source/") : entry);
    }
    const stateSheet = path.startsWith("/state/source/");
    const sourceSheet = stateSheet || path.startsWith("/source/");
    const base = sourceSheet ? styles : shipped;
    const file = resolve(base, path.replace(sourceSheet ? /^\/(?:state\/)?source\// : /^\//, ""));
    if (!file.startsWith(base + sep) || !/\.(?:css|js|woff2?|png|svg)$/.test(file)) {
      response.writeHead(403); return response.end();
    }
    let body = await readFile(file);
    // Only selector state changes: every original declaration stays untouched.
    // A clone cannot simultaneously hold the host page's native focus/hover.
    if (stateSheet && file.endsWith(".css")) {
      body = Buffer.from(body.toString("utf8").replace(/:(hover|focus-visible|focus-within|focus)\b/g,
        (_, state) => `[data-reference-${state}]`));
      // HUI transports the menu as a native popover, not a WA shadow part.
      // Project only its host/menu selectors; all source declarations are intact.
      // This is an explicit transport-adapter check, not original-DOM proof.
      body = Buffer.from(body.toString("utf8")
        .replaceAll("wa-dropdown.session-menu::part(menu)", ".session-menu[popover]")
        .replaceAll("wa-dropdown.session-menu {", ".session-menu[popover] {"));
    }
    response.setHeader("content-type", file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".woff2") ? "font/woff2" : "application/octet-stream");
    response.end(body);
  } catch {
    response.writeHead(404); response.end("Reference asset not found");
  }
}).listen(port, "127.0.0.1", () => process.stdout.write(`Upstream CSS oracle: http://127.0.0.1:${port}/reference.css\n`));
