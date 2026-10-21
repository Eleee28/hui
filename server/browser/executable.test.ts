import assert from "node:assert/strict";
import { test } from "vitest";
import { browserCandidates, expandExecutablePath, resolveBrowserExecutable, type ExecutableProbe } from "./executable.ts";

function probe(platform: NodeJS.Platform, executables: string[], env: NodeJS.ProcessEnv = {}): ExecutableProbe {
  const present = new Set(executables);
  return { platform, env, home: platform === "win32" ? "C:\\Users\\developer" : "/home/developer", isExecutable: async (path) => present.has(path) };
}

test("a configured path is expanded, validated and never silently replaced", async () => {
  assert.deepEqual(await resolveBrowserExecutable("~/bin/chromium", probe("linux", ["/home/developer/bin/chromium"])), {
    executable: { path: "/home/developer/bin/chromium", name: "Chromium", source: "configured" },
  });
  assert.deepEqual(await resolveBrowserExecutable("chromium", probe("linux", ["/usr/bin/chromium"])), {
    executable: null, error: "The browser executable must be an absolute path.",
  });
  const missing = await resolveBrowserExecutable("/opt/none/chrome", probe("linux", ["/usr/bin/google-chrome"], { PATH: "/usr/bin" }));
  assert.equal(missing.executable, null);
  assert.match(missing.error ?? "", /\/opt\/none\/chrome/u);
  assert.equal(expandExecutablePath("/Applications/Brave Browser.app/", "/Users/d", "darwin"), "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
  assert.equal(expandExecutablePath("/Applications/Brave Browser.app", "/Users/d", "linux"), "/Applications/Brave Browser.app");
  assert.deepEqual(await resolveBrowserExecutable("C:\\Tools\\chrome.exe", probe("win32", ["C:\\Tools\\chrome.exe"])), {
    executable: { path: "C:\\Tools\\chrome.exe", name: "Google Chrome", source: "configured" },
  });
});

test("auto-detection prefers Chrome, then Brave, Edge and Chromium, searching PATH", async () => {
  const env = { PATH: "/nix/bin:/usr/bin" };
  assert.deepEqual(await resolveBrowserExecutable("", probe("linux", ["/nix/bin/brave", "/usr/bin/chromium"], env)), {
    executable: { path: "/nix/bin/brave", name: "Brave", source: "detected" },
  });
  assert.deepEqual(await resolveBrowserExecutable(" ", probe("linux", ["/usr/bin/chromium", "/usr/bin/google-chrome"], env)), {
    executable: { path: "/usr/bin/google-chrome", name: "Google Chrome", source: "detected" },
  });
  const mac = await resolveBrowserExecutable("", probe("darwin", ["/home/developer/Applications/Chromium.app/Contents/MacOS/Chromium"]));
  assert.equal(mac.executable?.name, "Chromium");
  const none = await resolveBrowserExecutable("", probe("linux", [], env));
  assert.equal(none.executable, null);
  assert.match(none.error ?? "", /No Chromium-family browser/u);
});

test("platform candidate lists cover the standard install locations", () => {
  const mac = browserCandidates("darwin", {}, "/Users/d").map((candidate) => candidate.path);
  assert.equal(mac[0], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.ok(mac.includes("/Users/d/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"));
  const windows = browserCandidates("win32", { LOCALAPPDATA: "C:\\L", PROGRAMFILES: "C:\\P" }, "C:\\U").map((candidate) => candidate.path);
  assert.deepEqual(windows.slice(0, 2), ["C:\\L\\Google\\Chrome\\Application\\chrome.exe", "C:\\P\\Google\\Chrome\\Application\\chrome.exe"]);
  assert.ok(browserCandidates("linux", {}, "/h").some((candidate) => candidate.command === "chromium"));
});
