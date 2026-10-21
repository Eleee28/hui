import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  CONTRAST_RULES,
  mapTheme,
  modeTokens,
  swatchesFor,
  themeColor,
  THEME_COLOR_TOKENS,
  type ShadcnTheme,
  type ThemeTokens,
} from "./shadcn-theme.ts";
import { contrastRatio, toOklch, worstContrast, type Rgb } from "./color-contrast.ts";

/** Every rule a mode's tokens break, as "token on surfaces = ratio" lines. */
function contrastFailures(tokens: ThemeTokens): string[] {
  const failures: string[] = [];
  for (const rule of CONTRAST_RULES) {
    const color = themeColor(tokens[rule.token]);
    const surfaces = rule.on.map((token) => themeColor(tokens[token]));
    assert.ok(color, `${rule.token} is readable here: ${tokens[rule.token]}`);
    assert.ok(surfaces.every(Boolean), `${rule.on.join(", ")} are readable here`);
    const ratio = worstContrast(color, surfaces as Rgb[]);
    if (ratio < rule.ratio) failures.push(`${rule.token} on ${rule.on.join("/")} = ${ratio.toFixed(2)} < ${rule.ratio}`);
  }
  return failures;
}

const OURS: ShadcnTheme = {
  name: "Example",
  light: {
    background: "#faf9f7",
    foreground: "#151b21",
    card: "#ffffff",
    sidebar: "#f1efeb",
    "muted-foreground": "#5b6770",
    border: "#e2ded8",
    ring: "#0b6bcb",
  },
  dark: {
    background: "#0e1015",
    foreground: "#eef4f8",
    card: "#151b21",
    sidebar: "#090b0e",
    "muted-foreground": "#9fb0bd",
    border: "#232a33",
    ring: "#8bd3ff",
  },
};

/** What tweakcn.com/r/themes/<id> actually returns. */
const REGISTRY: ShadcnTheme = {
  name: "amethyst-haze",
  cssVars: {
    theme: { "font-sans": "Geist, sans-serif", radius: "0.5rem" },
    light: { background: "oklch(0.9777 0.0041 301.4256)", foreground: "oklch(0.3651 0.0325 287.0807)", card: "oklch(1 0 0)", sidebar: "oklch(0.9554 0.0082 301.3541)", "muted-foreground": "oklch(0.5288 0.0375 290.7895)", border: "oklch(0.8447 0.0226 300.1421)", ring: "oklch(0.6104 0.0767 299.7335)" },
    dark: { background: "oklch(0.2166 0.0215 292.8474)", foreground: "oklch(0.9053 0.0245 293.5570)", card: "oklch(0.2544 0.0301 292.7315)", sidebar: "oklch(0.1985 0.0200 293.6639)", "muted-foreground": "oklch(0.6974 0.0282 300.0614)", border: "oklch(0.3063 0.0359 293.3367)", ring: "oklch(0.7058 0.0777 302.0489)" },
  },
};

test("reads our own shape and a registry item the same way", () => {
  assert.equal(modeTokens(OURS, "dark")?.["--bg"], "#0e1015");
  assert.equal(modeTokens(REGISTRY, "dark")?.["--bg"], "oklch(0.2166 0.0215 292.8474)");
});

test("maps the UI vocabulary straight across", () => {
  const tokens = modeTokens(OURS, "light");
  assert.equal(tokens?.["--bg"], "#faf9f7");
  assert.equal(tokens?.["--card"], "#ffffff");
  assert.equal(tokens?.["--text"], "#151b21");
  assert.equal(tokens?.["--muted"], "#5b6770");
  assert.equal(tokens?.["--border"], "#e2ded8");
  assert.equal(tokens?.["--ring"], "#0b6bcb");
  assert.equal(tokens?.["--accent"], "#0b6bcb");
  assert.equal(tokens?.["--popover"], "#ffffff");
  assert.equal(tokens?.["--text"], "#151b21");
  assert.equal(tokens?.["--muted"], "#5b6770");
  assert.equal(tokens?.["--input"], "#e2ded8");
  assert.equal(tokens?.["--accent-subtle"], "color-mix(in srgb, var(--accent) 10%, transparent)");
});

test("always resolves the complete OpenClaw semantic color contract", () => {
  const tokens = modeTokens(OURS, "dark");
  assert.ok(tokens);
  assert.equal(THEME_COLOR_TOKENS.length, 49);
  assert.deepEqual(Object.keys(tokens).sort(), [...THEME_COLOR_TOKENS].sort());
  assert.ok(Object.values(tokens).every((value) => value.length > 0));
});

test("the default token layer defines every theme-controlled color", () => {
  const css = readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8")
    + readFileSync(new URL("../../styles/openclaw-reference/base.css", import.meta.url), "utf8");
  for (const token of THEME_COLOR_TOKENS) {
    assert.ok(css.includes(`${token}:`), `${token} must have a default`);
  }
});

test("component color roles match OpenClaw instead of collapsing into accent", () => {
  const tokens = readFileSync(new URL("../../styles/openclaw-reference/base.css", import.meta.url), "utf8");
  const workspaces = readFileSync(new URL("../../styles/openclaw-reference/components.css", import.meta.url), "utf8");
  const chat = ["composer-surface", "grouped"].map((name) => readFileSync(new URL(`../../styles/openclaw-reference/chat/${name}.css`, import.meta.url), "utf8")).join("\n");

  assert.match(tokens, /--menu-selected:\s*color-mix\(in srgb, var\(--text\) 8%, transparent\)/);
  assert.match(tokens, /--overlay-border:\s*color-mix\(in srgb, var\(--border-strong\) 64%, transparent\)/);
  assert.match(workspaces, /^\.btn\.primary\s*\{[^}]*background:\s*var\(--primary\)[^}]*color:\s*var\(--primary-foreground\)/ms);
  assert.doesNotMatch(workspaces, /^\.btn\.primary\s*\{[^}]*background:\s*var\(--accent\)/ms);
  assert.match(chat, /--chat-composer-surface:\s*var\(--popover\)/);
  assert.match(chat, /--chat-composer-hairline:\s*color-mix\(in srgb, var\(--text-strong\) 16%, transparent\)/);
  assert.doesNotMatch(chat, /--chat-composer-(?:surface|hairline):[^;]*var\(--primary\)/);
  assert.match(chat, /\.chat-group\.user \.chat-bubble\s*\{[^}]*--chat-bubble-background:\s*var\(--accent-subtle\)/s);
});

test("uses explicit shadcn component colors instead of collapsing everything into ring", () => {
  const tokens = modeTokens(
    {
      dark: {
        background: "#111111",
        foreground: "#eeeeee",
        card: "#222222",
        "card-foreground": "#dddddd",
        popover: "#333333",
        "popover-foreground": "#cccccc",
        // Readable on the background, so the contrast rules leave every explicit color in place.
        primary: "#6677cc",
        "primary-foreground": "#ffffff",
        secondary: "#292929",
        "secondary-foreground": "#fafafa",
        muted: "#252525",
        "muted-foreground": "#999999",
        accent: "#aa77ee",
        "accent-foreground": "#111111",
        destructive: "#ff6677",
        "destructive-foreground": "#111111",
        border: "#444444",
        input: "#555555",
        ring: "#bb88ff",
      },
    },
    "dark",
  );
  assert.equal(tokens?.["--card"], "#222222");
  assert.equal(tokens?.["--popover"], "#333333");
  assert.equal(tokens?.["--primary"], "#6677cc");
  assert.equal(tokens?.["--secondary"], "#292929");
  assert.equal(tokens?.["--bg-muted"], "#252525");
  assert.equal(tokens?.["--accent"], "#aa77ee");
  assert.equal(tokens?.["--destructive"], "#ff6677");
  assert.equal(tokens?.["--input"], "#555555");
  assert.equal(tokens?.["--ring"], "#bb88ff");
});

test("preserves explicit OpenClaw semantic roles in built-in themes", () => {
  const tokens = modeTokens(
    {
      dark: {
        background: "#191724",
        foreground: "#d5d2eb",
        card: "#1f1d2e",
        "bg-hover": "#26233a",
        "text-strong": "#efedfa",
        "border-strong": "#3d3958",
        accent: "#ebbcba",
        "accent-subtle": "rgba(235, 188, 186, 0.12)",
        primary: "#ebbcba",
        "primary-hover": "#f2d0ce",
      },
    },
    "dark",
  );
  assert.equal(tokens?.["--bg-hover"], "#26233a");
  assert.equal(tokens?.["--text-strong"], "#efedfa");
  assert.equal(tokens?.["--border-strong"], "#3d3958");
  assert.equal(tokens?.["--accent-subtle"], "rgba(235, 188, 186, 0.12)");
  assert.equal(tokens?.["--primary-hover"], "#f2d0ce");
});

test("bundled Catppuccin matches the tweakcn payload consumed by OpenClaw", () => {
  const theme = JSON.parse(
    readFileSync(new URL("../../../themes/catppuccin.json", import.meta.url), "utf8"),
  ) as ShadcnTheme;
  const dark = modeTokens(theme, "dark");
  assert.equal(dark?.["--bg"], "oklch(0.2155 0.0254 284.0647)");
  assert.equal(dark?.["--card"], "oklch(0.2429 0.0304 283.9110)");
  assert.equal(dark?.["--popover"], "oklch(0.4037 0.0320 280.1520)");
  assert.equal(dark?.["--primary"], "oklch(0.7871 0.1187 304.7693)");
  assert.equal(dark?.["--accent"], "oklch(0.8467 0.0833 210.2545)");
  assert.notEqual(dark?.["--primary"], dark?.["--accent"]);
});

test("bundled Claw preserves OpenClaw's complete semantic palette", () => {
  const theme = JSON.parse(
    readFileSync(new URL("../../../themes/claw.json", import.meta.url), "utf8"),
  ) as ShadcnTheme;
  const dark = modeTokens(theme, "dark");
  assert.equal(dark?.["--bg"], "#0e1015");
  assert.equal(dark?.["--bg-accent"], "#13151b");
  assert.equal(dark?.["--bg-elevated"], "#191c24");
  assert.equal(dark?.["--panel-strong"], "#191c24");
  assert.equal(dark?.["--text-strong"], "#f4f4f5");
  assert.equal(dark?.["--border-strong"], "#2e3040");
  assert.equal(dark?.["--accent"], "#ff5c5c");
  assert.equal(dark?.["--primary"], "#d13c3c");
});

test("mode colors override shared registry colors while shared values remain usable", () => {
  const tokens = modeTokens(
    {
      cssVars: {
        theme: { accent: "#8855cc", "accent-foreground": "#111111" },
        dark: { background: "#101010", foreground: "#eeeeee", accent: "#aa77ee" },
      },
    },
    "dark",
  );
  assert.equal(tokens?.["--accent"], "#aa77ee");
  assert.equal(tokens?.["--accent-foreground"], "#111111");
});

test("pairs both modes into light-dark()", () => {
  const mapped = mapTheme(OURS);
  assert.equal(mapped?.variant, "both");
  assert.equal(mapped?.tokens["--bg"], "light-dark(#faf9f7, #0e1015)");
  assert.equal(mapped?.tokens["--ring"], "light-dark(#0b6bcb, #8bd3ff)");
});

// light-dark() only accepts colors. Wrapping a composite value like a whole
// box-shadow makes the declaration invalid, which silently kills the focus ring.
test("every paired value is a bare color", () => {
  for (const value of Object.values(mapTheme(OURS)?.tokens ?? {})) {
    assert.match(value, /^light-dark\(#|light-dark\(oklch\(|light-dark\(color-mix\(/);
  }
});

test("a one-mode file stays plain and reports that it cannot switch", () => {
  const darkOnly = mapTheme({ name: "Dracula", dark: OURS.dark });
  assert.equal(darkOnly?.variant, "dark");
  assert.equal(darkOnly?.tokens["--bg"], "#0e1015");
  assert.ok(!JSON.stringify(darkOnly?.tokens).includes("light-dark("));

  assert.equal(mapTheme({ light: OURS.light })?.variant, "light");
});

test("derives whatever a partial theme leaves out", () => {
  const tokens = modeTokens({ dark: { background: "#101010", foreground: "#eeeeee" } }, "dark");
  assert.equal(tokens?.["--card"], "color-mix(in srgb, #eeeeee 6%, #101010)");
  assert.equal(tokens?.["--ring"], "#eeeeee");
});

test("every bundled theme meets the contrast rules in each mode it carries", async () => {
  const { readdirSync } = await import("node:fs");
  const root = new URL("../../../themes/", import.meta.url);
  const files = readdirSync(root).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 6);
  for (const file of files) {
    const theme = JSON.parse(readFileSync(new URL(file, root), "utf8")) as ShadcnTheme;
    for (const mode of ["light", "dark"] as const) {
      const tokens = modeTokens(theme, mode);
      if (tokens) assert.deepEqual(contrastFailures(tokens), [], `${file} ${mode}`);
    }
  }
});

test("bundled Catppuccin and Dracula keep their hues where their own colors fall short", () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../themes/${name}.json`, import.meta.url), "utf8")) as ShadcnTheme;
  const catppuccin = read("catppuccin");
  const dracula = read("dracula");
  // Latte's sky accent (2.5:1 on its page) darkens; its mauve primary already reads and stays exactly as written.
  const latte = modeTokens(catppuccin, "light")!;
  const sky = themeColor((catppuccin.light as Record<string, string>)["accent"])!;
  assert.ok(contrastRatio(sky, themeColor(latte["--bg"])!) < 3);
  assert.ok(toOklch(themeColor(latte["--accent"])!).l < toOklch(sky).l);
  assert.ok(Math.abs(toOklch(themeColor(latte["--accent"])!).h - toOklch(sky).h) < 6);
  assert.equal(latte["--primary"], "oklch(0.5547 0.2503 297.0156)");
  // Dracula's comment color is its muted text; it lightens to read on cards and menus.
  const night = modeTokens(dracula, "dark")!;
  const comment = themeColor((dracula.dark as Record<string, string>)["muted-foreground"])!;
  assert.ok(toOklch(themeColor(night["--muted"])!).l > toOklch(comment).l);
  assert.equal(night["--muted-foreground"], night["--muted"], "the shadcn alias follows the solved color");
  assert.equal(night["--text"], (dracula.dark as Record<string, string>)["foreground"]);
});

test("an imported theme that fails is corrected per rule, with fills settled before the text on them", () => {
  const tokens = modeTokens({
    light: {
      background: "#ffffff",
      foreground: "#222222",
      card: "#ffffff",
      "muted-foreground": "#aaaaaa",
      accent: "#f5b942",
      "accent-foreground": "#ffffff",
      ring: "#f5b942",
      destructive: "#ff8080",
    },
  }, "light")!;
  assert.deepEqual(contrastFailures(tokens), []);
  assert.equal(tokens["--text"], "#222222", "a passing color is never rewritten");
  assert.notEqual(tokens["--muted"], "#aaaaaa");
  assert.equal(tokens["--accent-muted"], tokens["--accent"], "a derived role follows the solved accent");
  assert.equal(tokens["--danger"], tokens["--destructive"]);
  assert.ok(contrastRatio(themeColor(tokens["--accent-foreground"])!, themeColor(tokens["--accent"])!) >= 4.5);
});

test("a role the theme sets itself does not follow a solved color", () => {
  const own = modeTokens({
    dark: { background: "#101010", foreground: "#eeeeee", accent: "#3a1f8f", "accent-muted": "#5533aa" },
  }, "dark")!;
  assert.notEqual(own["--accent"], "#3a1f8f", "the dark violet accent lightens to read on #101010");
  assert.equal(own["--accent-muted"], "#5533aa");
});

test("colors only the page can resolve are left as written", () => {
  // A dark Lab color would fail on #101010, but only the browser converts Lab here, so it is not second-guessed.
  const tokens = modeTokens({ dark: { background: "#101010", foreground: "#eeeeee", accent: "lab(20% 10 -40)" } }, "dark");
  assert.equal(tokens?.["--accent"], "lab(20% 10 -40)");
  assert.equal(themeColor("color-mix(in srgb, #eeeeee 60%, #101010)")?.r, Math.round(0xee * 0.6 + 0x10 * 0.4));
  assert.equal(themeColor("color-mix(in srgb, var(--accent) 16%, transparent)"), undefined);
});

test("mapped themes expose each mode's own tokens", () => {
  const mapped = mapTheme(OURS)!;
  assert.equal(mapped.modes.light?.["--bg"], "#faf9f7");
  assert.equal(mapped.modes.dark?.["--bg"], "#0e1015");
  assert.deepEqual(Object.keys(mapTheme({ dark: OURS.dark })!.modes), ["dark"]);
});

test("a theme with no usable background or foreground is rejected", () => {
  assert.equal(mapTheme({}), undefined);
  assert.equal(mapTheme({ dark: {} }), undefined);
  assert.equal(mapTheme({ dark: { background: "#000" } }), undefined);
  assert.equal(mapTheme({ light: { background: "#fff", foreground: "#000" } })?.variant, "light");
});

// Theme files arrive over the network. A value that is not a color must not
// reach the inline style attribute, where it could add declarations of its own.
test("rejects values that are not colors", () => {
  assert.equal(
    modeTokens({ dark: { background: "#101010", foreground: "red; position: fixed" } }, "dark"),
    undefined,
  );
  const mixed = modeTokens(
    { dark: { background: "url(https://example.com/leak)", foreground: "#eeeeee" } },
    "dark",
  );
  assert.equal(mixed, undefined, "an unsafe background must not be used");
});

test("swatches prefer the dark block and come from the real mapping", () => {
  assert.deepEqual(swatchesFor(OURS), {
    accent: "#8bd3ff",
    text: "#eef4f8",
    raised: "#151b21",
    background: "#0e1015",
  });
  assert.equal(swatchesFor({}), undefined);
});

test("stylesheets use only OpenClaw semantic color roles, not retired HUI aliases", async () => {
  const { readdirSync } = await import("node:fs");
  const root = new URL("../../styles/", import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".css"));
  assert.ok(files.length > 10);
  for (const file of files) {
    const css = readFileSync(new URL(file, root), "utf8");
    assert.doesNotMatch(css, /--(?:bg-raised|bg-sunken|fg|fg-strong|fg-muted|focus-ring-color)(?![\w-])/u, file);
  }
});

const fixtures: { input: Parameters<typeof mapTheme>[0]; expected: ReturnType<typeof mapTheme> | null }[] = JSON.parse(readFileSync(new URL("./shadcn-theme.fixture.json", import.meta.url), "utf8"));

test("shadcn-theme preserves the shared runtime fixtures", () => {
  for (const fixture of fixtures) {
    assert.deepEqual(mapTheme(fixture.input) ?? null, fixture.expected);
  }
});
