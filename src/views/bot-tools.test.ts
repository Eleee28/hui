import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const between = (source: string, start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test("Tools is a page of the panel, opened from the overview's Setup, self-contained in bot-tools.ts with its own controller and styles", () => {
  const panel = read("./bots.ts");
  assert.match(panel, /import \{ renderBotToolsTab, type BotToolsProps \} from "\.\/bot-tools\.ts";/u);
  assert.match(panel, /tools: Omit<BotToolsProps, "bot">;/u);
  assert.match(between(panel, "function renderSetup(", "function renderOverview("), /row\("tools", "tools", "Tools & skills", botToolsOffLabel\(bot\)\)/u, "Setup says what is off and opens the page");
  assert.match(between(panel, "function renderPanelView(", "/* ── size"), /case "tools": return keyed\(props\.bot\.id, renderBotToolsTab\(\{ bot: props\.bot, \.\.\.props\.tools \}\)\);/u, "another bot's page starts afresh");
  assert.match(read("./bot-tools.ts"), /loadViewAssets\(\(\) => import\("\.\.\/styles\/bot-tools\.css"\)\);/u);
  assert.doesNotMatch(read("./bot-settings.ts"), /disabledTools|disabledSkills|Available tools/u, "Settings gets no tools fields: they are this page");
});

test("Available tools: grouped switches with descriptions, powerful ones labelled, every switch waiting for a save", () => {
  const tab = between(read("./bot-tools.ts"), "function renderTools(", "function renderSkills(");
  assert.match(tab, /<h3 class="bot-panel__heading" id="bot-tools-available">Available tools<\/h3>/u);
  assert.match(tab, /groupBotTools\(catalog\.tools\)\.map\(\(group\) => html`<div class="bot-tools__group" role="group"/u);
  assert.match(tab, /renderSettingsToggle\(`\$\{tool\.label\} \(\$\{tool\.name\}\)`, tool\.enabled, \(checked\) => props\.onToggleTool\(tool\.name, checked\), disabled\)/u);
  assert.match(tab, /<span class="capability-badge bot-tools__powerful" title=\$\{POWERFUL_HINT\}>Powerful<\/span>/u);
  assert.match(tab, /const disabled = props\.state\.saving \|\| props\.bot\.archived === true;/u, "no two lists race; an archived bot is read-only");
  assert.match(tab, /an extension's tools aren't listed yet/u, "a chat that isn't running says what is missing");
});

test("Skills sit beside the tools, searchable once there are many; the request is answered here as in the chat", () => {
  const source = read("./bot-tools.ts");
  const skills = between(source, "function renderSkills(", "export function renderBotToolsTab(");
  assert.match(skills, /const searchable = catalog\.skills\.length >= SKILL_SEARCH_MIN;/u);
  assert.match(skills, /type="search" placeholder="Search skills" aria-label="Search skills"/u);
  assert.match(skills, /No skill matches/u);
  const request = between(source, "function renderRequest(", "function renderTools(");
  assert.match(request, /const \[allow, deny\] = BOT_ACCESS_ANSWERS;/u);
  assert.match(request, /@click=\$\{\(\) => props\.onAnswer\(allow\)\}>\$\{allow\}<\/button>/u);
  assert.match(request, /You can answer it in the chat too\. Only you can\./u);
  const tab = between(source, "export function renderBotToolsTab(", "\n}\n");
  assert.match(tab, /Reading \$\{props\.bot\.name\}'s tools…/u);
  assert.match(tab, /Refresh failed: \$\{state\.error\}/u, "a failed refresh keeps what was shown");
  assert.match(tab, /<h3 class="bot-panel__heading" id="bot-tools-always">Always on<\/h3>/u);
  assert.match(tab, /Tools are the boundary, not a sandbox/u);
});

test("the Tools & skills page's styles use theme tokens only, so dark and light alike, and roomy rows on touch", () => {
  const styles = read("../styles/bot-tools.css");
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/iu, "no raw colors");
  assert.match(styles, /\.bot-tools__group \{[^}]*background: var\(--card\);/u);
  assert.match(styles, /\.bot-tools__powerful \{[^}]*color: var\(--warn\);/u);
  assert.match(styles, /@media \(pointer: coarse\) \{\n\s+\.bot-tools__row \{ min-height: 44px; \}/u);
});
