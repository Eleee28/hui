import assert from "node:assert/strict";
import { expectTypeOf, test } from "vitest";
import { PiMutationKind, PiMutationResult, type PiSnapshot } from "../api/pi.ts";
import { expectSchema } from "../test-support/api-schema.ts";

type OriginalPiMutationKind = "package-install" | "package-remove" | "skill-install";

type OriginalPiMutationResult = {
  kind: OriginalPiMutationKind;
  target: string;
  message: string;
  snapshot: PiSnapshot;
};

expectTypeOf<PiMutationKind>().toEqualTypeOf<OriginalPiMutationKind>();
expectTypeOf<PiMutationResult>().toEqualTypeOf<OriginalPiMutationResult>();

import {
  packageSourceFromCatalogUrl,
  PiMutationBusyError,
  PiMutationCommandError,
  PiMutationInputError,
  PiMutationService,
  selectCheapModel,
  validateSkillUrl,
  type PiCommandResult,
} from "./mutations.ts";

function snapshot(overrides: Partial<PiSnapshot> = {}): PiSnapshot {
  return {
    agentDir: "/tmp/pi-agent",
    settings: { path: "/tmp/pi-agent/settings.json", exists: true, packages: [], extensions: [], resources: [], skillRoots: [] },
    skills: [],
    tools: [],
    model: {
      defaultProvider: "anthropic",
      defaultModel: "claude-opus",
      thinking: "medium",
      enabled: [],
      authenticated: ["anthropic", "google"],
      catalog: [],
    },
    diagnostics: [],
    ...overrides,
  };
}

test("pi.dev catalog URLs become exact npm sources", () => {
  assert.equal(packageSourceFromCatalogUrl("https://pi.dev/packages/pi-mcp-adapter"), "npm:pi-mcp-adapter");
  assert.equal(packageSourceFromCatalogUrl("https://pi.dev/packages/@scope/tool"), "npm:@scope/tool");
  for (const value of [
    "http://pi.dev/packages/tool",
    "https://example.com/packages/tool",
    "https://pi.dev/packages/tool?token=secret",
    "https://pi.dev/packages/../tool",
    "https://pi.dev/packages/tool/extra",
  ]) {
    assert.throws(() => packageSourceFromCatalogUrl(value), PiMutationInputError);
  }
});

test("skill sources require clean HTTPS URLs", () => {
  assert.equal(validateSkillUrl("https://github.com/example/skill"), "https://github.com/example/skill");
  assert.throws(() => validateSkillUrl("git://github.com/example/skill"), PiMutationInputError);
  assert.throws(() => validateSkillUrl("https://user:secret@example.com/skill"), PiMutationInputError);
});

test("the installer prefers a cheap catalog model and supports an override", () => {
  const pi = snapshot({
    model: {
      ...snapshot().model,
      catalog: [
        { provider: "anthropic", id: "opus", name: "Opus" },
        { provider: "google", id: "flash-lite", name: "Flash Lite" },
      ],
    },
  });
  assert.equal(selectCheapModel(pi, ""), "google/flash-lite");
  assert.equal(selectCheapModel(pi, "custom/cheap"), "custom/cheap");
  assert.equal(selectCheapModel(snapshot(), ""), undefined);
});

test("package install and removal call PI and return refreshed snapshots", async () => {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const pi = snapshot();
  const service = new PiMutationService({
    agentDir: "/tmp/pi-agent",
    run: async (args): Promise<PiCommandResult> => {
      mutableCalls.push([...args]);
      return { code: 0, output: "ok" };
    },
    readSnapshot: async () => pi,
    readPackageSources: async () => ["npm:@scope/tool"],
  });

  const installed = await service.installPackage("https://pi.dev/packages/@scope/tool");
  expectSchema(PiMutationResult, installed);
  assert.equal(installed.message, "Installed @scope/tool.");
  const removed = await service.removePackage("@scope/tool");
  expectSchema(PiMutationResult, removed);
  assert.equal(removed.message, "Removed @scope/tool.");
  assert.deepEqual(calls, [["install", "npm:@scope/tool"], ["remove", "npm:@scope/tool"]]);
});

test("package removal resolves only an exact current redacted label", async () => {
  const service = new PiMutationService({
    agentDir: "/tmp/pi-agent",
    run: async () => ({ code: 0, output: "" }),
    readSnapshot: async () => snapshot(),
    readPackageSources: async () => ["npm:one", "npm:two"],
  });
  await assert.rejects(service.removePackage("missing"), PiMutationInputError);
});

test("skill installation is reported only after PI discovers a new skill", async () => {
  let reads = 0;
  const argsSeen: string[][] = [];
  const service = new PiMutationService({
    agentDir: "/tmp/pi-agent",
    cheapModel: "google/flash-lite",
    run: async (args) => {
      argsSeen.push([...args]);
      return { code: 0, output: "OK: installed" };
    },
    readSnapshot: async () => reads++ === 0
      ? snapshot()
      : snapshot({ skills: [{ id: "0123456789abcdef01234567", name: "demo", description: "", path: "/tmp/pi-agent/skills/demo/SKILL.md", root: "/tmp/pi-agent/skills" }] }),
    readPackageSources: async () => [],
  });
  const result = await service.installSkill("https://github.com/example/demo");
  assert.equal(result.message, "Installed demo.");
  assert.ok(argsSeen[0]?.includes("google/flash-lite"));
  assert.ok(argsSeen[0]?.includes("minimal"));
  assert.ok(argsSeen[0]?.some((arg) => arg.includes("https://github.com/example/demo")));
});

test("a successful agent process without a discovered skill is an error", async () => {
  const service = new PiMutationService({
    agentDir: "/tmp/pi-agent",
    cheapModel: "google/flash-lite",
    run: async () => ({ code: 0, output: "OK" }),
    readSnapshot: async () => snapshot(),
    readPackageSources: async () => [],
  });
  await assert.rejects(
    service.installSkill("https://github.com/example/demo"),
    PiMutationCommandError,
  );
});

test("PI mutations are serialized", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const service = new PiMutationService({
    agentDir: "/tmp/pi-agent",
    run: async () => {
      await pending;
      return { code: 0, output: "" };
    },
    readSnapshot: async () => snapshot(),
    readPackageSources: async () => [],
  });
  const first = service.installPackage("https://pi.dev/packages/one");
  await assert.rejects(service.installPackage("https://pi.dev/packages/two"), PiMutationBusyError);
  release();
  await first;
});
