import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import vm from "node:vm";
import fixture from "./widget-sandbox.fixture.json";
import { WIDGET_SANDBOX_HTML, WIDGET_SANDBOX_METHOD_PREFIX, WIDGET_SANDBOX_PATH, widgetContentSecurityPolicy, widgetSandboxHeaders } from "./widget-sandbox.ts";

/** The text between the first `open` and the next `close`. */
const between = (text: string, open: string, close: string) => {
  const start = text.indexOf(open) + open.length;
  return start < open.length ? "" : text.slice(start, text.indexOf(close, start));
};

const directives = (policy: string) => new Map(policy.split(";").map((part) => part.trim().split(/\s+/u)).map(([name, ...values]) => [name!, values]));

test("the widget policy allows no connection, no frame and only pinned CDNs", () => {
  const policy = directives(widgetContentSecurityPolicy());
  assert.deepEqual(policy.get("default-src"), ["'none'"]);
  assert.deepEqual(policy.get("connect-src"), ["'none'"]);
  assert.deepEqual(policy.get("img-src"), ["data:", "blob:"]);
  assert.deepEqual(policy.get("media-src"), ["data:", "blob:"]);
  for (const name of ["frame-src", "worker-src", "object-src", "base-uri", "form-action"]) assert.deepEqual(policy.get(name), ["'none'"], name);
  assert.deepEqual(policy.get("script-src"), ["'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://esm.sh", "https://unpkg.com"]);
  for (const [name, values] of policy) {
    assert(!values.includes("'self'") && !values.includes("'unsafe-eval'") && !values.includes("*"), name);
    assert(values.every((value) => !value.startsWith("http:")), name);
  }
  // Only a header can name embedders or force the sandbox; a meta tag would ignore them.
  assert(!policy.has("frame-ancestors") && !policy.has("sandbox"));
});

test("the sandbox page's header policy forces an opaque origin and only HUI may embed it", () => {
  const headers = widgetSandboxHeaders();
  const policy = directives(headers["content-security-policy"]!);
  assert.deepEqual(policy.get("frame-ancestors"), ["'self'"]);
  assert.deepEqual(policy.get("sandbox"), ["allow-scripts", "allow-forms"]);
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["cache-control"], "no-store");
  assert.match(headers["permissions-policy"]!, /camera=\(\), microphone=\(\)/u);
  assert.doesNotMatch(WIDGET_SANDBOX_HTML, /allow-same-origin|allow-popups|allow-top-navigation/u);
});

test("the sandbox page script refuses to run top-level or with a readable parent", () => {
  const script = between(WIDGET_SANDBOX_HTML, "<script>", "</script>");
  new vm.Script(script);
  assert.match(script, /if \(window\.top === window\) return;/u);
  assert.match(script, /void window\.parent\.document;\s*return;/u);
  assert.match(script, /host = referrer\.origin;/u);
  assert.match(script, /next\.setAttribute\("sandbox", "allow-scripts allow-forms"\)/u);
  assert.match(script, /data\?\.method === "ui\/open-link" && \(document\.activeElement !== inner \|\| !activated\(\)\)/u);
});

test("the gateway serves the sandbox page without x-hui and keeps every other route guarded", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-widget-sandbox-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  await mkdir(join(dir, "hui"));
  const { middleware } = await import("../hui.ts");
  const { stopBackend } = await import("../backend.ts");
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404).end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => { await stopBackend(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(dir, { recursive: true, force: true }); });

  const page = await fetch(origin + WIDGET_SANDBOX_PATH);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("content-security-policy"), widgetSandboxHeaders()["content-security-policy"]);
  assert.equal(await page.text(), WIDGET_SANDBOX_HTML);
  const head = await fetch(origin + WIDGET_SANDBOX_PATH, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(origin + WIDGET_SANDBOX_PATH, { method: "POST" })).status, 405);
  assert.equal((await fetch(origin + "/__hui/settings")).status, 403);
  assert.equal((await fetch(origin + WIDGET_SANDBOX_PATH + "/x")).status, 403);
});

test("the server widget policy and sandbox messages match the portable fixtures", () => {
  assert.equal(WIDGET_SANDBOX_PATH, fixture.path);
  assert.equal(WIDGET_SANDBOX_METHOD_PREFIX, fixture.methodPrefix);
  for (const { options, expected } of fixture.policies) assert.equal(widgetContentSecurityPolicy(options), expected);
});
