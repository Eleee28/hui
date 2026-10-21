import assert from "node:assert/strict";
import { test } from "vitest";
import { createFileLinkResolver, type ResolveTransport } from "./file-link-store.ts";
import type { FilesResolve } from "../../api/schema/files.ts";

function fakeGateway(existing: Record<string, Record<string, "file" | "directory">>, unavailable = new Set<string>()) {
  const calls: { sessionId: string; paths: string[] }[] = [];
  const transport: ResolveTransport = async (sessionId, paths) => {
    calls.push({ sessionId, paths });
    if (unavailable.has(sessionId)) return "unavailable";
    const files = existing[sessionId] ?? {};
    return { entries: paths.map((path) => files[path] ? { path: path.replace(/^\.\//u, "").replace(/\/$/u, ""), kind: files[path]! } : null) } satisfies FilesResolve;
  };
  return { calls, transport };
}

test("asks made in one task share one request per conversation, and answers are then read synchronously", async () => {
  const gateway = fakeGateway({ a: { "src/x.ts": "file", "docs/": "directory" }, b: { "README.md": "file" } });
  const resolver = createFileLinkResolver(gateway.transport);
  const answers = await Promise.all([
    resolver.resolve("a", "src/x.ts"),
    resolver.resolve("a", "missing.ts"),
    resolver.resolve("a", "src/x.ts"),
    resolver.resolve("a", "docs/"),
    resolver.resolve("b", "README.md"),
  ]);
  assert.deepEqual(answers, [{ path: "src/x.ts", kind: "file" }, null, { path: "src/x.ts", kind: "file" }, { path: "docs", kind: "directory" }, { path: "README.md", kind: "file" }]);
  assert.deepEqual(gateway.calls, [{ sessionId: "a", paths: ["src/x.ts", "missing.ts", "docs/"] }, { sessionId: "b", paths: ["README.md"] }]);
  assert.deepEqual(resolver.lookup("a", "src/x.ts"), { path: "src/x.ts", kind: "file" });
  assert.equal(resolver.lookup("a", "missing.ts"), null);
  assert.equal(resolver.lookup("a", "never-asked.ts"), undefined);
  await resolver.resolve("a", "src/x.ts");
  assert.equal(gateway.calls.length, 2, "a cached answer is not asked again");
});

test("missing answers are forgotten on request; found ones stay", async () => {
  const files: Record<string, "file" | "directory"> = {};
  const gateway = fakeGateway({ a: files });
  const resolver = createFileLinkResolver(gateway.transport);
  assert.equal(await resolver.resolve("a", "new.ts"), null);
  files["new.ts"] = "file";
  files["old.ts"] = "file";
  assert.deepEqual(await resolver.resolve("a", "old.ts"), { path: "old.ts", kind: "file" });
  assert.equal(await resolver.resolve("a", "new.ts"), null, "still cached");
  resolver.forgetMissing("a");
  assert.equal(resolver.lookup("a", "new.ts"), undefined);
  assert.deepEqual(resolver.lookup("a", "old.ts"), { path: "old.ts", kind: "file" });
  assert.deepEqual(await resolver.resolve("a", "new.ts"), { path: "new.ts", kind: "file" });
});

test("a conversation without Files answers null for every path without asking again; a failed request is not cached", async () => {
  const gateway = fakeGateway({}, new Set(["remote"]));
  const resolver = createFileLinkResolver(gateway.transport);
  assert.equal(await resolver.resolve("remote", "src/x.ts"), null);
  assert.equal(resolver.lookup("remote", "other.ts"), null);
  assert.equal(await resolver.resolve("remote", "other.ts"), null);
  assert.equal(gateway.calls.length, 1);

  let fail = true;
  const flaky = createFileLinkResolver(async (_sessionId, paths) => {
    if (fail) throw new Error("offline");
    return { entries: paths.map((path) => ({ path, kind: "file" as const })) };
  });
  assert.equal(await flaky.resolve("a", "src/x.ts"), null);
  assert.equal(flaky.lookup("a", "src/x.ts"), undefined);
  fail = false;
  assert.deepEqual(await flaky.resolve("a", "src/x.ts"), { path: "src/x.ts", kind: "file" });
});

test("a large render is split into requests the gateway accepts", async () => {
  const gateway = fakeGateway({ a: {} });
  const resolver = createFileLinkResolver(gateway.transport);
  await Promise.all(Array.from({ length: 105 }, (_, index) => resolver.resolve("a", `f${index}.ts`)));
  assert.deepEqual(gateway.calls.map((call) => call.paths.length), [100, 5]);
});
