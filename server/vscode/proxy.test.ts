import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { readObservability } from "../observability.ts";
import { waitFor } from "../test-support/wait-for.ts";
import { VscodeService } from "./vscode.ts";
import { defaultVscodeProbe } from "./providers.ts";
import {
  attachVscodeTransport, downstreamHeaders, isVscodeProxyPath, isWorkbenchPath, patchWorkbenchHtml, proxyVscodeHttp, scopeVscodeCookie,
  serveVscodeEnter, upstreamHeaders, vscodeCookieSessionIds, vscodeThemeDefaults,
} from "./proxy.ts";
import { DEFAULT_VSCODE_SETTINGS } from "../hui-settings.ts";
import { normalizeVscodeTheme, vscodeContrast } from "./contract.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-vscode-server.mjs", import.meta.url));
const DARK = { background: "#101114", panel: "#17181c", elevated: "#202127", text: "#e6e6e6", border: "#2a2b31", accent: "#ff5c5c" };
const LIGHT = { background: "#fbfaf8", panel: "#f3f1ec", elevated: "#ffffff", text: "#403c35" };

test("only paths under the base path are proxied, never HUI's enter route", () => {
  assert.equal(isVscodeProxyPath("/__hui/vscode/"), true);
  assert.equal(isVscodeProxyPath("/__hui/vscode"), true);
  assert.equal(isVscodeProxyPath("/__hui/vscode/oss-dev/static/out/vs/code/browser/workbench/workbench.js"), true);
  assert.equal(isVscodeProxyPath("/__hui/vscode/enter"), false);
  assert.equal(isVscodeProxyPath("/__hui/vscode-server"), false);
  assert.equal(isVscodeProxyPath("/__hui/vscodex/"), false);
  assert.equal(isVscodeProxyPath("/__hui/sessions"), false);
});

test("upstream headers keep Host, drop HUI's cookie and forwarding headers, and carry the real token", () => {
  const headers = upstreamHeaders({
    host: "gateway.tail:7777", accept: "text/html", "accept-encoding": "gzip, br", "x-hui": "1", connection: "keep-alive",
    "x-forwarded-host": "evil.example", "x-forwarded-prefix": "/elsewhere", "x-original-host": "evil.example",
    cookie: "hui-vscode=secret1; vscode-tkn=forged; theme=dark; hui-vscode=secret2",
  }, "TOKEN");
  assert.deepEqual(headers, { host: "gateway.tail:7777", accept: "text/html", "accept-encoding": "gzip, br", cookie: "theme=dark; vscode-tkn=TOKEN" });
  assert.equal(upstreamHeaders({ "accept-encoding": "gzip" }, "T", { identity: true })["accept-encoding"], undefined);
  const upgrade = upstreamHeaders({ upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "k" }, "T", { upgrade: true });
  assert.equal(upgrade["connection"], "Upgrade");
  assert.equal(upgrade["upgrade"], "websocket");
  assert.equal(upgrade["sec-websocket-key"], "k");
  assert.deepEqual(vscodeCookieSessionIds("a=1; hui-vscode=one;hui-vscode=two; hui-vscode="), ["one", "two"]);
});

test("VS Code's token cookie never reaches the browser; its other cookies keep to the base path", () => {
  assert.deepEqual(downstreamHeaders({
    "content-type": "text/html", connection: "keep-alive", "transfer-encoding": "chunked",
    "set-cookie": ["vscode-tkn=TOKEN; Max-Age=604800; SameSite=Lax", "vscode.nls.locale=en; Path=/"],
  }), { "content-type": "text/html", "set-cookie": ["vscode.nls.locale=en; Path=/__hui/vscode"] });
  assert.deepEqual(downstreamHeaders({ "set-cookie": ["vscode-tkn=T"] }), {});
  // serve-web's secret-storage cookies, as VS Code 1.137 sets them.
  assert.equal(scopeVscodeCookie("vscode-secret-key-path=/__hui/vscode/_vscode-cli/mint-key; SameSite=Strict; Path=/"),
    "vscode-secret-key-path=/__hui/vscode/_vscode-cli/mint-key; SameSite=Strict; Path=/__hui/vscode");
  assert.equal(scopeVscodeCookie("vscode-cli-secret-half=x; SameSite=Strict; HttpOnly; Max-Age=2592000; path=/"),
    "vscode-cli-secret-half=x; SameSite=Strict; HttpOnly; Max-Age=2592000; Path=/__hui/vscode");
  assert.equal(scopeVscodeCookie("a=1; Path=/__hui/vscode/stable-x"), "a=1; Path=/__hui/vscode/stable-x", "a path inside stays");
  assert.equal(scopeVscodeCookie("a=1"), "a=1; Path=/__hui/vscode");
});

function workbench(settings: Record<string, unknown>): string {
  return `<html><head><meta id="vscode-workbench-web-configuration" data-settings="${JSON.stringify(settings).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></head></html>`;
}
function configOf(html: string | undefined): Record<string, any> {
  assert.ok(html !== undefined, "the page was patched");
  const raw = /id="vscode-workbench-web-configuration" data-settings="([^"]*)"/u.exec(html)?.[1] ?? "";
  return JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&")) as Record<string, any>;
}

test("the workbench page gains the token, quiet defaults and HUI's theme without losing its own settings", () => {
  const patched = configOf(patchWorkbenchHtml(workbench({
    remoteAuthority: "gateway:1", serverBasePath: "/__hui/vscode", enableWorkspaceTrust: true,
    configurationDefaults: { "editor.fontSize": 13, "a&b": "\"q\"" },
  }), { token: "TOKEN", theme: DARK }));
  assert.equal(patched["connectionToken"], "TOKEN");
  assert.equal(patched["remoteAuthority"], "gateway:1");
  assert.equal(patched["enableWorkspaceTrust"], false);
  const defaults = patched["configurationDefaults"];
  assert.equal(defaults["editor.fontSize"], 13);
  assert.equal(defaults["a&b"], "\"q\"", "escaping round-trips");
  assert.equal(defaults["security.workspace.trust.enabled"], false);
  assert.equal(defaults["workbench.startupEditor"], "none");
  assert.equal(defaults["workbench.colorTheme"], "Default Dark Modern");
  assert.equal(defaults["workbench.colorCustomizations"]["editor.background"], "#101114");
  assert.equal(defaults["workbench.colorCustomizations"]["focusBorder"], "#ff5c5c");
  assert.equal(vscodeThemeDefaults(LIGHT).colorTheme, "Default Light Modern");
  assert.equal(vscodeThemeDefaults(LIGHT).colorCustomizations["sideBar.border"], undefined, "no border color, no border override");
  const plain = configOf(patchWorkbenchHtml(workbench({ remoteAuthority: "g" }), { token: "T" }));
  assert.equal(plain["connectionToken"], "T");
  assert.equal(plain["configurationDefaults"]["workbench.colorTheme"], undefined, "no theme, VS Code's own default");
  assert.equal(patchWorkbenchHtml("<html>no config</html>", { token: "T" }), undefined, "nothing to put the token in");
  assert.equal(patchWorkbenchHtml('<meta id="vscode-workbench-web-configuration" data-settings="{not json">', { token: "T" }), undefined);
  assert.equal(patchWorkbenchHtml('<meta id="vscode-workbench-web-configuration" data-settings="[1]">', { token: "T" }), undefined);
  assert.equal(patchWorkbenchHtml('<meta id="vscode-workbench-web-configuration">', { token: "T" }), undefined);
});

test("a theme whose text cannot be read on its surfaces is refused, so VS Code keeps its own", () => {
  assert.deepEqual(normalizeVscodeTheme(LIGHT), LIGHT);
  assert.deepEqual(normalizeVscodeTheme(DARK), DARK);
  // What a client that could not read HUI's light-dark() tokens sent: black for every color.
  assert.equal(normalizeVscodeTheme({ background: "#000000", panel: "#000000", elevated: "#000000", text: "#000000", border: "#000000" }), undefined);
  assert.equal(normalizeVscodeTheme({ ...LIGHT, panel: "#3f3b34" }), undefined, "text on a panel");
  assert.equal(normalizeVscodeTheme({ ...LIGHT, border: "url(x)" })?.border, undefined, "anything but #rrggbb is dropped");
  assert.equal(Math.round(vscodeContrast("#000000", "#ffffff")), 21);
  assert.equal(vscodeContrast("#123456", "#123456"), 1);
});

const FIXTURES = ["1.137", "1.141"] as const;

test("VS Code 1.137's and 1.141's real serve-web pages get the token, and nothing else in them changes", async () => {
  for (const version of FIXTURES) {
    const page = await readFile(fileURLToPath(new URL(`../test-support/vscode-workbench-${version}.html`, import.meta.url)), "utf8");
    const patched = patchWorkbenchHtml(page, { token: "TOKEN", theme: LIGHT });
    const config = configOf(patched);
    assert.equal(config["connectionToken"], "TOKEN", version);
    assert.equal(config["remoteAuthority"], "gateway.test:7777", version);
    assert.equal(config["serverBasePath"], "/__hui/vscode", version);
    assert.match(config["callbackRoute"], /^\/__hui\/vscode\/stable-[0-9a-f]{40}\/callback$/u, version);
    assert.equal(config["configurationDefaults"]["workbench.colorTheme"], "Default Light Modern", version);
    const outside = (html: string) => html.replace(/<meta id="vscode-workbench-web-configuration"[^>]*>/u, "");
    assert.equal(outside(patched ?? ""), outside(page), `${version}: only the configuration changes`);
    assert.match(patched ?? "", /<meta id="vscode-workbench-web-base-url" data-settings="\/__hui\/vscode\/stable-[0-9a-f]{40}\/static">/u);
  }
});

test("the configuration is found however a release writes its tag", () => {
  const json = JSON.stringify({ remoteAuthority: "g:1", note: "a > b & 'c'" });
  const variants = {
    reordered: `<meta data-settings="${json.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" id="vscode-workbench-web-configuration">`,
    selfClosing: `<meta id="vscode-workbench-web-configuration" data-settings="${json.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" />`,
    singleQuoted: `<meta id='vscode-workbench-web-configuration' data-settings='${json.replaceAll("&", "&amp;").replaceAll("'", "&#39;")}'>`,
    numericEntities: `<meta id="vscode-workbench-web-configuration" data-settings="${json.replaceAll("&", "&#38;").replaceAll('"', "&#34;").replaceAll("'", "&#x27;")}">`,
    unquotedId: `<META ID=vscode-workbench-web-configuration DATA-SETTINGS="${json.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`,
  };
  for (const [name, variant] of Object.entries(variants)) {
    const patched = patchWorkbenchHtml(`<html><head><meta id="other" data-settings="x">${variant}</head></html>`, { token: "T" });
    assert.ok(patched, name);
    const tag = [...patched.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu)].map((match) => match[0]).find((meta) => /vscode-workbench-web-configuration/iu.test(meta)) ?? "";
    const raw = /data-settings="([^"]*)"/iu.exec(tag)?.[1] ?? "";
    const config = JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&")) as Record<string, unknown>;
    assert.equal(config["connectionToken"], "T", name);
    assert.equal(config["note"], "a > b & 'c'", `${name}: the rest round-trips`);
    assert.match(patched, /<meta id="other" data-settings="x">/u, `${name}: other tags stay`);
  }
});

test("the workbench is the base path itself; other documents under it are not", () => {
  assert.equal(isWorkbenchPath("/__hui/vscode/"), true);
  assert.equal(isWorkbenchPath("/__hui/vscode"), true);
  assert.equal(isWorkbenchPath("/__hui/vscode/stable-c/static/out/vs/workbench/contrib/webview/browser/pre/index.html"), false);
});

test("serve-web's page gets the token too, and its web-extension URLs follow a TLS page's scheme", () => {
  const page = workbench({
    remoteAuthority: "gateway.tail:7777", serverBasePath: "/__hui/vscode", enableWorkspaceTrust: true,
    productConfiguration: { extensionsGallery: { resourceUrlTemplate: "http://gateway.tail:7777/__hui/vscode/stable-c/web-extension-resource/{publisher}" } },
  });
  const plain = configOf(patchWorkbenchHtml(page, { token: "TOKEN" }));
  assert.equal(plain["connectionToken"], "TOKEN", "VS Code would otherwise read it from the vscode-tkn cookie, which the browser never gets");
  assert.equal(plain["enableWorkspaceTrust"], false);
  assert.equal(plain["productConfiguration"]["extensionsGallery"]["resourceUrlTemplate"], "http://gateway.tail:7777/__hui/vscode/stable-c/web-extension-resource/{publisher}");
  const secure = configOf(patchWorkbenchHtml(page, { token: "TOKEN", secure: true }));
  assert.equal(secure["productConfiguration"]["extensionsGallery"]["resourceUrlTemplate"], "https://gateway.tail:7777/__hui/vscode/stable-c/web-extension-resource/{publisher}");
});

type Harness = { origin: string; vscode: VscodeService; server: Server; dir: string };

async function harness(t: TestContext, kind: "server" | "code" = "server", fakeEnv: Record<string, string> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-proxy-"));
  const executable = join(dir, kind === "code" ? "code" : "openvscode-server");
  await writeFile(executable, `#!/bin/sh\n${kind === "code" ? "FAKE_VSCODE_KIND=code " : ""}"${process.execPath}" "${FAKE}" "$@"\n`);
  await chmod(executable, 0o755);
  const base = defaultVscodeProbe();
  const vscode = new VscodeService({
    dir: join(dir, "state"), readyTimeoutMs: 15_000,
    settings: async () => ({ ...DEFAULT_VSCODE_SETTINGS, ...(kind === "code" ? { licenseAcceptedAt: "2026-10-09T08:00:00.000Z" } : { executable }) }),
    // Only this test's executables exist, so the machine's own VS Code never answers.
    probe: { ...base, env: { PATH: dir }, home: dir, isExecutable: async (path) => path.startsWith(`${dir}/`) && base.isExecutable(path) },
    env: () => ({ ...process.env, ...(kind === "code" ? { FAKE_VSCODE_KIND: "code" } : {}), ...fakeEnv }),
  });
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://h").pathname;
    if (path === "/__hui/vscode/enter") serveVscodeEnter(request, response, vscode);
    else if (isVscodeProxyPath(path)) proxyVscodeHttp(request, response, vscode);
    else response.writeHead(404).end();
  });
  const detach = attachVscodeTransport(server, vscode);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.onTestFinished(async () => {
    detach();
    await vscode.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${address.port}`, vscode, server, dir };
}

/** connect → enter: the cookie a frame ends up with. */
async function enter(h: Harness, theme = DARK): Promise<{ cookie: string; location: string; setCookie: string }> {
  const connection = await h.vscode.connect("/work/my repo", theme);
  assert.ok("url" in connection);
  const response = await fetch(h.origin + connection.url, { redirect: "manual" });
  assert.equal(response.status, 303);
  const setCookie = response.headers.get("set-cookie") ?? "";
  return { cookie: setCookie.split(";")[0] ?? "", location: response.headers.get("location") ?? "", setCookie };
}

test("the proxy refuses frames without a valid cookie and never starts VS Code for them", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  for (const headers of [{}, { cookie: "hui-vscode=forged" }, { cookie: "vscode-tkn=guess" }] as Array<Record<string, string>>) {
    const response = await fetch(`${h.origin}/__hui/vscode/?folder=%2Fetc`, { headers });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /<meta name="hui-vscode-error" content="unauthorized"/u);
  }
  assert.equal((await h.vscode.status()).state, "stopped");
  const bad = await fetch(`${h.origin}/__hui/vscode/enter?ticket=nope`, { redirect: "manual" });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("set-cookie"), null);
  assert.match(await bad.text(), /content="expired"/u);

  const connection = await h.vscode.connect("/work", DARK);
  assert.ok("url" in connection);
  const crossSite = await fetch(h.origin + connection.url, { redirect: "manual", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403, "a ticket cannot be redeemed from another site");
});

test("enter sets a strict, HttpOnly cookie scoped to the proxy and redirects to the folder", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { setCookie, location, cookie } = await enter(h);
  assert.match(setCookie, /^hui-vscode=[\w-]{43}; Path=\/__hui\/vscode; HttpOnly; SameSite=Strict$/u);
  assert.equal(location, "/__hui/vscode/?folder=%2Fwork%2Fmy%20repo");
  const reused = await fetch(`${h.origin}/__hui/vscode/enter?ticket=${cookie}`, { redirect: "manual" });
  assert.equal(reused.status, 403);
});

test("the workbench page arrives patched, and VS Code's token cookie stays on the gateway", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { cookie, location } = await enter(h);
  const page = await fetch(h.origin + location, { headers: { cookie, accept: "text/html" } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.deepEqual(page.headers.getSetCookie(), ["vscode.other=1; Path=/__hui/vscode"]);
  const html = await page.text();
  assert.match(html, /fake workbench for \/work\/my repo/u);
  const config = configOf(html);
  assert.equal(config["connectionToken"], await readFile(h.vscode.tokenFile, "utf8"));
  assert.equal(config["remoteAuthority"], new URL(h.origin).host, "VS Code sees the browser's Host, so its WebSocket comes back through HUI");
  assert.equal(config["configurationDefaults"]["workbench.colorCustomizations"]["sideBar.background"], DARK.panel);
});

test("requests keep their path, body and method; the browser's cookie and forwarding headers do not pass", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { cookie } = await enter(h);
  const response = await fetch(`${h.origin}/__hui/vscode/echo/deep/path?x=1&y=two`, {
    method: "POST",
    body: "payload",
    headers: { cookie: `theme=1; ${cookie}; vscode-tkn=forged`, "x-forwarded-host": "evil.example", "x-forwarded-prefix": "/x" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  const echo = await response.json() as { method: string; url: string; body: string; headers: Record<string, string> };
  assert.equal(echo.method, "POST");
  assert.equal(echo.url, "/__hui/vscode/echo/deep/path?x=1&y=two");
  assert.equal(echo.body, "payload");
  assert.equal(echo.headers["cookie"], `theme=1; vscode-tkn=${await readFile(h.vscode.tokenFile, "utf8")}`);
  assert.equal(echo.headers["x-forwarded-host"], undefined);
  assert.equal(echo.headers["x-forwarded-prefix"], undefined);
  assert.equal(echo.headers["host"], new URL(h.origin).host);
  const crossSite = await fetch(`${h.origin}/__hui/vscode/echo`, { headers: { cookie, "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403, "a valid cookie does not help a cross-site request");
});

function openSocket(url: string, headers: Record<string, string>): Promise<{ socket: WebSocket; first: string } | { status: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("message", (data) => resolve({ socket, first: String(data) }));
    socket.once("unexpected-response", (_request, response: IncomingMessage) => { response.resume(); resolve({ status: response.statusCode ?? 0 }); });
    socket.once("error", reject);
  });
}

test("the WebSocket passes through for the cookie's holder from the same origin only", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { cookie } = await enter(h);
  const ws = h.origin.replace("http:", "ws:") + "/__hui/vscode/?reconnectionToken=abc&skipWebSocketFrames=false";
  assert.deepEqual(await openSocket(ws, { origin: h.origin }), { status: 403 });
  assert.deepEqual(await openSocket(ws, { origin: "http://evil.example", cookie }), { status: 403 });
  assert.deepEqual(await openSocket(ws, { origin: h.origin, cookie: "hui-vscode=forged" }), { status: 403 });
  const opened = await openSocket(ws, { origin: h.origin, cookie });
  assert.ok("socket" in opened);
  const hello = JSON.parse(opened.first) as { url: string; cookie: string };
  assert.equal(hello.url, "/__hui/vscode/?reconnectionToken=abc&skipWebSocketFrames=false");
  assert.equal(hello.cookie, `vscode-tkn=${await readFile(h.vscode.tokenFile, "utf8")}`);
  const reply = once(opened.socket, "message");
  opened.socket.send("ping");
  assert.equal(String((await reply)[0]), "echo:ping");
  assert.equal((await h.vscode.status()).connections, 1, "an open socket holds the server");
  opened.socket.close();
  await waitFor("the socket to release the server", async () => (await h.vscode.status()).connections === 0);

  // A stopped server is not restarted by its frame reconnecting; only an open from HUI starts it.
  await h.vscode.stop();
  assert.deepEqual(await openSocket(ws, { origin: h.origin, cookie }), { status: 503 });
  const page = await fetch(`${h.origin}/__hui/vscode/echo`, { headers: { cookie } });
  assert.equal(page.status, 503);
  assert.match(await page.text(), /content="stopped"/u);
  assert.equal((await h.vscode.status()).state, "stopped");
});

test("code serve-web behind the proxy: same cookie gate, the token in its page, its cookies kept to the base path", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "code");
  const { cookie, location } = await enter(h);
  assert.equal(h.vscode.current()?.flavor, "serve-web");
  const refused = await fetch(h.origin + location, { headers: { accept: "text/html" } });
  assert.equal(refused.status, 403, "no cookie, no serve-web");
  const page = await fetch(h.origin + location, { headers: { cookie, accept: "text/html" } });
  assert.equal(page.status, 200);
  assert.deepEqual(page.headers.getSetCookie(), [
    "vscode-secret-key-path=/__hui/vscode/_vscode-cli/mint-key; SameSite=Strict; Path=/__hui/vscode",
    "vscode-cli-secret-half=half; SameSite=Strict; HttpOnly; Max-Age=2592000; Path=/__hui/vscode",
  ]);
  const html = await page.text();
  assert.match(html, /fake serve-web workbench for \/work\/my repo/u, "the folder arrives as serve-web's ?folder=");
  const config = configOf(html);
  assert.equal(config["connectionToken"], await readFile(h.vscode.tokenFile, "utf8"), "its server checks the handshake's token like openvscode-server");
  assert.equal(config["remoteAuthority"], new URL(h.origin).host);
  const ws = h.origin.replace("http:", "ws:") + "/__hui/vscode/stable-x/?reconnectionToken=abc";
  const upgrade = await new Promise<{ socket: WebSocket; cookies: string[] }>((resolve, reject) => {
    const socket = new WebSocket(ws, { headers: { origin: h.origin, cookie } });
    socket.once("upgrade", (response) => resolve({ socket, cookies: ([] as string[]).concat(response.headers["set-cookie"] ?? []) }));
    socket.once("error", reject);
  });
  assert.deepEqual(upgrade.cookies, [
    "vscode-secret-key-path=/__hui/vscode/_vscode-cli/mint-key; SameSite=Strict; Path=/__hui/vscode",
    "vscode-cli-secret-half=half; SameSite=Strict; HttpOnly; Max-Age=2592000; Path=/__hui/vscode",
  ], "the upgrade's cookies are scoped like any other, and the token cookie stays on the gateway");
  upgrade.socket.close();
});

test("a workbench page HUI cannot prepare is refused with a notice and logged, never served without its token", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "code", { FAKE_VSCODE_PAGE: "bare" });
  const { cookie, location } = await enter(h);
  const page = await fetch(h.origin + location, { headers: { cookie, accept: "text/html" } });
  assert.equal(page.status, 502);
  const html = await page.text();
  assert.match(html, /<meta name="hui-vscode-error" content="incompatible"/u, "the view replaces it with its own error");
  assert.match(html, /Visual Studio Code 1\.137\.0 served a workbench page HUI could not prepare \(it has no workbench configuration\)/u);
  assert.doesNotMatch(html, /fake serve-web workbench/u);
  const logged = (await readObservability([])).logs.find((entry) => entry.action === "vscode-workbench");
  assert.ok(logged, "the gateway log says why");
  assert.equal(logged.level, "error");
  assert.match(logged.detail ?? "", /page starts: fake serve-web workbench for \/work\/my repo/u);
  assert.doesNotMatch(logged.detail ?? "", new RegExp(await readFile(h.vscode.tokenFile, "utf8")));
  // Any other document under the base path (a webview's) is VS Code's business and passes as it is.
  const webview = await fetch(`${h.origin}/__hui/vscode/webview/index.html`, { headers: { cookie, accept: "text/html" } });
  assert.equal(webview.status, 200);
  assert.match(await webview.text(), /webview host/u);
});

test("a compressed workbench page is decoded and patched", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "server", { FAKE_VSCODE_PAGE: "gzip" });
  const { cookie, location } = await enter(h);
  const page = await fetch(h.origin + location, { headers: { cookie, accept: "text/html" } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-encoding"), null);
  assert.equal(configOf(await page.text())["connectionToken"], await readFile(h.vscode.tokenFile, "utf8"));
});

test("a refused WebSocket is logged with its cause", { timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  await enter(h);
  const ws = h.origin.replace("http:", "ws:") + "/__hui/vscode/?reconnectionToken=abc";
  assert.deepEqual(await openSocket(ws, { origin: "http://evil.example" }), { status: 403 });
  await waitFor("the refusal in the log", async () => (await readObservability([])).logs.some((entry) => entry.action === "vscode-socket" && /origin is not this gateway's/u.test(entry.summary) && /evil\.example/u.test(entry.detail ?? "")));
});
