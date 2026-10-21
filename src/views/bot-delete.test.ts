import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const between = (source: string, start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test("a roster row's ⋯ menu deletes any bot, active ones included, through the confirmation", () => {
  const row = between(read("./bots.ts"), "function botRow(", "/** An archived bot keeps its chat");
  assert.match(row, /<wa-dropdown-item value="delete" variant="danger" class="session-menu__item session-menu__item--destructive">[^\n]*\$\{icons\.trash\}[^\n]*Delete…<\/span><\/wa-dropdown-item>/u);
  assert.match(row, /if \(action === "delete"\) \{ drawer\.dialog\(event\); props\.onDelete\(bot\); \}/u, "the mobile drawer yields to the dialog");
  assert.match(between(read("./bots.ts"), "function archivedRow(", "/** Show hidden (N)"), /props\.onDelete\(bot\)/u, "Show archived keeps its trash icon");
});

test("the bot's chat header has a ⋯ menu: Edit bot…, Archive… and Delete…, each the app's own dialog", () => {
  const home = read("./home.ts");
  const menu = between(home, "function renderBotHeaderMenu(", "/** Where HUI started a new bot's first turn");
  for (const [value, label] of [["edit", "Edit bot…"], ["archive", "Archive…"], ["delete", "Delete…"]] as const) {
    assert.match(menu, new RegExp(`<wa-dropdown-item value="${value}"[^\\n]*${label}<\\/span><\\/wa-dropdown-item>`, "u"), label);
  }
  assert.match(menu, /aria-label=\$\{`Actions for \$\{bot\.bot\.name\}`\}/u);
  assert.match(home, /\$\{props\.bot\?\.onAction \? renderBotHeaderMenu\(props\.bot\) : nothing\}/u);
});

test("the delete confirmation says what goes and what stays", () => {
  const dialog = between(read("./bots.ts"), "export function renderBotDeleteDialog(", "\n}\n");
  assert.match(dialog, /\$\{bot\.name\} is deleted for good: its chat leaves HUI, and its routines, its memory and its folder\$\{bot\.worker \? .*? : ""\} \(SOUL\.md and every file in it\) go\$\{bot\.worker && bot\.status === "disconnected" \? .*? : ""\}\. A workspace you chose for it stays\. This cannot be undone\./u, "a bot on a worker names it; the rest reads the same");
  assert.doesNotMatch(dialog, /archived/u, "any bot, not only an archived one");
});
