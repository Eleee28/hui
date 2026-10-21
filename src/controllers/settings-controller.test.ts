import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ReactiveController } from "lit";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../lib/settings/settings.ts";
import type { PiResourceDocument } from "../lib/pi.ts";
import { SettingsController } from "./settings-controller.ts";

type Power = NonNullable<SettingsController["power"]>;

const fake = vi.hoisted(() => ({
  settings: undefined as unknown as Settings,
  patches: [] as Array<Partial<Settings>>,
  writes: [] as Array<(saved: boolean) => void>,
  power: [] as Array<(power: unknown) => void>,
  copied: true,
}));

vi.mock("../lib/settings/settings-store.ts", () => ({
  currentSettings: () => fake.settings,
  patchSettings: (patch: Partial<Settings>) => {
    fake.patches.push(patch);
    fake.settings = { ...fake.settings, ...patch };
    return new Promise<boolean>((resolve) => fake.writes.push(resolve));
  },
}));
vi.mock("../api/control-surfaces.ts", () => ({
  loadPower: () => new Promise((resolve) => fake.power.push(resolve)),
}));
vi.mock("../api/pi.ts", () => ({
  loadPiResource: async (_kind: string, id: string): Promise<PiResourceDocument> =>
    ({ id, kind: "skill", title: "Review", fileName: "SKILL.md", format: "markdown", content: "# Review", truncated: false }),
}));
vi.mock("../lib/clipboard.ts", () => ({ writeClipboardText: async () => fake.copied }));

beforeEach(() => {
  fake.settings = DEFAULT_SETTINGS;
  fake.patches = [];
  fake.writes = [];
  fake.power = [];
  fake.copied = true;
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const controllers: ReactiveController[] = [];
  const failures: string[] = [];
  const host = {
    updates: 0,
    addController: (controller: ReactiveController) => { controllers.push(controller); },
    removeController: () => {},
    requestUpdate() { this.updates += 1; },
    updateComplete: Promise.resolve(true),
    renderRoot: { querySelector: () => null } as unknown as ParentNode,
  };
  const controller = new SettingsController(host, { piLoaded: () => {}, copyFailed: (message) => failures.push(message) });
  return { controller, host, controllers, failures };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function power(lidOn: boolean): Power {
  const off = { state: "off" as const, detail: "" };
  return { keepAwake: off, lidAwake: off, lidOn };
}

test("a save sends only its patch and renders the store's snapshot before the write lands", async () => {
  const { controller, controllers, host } = setup();
  assert.deepEqual(controllers, [controller]);
  const saving = controller.save({ branchPrefix: "dani/" });
  assert.deepEqual(fake.patches, [{ branchPrefix: "dani/" }], "never the whole settings merged with the patch");
  assert.equal(controller.settings.branchPrefix, "dani/", "the optimistic snapshot, before the write");
  assert.ok(host.updates > 0);
  fake.settings = normalizeSettings({ branchPrefix: "confirmed/" });
  fake.writes[0]!(false);
  await saving;
  assert.equal(controller.saveFailed, true);
  assert.equal(controller.settings.branchPrefix, "confirmed/", "the store's answer once the write settles");

  controller.patchOwnedSettings({ labs: { ...DEFAULT_SETTINGS.labs, detailedDebug: true } });
  assert.deepEqual(fake.patches[1], { labs: { ...DEFAULT_SETTINGS.labs, detailedDebug: true } });
});

test("only the newest save reports whether it landed", async () => {
  const { controller } = setup();
  const first = controller.save({ branchPrefix: "a/" });
  const second = controller.save({ branchPrefix: "b/" });
  fake.writes[1]!(true);
  await second;
  fake.writes[0]!(false);
  await first;
  assert.equal(controller.saveFailed, false);
});

test("the newest power read wins, and a lid turned off brings its notice back", async () => {
  const { controller } = setup();
  const older = controller.refreshPower();
  const newer = controller.refreshPower();
  fake.power[1]!(power(true));
  await newer;
  fake.power[0]!(power(false));
  await older;
  assert.equal(controller.power?.lidOn, true, "an older poll never undoes a click");
  controller.dismissPowerNotice();
  assert.equal(controller.powerNoticeDismissed, true);
  const off = controller.refreshPower();
  fake.power[2]!(power(false));
  await off;
  assert.equal(controller.powerNoticeDismissed, false);
});

test("the resource reader's Copied mark clears after 1.5 s, and closing returns the focus", async () => {
  vi.stubGlobal("window", globalThis);
  const Element = class {};
  vi.stubGlobal("HTMLElement", Element);
  const focused: string[] = [];
  const trigger = Object.assign(new Element(), { focus: () => focused.push("trigger") });
  vi.stubGlobal("document", { activeElement: trigger });
  const { controller, failures } = setup();
  controller.readPiResource("skill", { id: "review", name: "Review" });
  assert.deepEqual(controller.piResourceReader, { title: "Review", status: "loading" });
  await settle();
  assert.equal(controller.piResourceReader?.status, "ready");

  vi.useFakeTimers();
  controller.copyPiResource();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(controller.piResourceReader?.copied, true);
  await vi.advanceTimersByTimeAsync(1_499);
  assert.equal(controller.piResourceReader?.copied, true);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(controller.piResourceReader?.copied, false);

  fake.copied = false;
  controller.copyPiResource();
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(failures, ["Could not copy the resource to the clipboard."]);

  controller.closePiResourceReader();
  assert.equal(controller.piResourceReader, undefined);
  assert.deepEqual(focused, ["trigger"]);
});
