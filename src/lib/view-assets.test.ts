import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "vitest";
import { loadViewAssets, viewAssetsLoaded } from "./view-assets.ts";

test("registered view assets start together and the entry can wait for all of them", async () => {
  // Node has no document, so nothing loads: what view tests rely on.
  let called = 0;
  await loadViewAssets(async () => { called++; });
  assert.equal(called, 0);

  Reflect.set(globalThis, "document", {});
  try {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const asset = (name: string) => () => new Promise<void>((resolve) => { started.push(name); release.push(resolve); });
    loadViewAssets(asset("shell.css"), asset("tooltips"));
    loadViewAssets(asset("bots.css"));
    assert.deepEqual(started, ["shell.css", "tooltips", "bots.css"], "no load waits for another");
    let settled = false;
    const all = viewAssetsLoaded().then(() => { settled = true; });
    release.slice(0, 2).forEach((done) => done());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the entry waits for the last one");
    release[2]!();
    await all;
    assert.equal(settled, true);
  } finally {
    Reflect.deleteProperty(globalThis, "document");
  }
});

test("no module of the app's graph awaits its assets at its top level", () => {
  // A top-level await there serializes module evaluation: one round trip per view.
  for (const directory of ["../views/", "../components/"]) {
    for (const name of readdirSync(new URL(directory, import.meta.url))) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const source = readFileSync(new URL(directory + name, import.meta.url), "utf8");
      assert.doesNotMatch(source, /^(?:if \(typeof document !== "undefined"\) )?\s*\(?await import\("[^"]+\.(?:css|ts)"\)/mu, name);
    }
  }
});
