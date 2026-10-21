import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const between = (source: string, start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test("+ → Import bot… opens the import dialog and a bot's ⋯ → Export… the export dialog", () => {
  const roster = read("./bots.ts");
  assert.match(between(roster, "function botRow(", "function archivedRow("), /<span class="session-menu__text">Export…<\/span>/u);
  assert.match(between(roster, "function botRow(", "function archivedRow("), /if \(action === "export"\) \{ drawer\.dialog\(event\); props\.onExport\(bot\); \}/u);
  assert.match(roster, /class="btn btn--sm bot-roster__import"[^\n]*props\.onImport\(\);/u, "the empty roster offers it too");
  assert.match(read("./shell.ts"), /onImport: botsTab\.onImport,/u);
});

test("the preview shows every imported text as plain text, says it is untrusted, and Create is the only way to make the bot", () => {
  const source = read("./bot-import.ts");
  assert.doesNotMatch(source, /unsafeHTML|renderMarkdown|innerHTML/u, "imported text is never rendered as HTML or Markdown");
  assert.match(source, /const textBlock = \(text: string\) => html`<pre class="bot-import__text">\$\{text\}<\/pre>`;/u);
  const preview = between(source, "function renderPreviewStep(", "export function renderBotImportDialog(");
  for (const shown of ["textBlock(preview.soul)", "textBlock(preview.opener)", "textBlock(skill.content)", "textBlock(routine.prompt)"]) assert.ok(preview.includes(shown), shown);
  assert.match(preview, /Imported text is untrusted: read it below before you create the bot\. An import turns nothing on beyond a new bot's defaults/u);
  assert.match(preview, /section\("Routines", `\$\{preview\.routines\.length\} · disabled`/u, "routines say they start disabled");
  assert.match(preview, /section\("Left out"/u, "and what was left out, with why");
  const dialog = between(source, "export function renderBotImportDialog(", "/* ── export");
  assert.match(dialog, /if \(preview\) props\.onCreate\(\); else props\.onPreview\(\);/u, "Preview first; Create only from a preview");
  assert.match(dialog, /\(props\.pending \? "Creating…" : "Create bot"\)/u);
  const css = read("../styles/bot-import.css");
  assert.match(css, /\.bot-import__text \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/u, "long lines wrap instead of widening the dialog");
  assert.match(css, /\.bot-import-dialog \.settings-input \{ font-size: var\(--control-ui-text-sm\); \}/u, "its fields and pickers read at the dialog's size, not a Settings row's");
  assert.match(css, /@media \(pointer: coarse\) \{\n\s+\.bot-import-dialog \.settings-input \{ font-size: var\(--control-ui-text-sm\) !important; \}/u, "on a phone too, over base.css's 16px floor");
  assert.match(css, /\.bot-export__row > :first-child \{[^}]*font-size: var\(--control-ui-text-sm\);/u, "a change's part and a script's name read at their picker's size");
  assert.match(css, /\.bot-export__need \{[^}]*font-size: var\(--control-ui-text-sm\);/u, "and so does each need");
  assert.match(css, /@media \(max-width: 640px\) \{\n\s+\.bot-import-dialog \{ width: calc\(100vw - 24px\);/u, "a phone gets the whole width");
});

test("the export dialog shows the gateway's review and the files Download saves, and sends back only the picks", () => {
  const addition = between(read("./bot-import.ts"), "function renderAddition(", "function renderReview(");
  assert.match(addition, /<button type="button" class="btn btn--sm bot-export__add-button"/u, "Add is a plain button: the dialog's form submits Download");
  assert.match(read("./bot-import.ts"), /section\("Missed something\?", [^\n]*\{ name: "export-add" \}\)/u, "its section's open state isn't bound to the form's, which closed it mid-edit");
  assert.match(addition, /if \(event\.key === "Enter" && !event\.isComposing\) \{ event\.preventDefault\(\); add\(\); \}/u, "and Enter in its line adds, never downloads, nor mid-word in an input method");
  assert.match(read("./bot-import.ts"), /review = withAdditions\(held, props\.added\);/u, "additions are changes in the preview as in the zip");
  assert.match(read("./bot-import.ts"), /<select class="settings-input" \.value=\$\{live\(value\)\}/u, "a row's select reused for another change shows that change's group");
  const source = read("./bot-import.ts");
  const review = between(source, "function renderReview(", "export function renderBotExportDialog(");
  assert.match(review, /const build = buildExport\(review, picks\);/u, "the files shown are the gateway's own build of the review and the picks");
  assert.match(review, /section\("Files as they will be saved"/u);
  assert.match(review, /textBlock\(change\.quote\)/u, "every passage as plain text");
  assert.match(between(source, "export function renderBotExportDialog(", "\n}\n"), /props\.pending \? "Reviewing…" : "Review again"/u);
});

