import assert from "node:assert/strict";
import { test } from "vitest";

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allowedHostsFromConfig, allowedHostsFromEnv, HostArgumentError, parseHost, tailnetFromStatus, wantsTailnet } from "./host.ts";

test("no --host leaves the server on loopback", () => {
  assert.equal(parseHost(["gateway"]), undefined);
  assert.equal(parseHost(["gateway", "--system"]), undefined);
});

test("--host takes the next argument as the address", () => {
  assert.deepEqual(parseHost(["gateway", "--host", "100.100.100.100"]), { host: "100.100.100.100" });
});

test("--host tailnet is a marker, not an address", () => {
  const argument = parseHost(["gateway", "--host", "tailnet"]);
  assert.equal(wantsTailnet(argument), true);
  assert.equal(wantsTailnet(parseHost(["gateway", "--host", "100.100.100.100"])), false);
  assert.equal(wantsTailnet(undefined), false);
});

test("a bare --host is refused instead of binding every interface", () => {
  // Vite treats `host: true` as all interfaces, which would put agent control on
  // the LAN; the flag must be explicit about where it is opening.
  assert.throws(() => parseHost(["gateway", "--host"]), HostArgumentError);
  assert.throws(() => parseHost(["gateway", "--host", "--system"]), HostArgumentError);
});

const STATUS = JSON.stringify({
  Self: { TailscaleIPs: ["100.100.100.100", "fd7a:115c:a1e0::1"], DNSName: "hui-host.example.ts.net." },
});

test("the tailnet binding takes the IPv4 address and the name Vite must allow", () => {
  assert.deepEqual(tailnetFromStatus(STATUS), {
    host: "100.100.100.100",
    allowedHosts: ["hui-host.example.ts.net"],
  });
});

test("an IPv6-only tailnet still binds, without inventing an allowed host", () => {
  const binding = tailnetFromStatus(
    JSON.stringify({ Self: { TailscaleIPs: ["fd7a:115c:a1e0::1d2a:4b6b"] } }),
  );
  assert.equal(binding, undefined, "no IPv4 address means the caller must fall back");
});

test("unusable tailscale output yields no binding rather than a guess", () => {
  assert.equal(tailnetFromStatus("not json"), undefined);
  assert.equal(tailnetFromStatus(JSON.stringify({})), undefined);
  assert.equal(tailnetFromStatus(JSON.stringify({ Self: { TailscaleIPs: "nope" } })), undefined);
});

test("extra allowed hosts come from the environment", () => {
  assert.deepEqual(allowedHostsFromEnv({}), []);
  assert.deepEqual(allowedHostsFromEnv({ HUI_GATEWAY_ALLOWED_HOSTS: " , " }), []);
  assert.deepEqual(allowedHostsFromEnv({ HUI_GATEWAY_ALLOWED_HOSTS: "laptop.example.ts.net" }), ["laptop.example.ts.net"]);
  // Names are compared lowercased, and a trailing dot is the same name.
  assert.deepEqual(
    allowedHostsFromEnv({ HUI_GATEWAY_ALLOWED_HOSTS: " Laptop.Example.ts.net. , laptop ,100.64.0.10, " }),
    ["laptop.example.ts.net", "laptop", "100.64.0.10"],
  );
});

test("an unusable allowed host is refused rather than silently ignored", () => {
  for (const value of ["*", "localhost:4173", "http://laptop", "laptop/", "_hui", "-hui"]) {
    assert.throws(() => allowedHostsFromEnv({ HUI_GATEWAY_ALLOWED_HOSTS: value }), /is not a host name/u, value);
  }
});

test("config.json grants names on every start, resolving tailnet when Tailscale is up", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "hui-host-")), "config.json");
  assert.deepEqual(await allowedHostsFromConfig(file, async () => "x"), []);
  await writeFile(file, JSON.stringify({ format: 1, allowHosts: ["tailnet", "Proxy.Example.TS.NET."] }));
  assert.deepEqual(await allowedHostsFromConfig(file, async () => "mac.example.ts.net"), ["mac.example.ts.net", "proxy.example.ts.net"]);
  assert.deepEqual(await allowedHostsFromConfig(file, async () => undefined), ["proxy.example.ts.net"]);
  await writeFile(file, JSON.stringify({ allowHosts: ["https://bad"] }));
  await assert.rejects(allowedHostsFromConfig(file, async () => undefined), /not a host name/);
  await writeFile(file, JSON.stringify({ allowHosts: "tailnet" }));
  await assert.rejects(allowedHostsFromConfig(file, async () => undefined), /list of host names/);
  await writeFile(file, "{");
  await assert.rejects(allowedHostsFromConfig(file, async () => undefined), /not valid JSON/);
});
