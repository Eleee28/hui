import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  applyAppearance,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  TEXT_SCALE_STOPS,
  TYPEFACES,
} from "./appearance.ts";

test("keeps independent interface and chat faces", () => {
  assert.deepEqual(normalizeAppearance("geist", "lora", "125"), {
    fontUi: "geist",
    fontChat: "lora",
    textScale: 125,
  });
});

test("a missing chat face inherits the interface face; retired ids fall back to defaults", () => {
  assert.deepEqual(normalizeAppearance("lora", undefined, 100), {
    fontUi: "lora",
    fontChat: "lora",
    textScale: 100,
  });
  assert.deepEqual(normalizeAppearance("serif", "mono", 100), normalizeAppearance(undefined, undefined, 100));
});

// settings.json is hand-editable, so stale values must never reach CSS.
test("falls back on anything unrecognised", () => {
  assert.deepEqual(normalizeAppearance("comic-sans", "papyrus", "125"), {
    fontUi: DEFAULT_APPEARANCE.fontUi,
    fontChat: DEFAULT_APPEARANCE.fontChat,
    textScale: 125,
  });
  assert.deepEqual(normalizeAppearance("lora", "fraunces", "0"), {
    fontUi: "lora",
    fontChat: "fraunces",
    textScale: DEFAULT_APPEARANCE.textScale,
  });
  assert.deepEqual(normalizeAppearance(null, null, null), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance(undefined, undefined, undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance({}, [], []), DEFAULT_APPEARANCE);
});

test("accepts every declared scale stop and no others", () => {
  for (const stop of TEXT_SCALE_STOPS) {
    assert.equal(normalizeAppearance("system", "system", stop).textScale, stop);
  }
  assert.equal(normalizeAppearance("system", "system", 101).textScale, DEFAULT_APPEARANCE.textScale);
});

test("ships the complete OpenClaw font catalogue and loads every webface", () => {
  assert.deepEqual(TYPEFACES.map(({ id }) => id), [
    "instrument-sans",
    "geist",
    "dm-sans",
    "ibm-plex-sans",
    "space-grotesk",
    "atkinson-hyperlegible",
    "fraunces",
    "lora",
    "jetbrains-mono",
    "system",
  ]);
  const tokens = readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8");
  for (const face of TYPEFACES) {
    assert.ok(face.stack.length > 10, `${face.id} has no stack`);
    assert.ok(!face.stack.includes(";"), `${face.id} stack would break out of a CSS value`);
    if (face.id === "system") continue;
    const css = readFileSync(new URL(`../../../public/fonts/${face.id}.css`, import.meta.url), "utf8");
    assert.match(css, /@font-face/u, `${face.id} has no bundled face`);
    assert.ok(tokens.includes(`/fonts/${face.id}.css`), `${face.id} is not loaded`);
    const assets = [...css.matchAll(/src: url\("([^"?]+)(?:\?[^"]*)?"\)/gu)];
    assert.ok(assets.length > 0, `${face.id} declares no font assets`);
    for (const match of assets) {
      const filename = match[1];
      assert.ok(filename);
      assert.ok(readFileSync(new URL(`../../../public/fonts/${filename}`, import.meta.url)).byteLength > 0);
    }
  }
});

test("applies separate CSS stacks and serif chat smoothing", () => {
  const values = new Map<string, string>();
  const root = globalThis as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(root, "document");
  Object.defineProperty(root, "document", {
    configurable: true,
    value: {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => values.set(name, value),
          removeProperty: (name: string) => values.delete(name),
        },
      },
    },
  });
  try {
    applyAppearance({ fontUi: "geist", fontChat: "lora", textScale: 110 });
    assert.match(values.get("--font-body") ?? "", /^"Geist"/u);
    assert.match(values.get("--font-chat") ?? "", /^"Lora"/u);
    assert.equal(values.get("--chat-font-smoothing"), "auto");
    assert.equal(values.get("--control-ui-text-scale"), "1.1");

    applyAppearance({ fontUi: "system", fontChat: "dm-sans", textScale: 100 });
    assert.equal(values.has("--chat-font-smoothing"), false);
  } finally {
    if (previous) Object.defineProperty(root, "document", previous);
    else Reflect.deleteProperty(root, "document");
  }
});
