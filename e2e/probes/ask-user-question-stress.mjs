#!/usr/bin/env node
/**
 * Stress run for HUI's `ask_user_question` card against an isolated
 * visual-verification instance (Durable, or `launch --pi-sessions`):
 *
 *   node e2e/probes/ask-user-question-stress.mjs --receipt <receipt.json> [scenario,…]
 *
 * It writes its questionnaires into the instance's workspace, drives a private
 * headless Chrome with real key and mouse events (sessions are created through
 * the API, then opened from the sidebar) and asserts what the card, the
 * transcript and the fixture provider show. Complements the Browser-tool
 * journey in `ask-user-question.browser.md`; it does not replace it.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const receiptPath = args[args.indexOf("--receipt") + 1];
if (!args.includes("--receipt") || !receiptPath) throw new Error("Usage: node e2e/probes/ask-user-question-stress.mjs --receipt <receipt.json> [scenario,…]");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
const base = receipt.browserUrl;
const workspace = receipt.workspace;
const only = args.filter((arg, index) => arg !== "--receipt" && index !== args.indexOf("--receipt") + 1)[0];
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const o = (label, description, extra = {}) => ({ label, description, ...extra });
/** The questionnaires the scenarios ask, as `ask-<name>.json` for the fixture provider's `E2E_ASK_USER:<name>`. */
const cases = {
  single: { questions: [{ header: "Library", question: "Which date library should we use?", options: [o("date-fns (Recommended)", "Tree-shakable functions, small bundles."), o("Luxon", "Rich time-zone support with an immutable API."), o("Day.js", "Moment-compatible API in 2 KB.")] }] },
  full: { questions: [
    { header: "Auth method", question: "How should users sign in?", options: [o("OAuth with Google", "Delegates identity; no passwords stored."), o("Email magic link", "Passwordless; needs an email provider."), o("Username + password", "Classic; we must store and hash passwords.")] },
    { header: "Features", question: "Which features should the first release include?", multiSelect: true, options: [o("Search", "Full-text search over notes."), o("Export", "Download notes as Markdown."), o("Sync", "Real-time sync across devices."), o("Sharing", "Share a note with a public link.")] },
    { header: "Layout", question: "Which layout do you prefer for the dashboard?", options: [
      o("Sidebar", "Navigation in a left sidebar.", { preview: "```\n+--------+------------------+\n| Nav    |  Content         |\n| - Home |                  |\n| - Docs |                  |\n+--------+------------------+\n```" }),
      o("Top bar", "Navigation across the top.", { preview: "```\n+---------------------------+\n| Home  Docs  Settings      |\n+---------------------------+\n|  Content                  |\n+---------------------------+\n```" }),
      o("Command palette", "No chrome; everything through ⌘K.", { preview: "**Minimal.** Press `⌘K` to open:\n\n- Go to…\n- New note\n- Settings" })] },
    { header: "Deadline", question: "When do you need it?", options: [o("This week", "Ship the smallest slice."), o("This month", "Room for polish.")] },
  ] },
  invalid: { questions: [{ header: "Pick", question: "Which?", options: [o("A", "a"), o("Other", "other")] }] },
  stress: { questions: [
    { header: "Sixteen chars!!!", question: "This is a deliberately very long question that keeps going to check how the card wraps text across several lines on both desktop and mobile widths, including some `inline code` and a very-long-unbroken-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?", options: [
      o("A label that is exactly sixty characters long, padded out..", "A description that is also long. ".repeat(12)),
      o("<b>not bold</b> & <script>alert(1)</script>", "HTML in labels must render as text, not markup."),
      o("Ünïcödé 🚀 标签", "Non-ASCII labels."),
      o("Short", "")] },
    { header: "Huge preview", question: "Compare the long previews?", options: [
      o("Long code", "A very long code preview.", { preview: "```ts\n" + Array.from({ length: 40 }, (_, i) => `const line${i} = "${"x".repeat(i % 50)}"; // ${i}`).join("\n") + "\n```" }),
      o("Markdown", "Rich markdown with a table and an injected script.", { preview: "# Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert('xss')</script><img src=x onerror=alert(1)>\n\n> quote" })] },
  ] },
};
cases.parallel = [cases.single, { questions: [{ header: "Second", question: "Is this the second card?", options: [o("Yes", "It came after the first."), o("No", "Something went wrong.")] }] }];

for (const [name, input] of Object.entries(cases)) writeFileSync(join(workspace, `ask-${name}.json`), JSON.stringify(input));

const PORT = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "aq-chrome-"))}`,
  "--no-first-run", "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });
process.on("exit", () => chrome.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(100);
  target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => undefined);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let next = 0;
const waiting = new Map();
const errors = [];
ws.addEventListener("message", (event) => {
  const m = JSON.parse(event.data);
  if (m.id !== undefined) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Runtime.enable"); await cdp("Page.enable");
const evaluate = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception?.description}`);
  return r.result.value;
};
const until = async (expression, label, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await evaluate(expression).catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await sleep(50);
  }
};
const KEYS = { Enter: [13, "\r"], Escape: [27, ""], ArrowDown: [40, ""], ArrowUp: [38, ""], ArrowLeft: [37, ""], ArrowRight: [39, ""], Tab: [9, ""], " ": [32, " "] };
const key = async (k, modifiers = 0) => {
  const [code, text] = KEYS[k] ?? [k.charCodeAt(0), k];
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, windowsVirtualKeyCode: code, text, modifiers, code: /^\d$/u.test(k) ? `Digit${k}` : k });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, windowsVirtualKeyCode: code, modifiers });
};
const typeText = async (text) => { for (const ch of text) await cdp("Input.insertText", { text: ch }); };
const click = async (selector) => {
  const box = await until(`(() => { const e = ${selector}; if (!e) return; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : undefined; })()`, `click ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
};
/** A value as a JavaScript literal for the page's code, safe inside any context (CodeQL js/bad-code-sanitization). */
const literal = (value) => JSON.stringify(value).replace(/[<>/\u2028\u2029]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
// HUI keeps recently opened sessions mounted in hidden panes: only the visible one counts.
const visible = (selector) => `[...document.querySelectorAll(${literal(selector)})].filter((e) => !e.closest('[aria-hidden="true"]'))`;
const card = `${visible("hui-questionnaire-card")}[0]`;
const state = () => evaluate(`(() => { const c = ${card}; if (!c) return null; return {
  step: c.querySelector(".chat-question-panel__progress")?.textContent,
  question: c.querySelector(".chat-question-panel__prompt")?.textContent,
  checked: [...c.querySelectorAll('[aria-checked="true"]')].map((e) => e.dataset.option),
  focused: document.activeElement?.dataset?.option ?? document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
}; })()`);
const option = (label) => `[...${card}.querySelectorAll("[data-option]")].find((e) => e.dataset.option === ${literal(label)})`;
const button = (text) => `[...${card}.querySelectorAll("button")].find((e) => e.textContent.trim() === ${literal(text)})`;
const api = (path, body) => fetch(`${base}/__hui${path}`, { method: body ? "POST" : "GET", headers: { "x-hui": "1", "content-type": "application/json" }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

let passed = 0;
const failures = [];
const check = (ok, label, detail) => { if (ok) passed++; else failures.push(`${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`); };

/** Starts a session that calls ask_user_question with `ask-<name>.json` and opens it. */
async function create(name) {
  const { body } = await api("/sessions", { cwd: workspace, title: `stress ${name}` });
  const id = body.session.id;
  let sent;
  for (let i = 0; i < 600; i++) {
    sent = await api(`/sessions/${id}/prompt`, { text: `E2E_ASK_USER:${name}` });
    if (!/still starting/u.test(sent.body?.error ?? "")) break;
    await sleep(100);
  }
  if (sent.status !== 200) throw new Error(`prompt: ${JSON.stringify(sent.body)}`);
  return id;
}
/** Opens a session from the sidebar, as the operator does. */
async function open(id) {
  if (!(await evaluate("location.origin")).startsWith(base)) await cdp("Page.navigate", { url: base });
  await click(`document.querySelector('a[href="/sessions/${id}"]')`);
  await until(`location.pathname === "/sessions/${id}"`, "opened");
}
async function start(name) {
  const id = await create(name);
  await open(id);
  await until(`!!${card}?.querySelector(".chat-question-panel__prompt")`, `card for ${name}`);
  return id;
}
/** The last tool result the model got that holds `marker`: the chat renders the reply as Markdown, where a
 * preview's fence swallows the rest, so read the provider's log. */
const modelGot = async (marker) => /"content":("User has answered[^"\\]*(?:\\.[^"\\]*)*")/u.exec((await readFile(join(receipt.artifacts, "provider.jsonl"), "utf8")).split("\n").filter((line) => line.includes(marker)).at(-1) ?? "")?.[1] ?? "\"\"";
const reply = () => until(`${visible(".chat-text")}.map((e) => e.textContent).find((t) => t.includes("tool answered:"))`, "model reply");
const idle = () => until(`!${card}`, "card gone");

const scenarios = {
  async keyboardFull() {
    await start("full");
    check((await state()).focused === "OAuth with Google", "opens focused on the first option", await state());
    await key("2"); await key("Enter");
    let s = await state();
    check(s.step === "2/4" && s.focused === "Search", "Enter on a radio advances", s);
    await key("1"); await key("3"); await key("3"); await key("3");
    s = await state();
    check(JSON.stringify(s.checked) === '["Search","Sync"]', "digits toggle checkboxes", s);
    await key(" "); // Space toggles the focused Sync off
    s = await state();
    check(JSON.stringify(s.checked) === '["Search"]', "Space toggles a checkbox", s);
    await key("5"); await typeText("Tags"); await key("Enter");
    s = await state();
    check(s.step === "3/4", "Enter in the free text advances", s);
    await key("2");
    s = await state();
    check(JSON.stringify(s.checked) === '["Top bar"]' && s.focused === "Top bar", "a digit right after works on the next question", s);
    await key("ArrowUp"); await key("ArrowDown"); await key("ArrowDown");
    const preview = await evaluate(`${card}.querySelector(".questionnaire-card__preview")?.textContent`);
    check(preview.includes("⌘K"), "preview follows focus", preview);
    await key("ArrowLeft");
    s = await state();
    check(s.step === "2/4" && s.checked.includes("Search"), "ArrowLeft goes back, picks kept", s);
    check(await evaluate(`${card}.querySelector("input").value`) === "Tags", "typed text kept");
    await key("ArrowRight"); await key("ArrowRight");
    s = await state();
    check(s.step === "4/4", "ArrowRight goes forward", s);
    check(await evaluate(`${button("Submit")}?.disabled === false`), "Submit enabled with answers");
    await key("1"); await key("Enter", 2 /* ctrl */);
    await reply();
    const text = JSON.parse(await modelGot("Search, Tags"));
    check(text.includes('"How should users sign in?"="Email magic link"') && text.includes('"Which features should the first release include?"="Search, Tags"')
      && text.includes('"Which layout do you prefer for the dashboard?"="Top bar". selected preview:') && text.includes('"When do you need it?"="This week"'), "model gets every answer", text);
    const summary = await until(`${visible(".chat-question-summary")}[0]?.innerText`, "summary");
    check(summary.includes("Auth method") && summary.includes("Search, Tags") && summary.includes("Top bar"), "transcript summary", summary);
    check(!(await evaluate(`!!${card}`)), "card gone after submit");
  },

  async mouseFull() {
    await start("full");
    await click(option("Username + password"));
    await click(`[...${card}.querySelectorAll('[role="tab"]')][2]`);
    let s = await state();
    check(s.step === "3/4", "tab jumps to a question", s);
    await click(option("Top bar"));
    const preview = await evaluate(`${card}.querySelector(".questionnaire-card__preview")?.textContent`);
    check(preview.includes("Settings"), "clicked option previews", preview);
    await click(button("Back"));
    await click(option("Export")); await click(option("Sharing")); await click(option("Export"));
    s = await state();
    check(JSON.stringify(s.checked) === '["Sharing"]', "click toggles checkboxes", s);
    // Single-select: typing replaces the choice, clicking an option replaces the typed one.
    await click(`[...${card}.querySelectorAll('[role="tab"]')][0]`);
    await click(`${card}.querySelector("input")`); await typeText("SSO");
    s = await state();
    check(s.checked.length === 0, "typing replaces a single choice", s);
    await click(option("OAuth with Google"));
    s = await state();
    check(JSON.stringify(s.checked) === '["OAuth with Google"]', "an option replaces typed text", s);
    await click(`[...${card}.querySelectorAll('[role="tab"]')][3]`);
    await click(option("This month"));
    await click(button("Submit"));
    await reply();
    const text = await modelGot("Top bar");
    const got = JSON.parse(text);
    check(got.includes('="OAuth with Google"') && got.includes('="Sharing"') && got.includes('="Top bar". selected preview:') && got.includes('="This month"'), "mouse answers reach the model", got);
  },

  async cancelButton() {
    await start("single");
    await click(button("Cancel"));
    const text = await reply();
    check(text.includes("User declined to answer questions"), "Cancel declines", text);
    check((await evaluate(`${visible(".chat-question-summary")}[0]?.innerText`))?.includes("declined"), "summary says declined");
  },

  async escape() {
    await start("single");
    await click(`${card}.querySelector("input")`); await typeText("half typed");
    await key("Escape");
    check(await evaluate(`!!${card}`), "first Escape in typed text keeps the card");
    check(await evaluate(`${card}.querySelector("input").value`) === "half typed", "and the text");
    await key("Escape");
    const text = await reply();
    check(text.includes("User declined"), "second Escape declines", text);
  },

  async stop() {
    await start("single");
    check(await evaluate(`document.body.innerText.includes("Waiting for your answer")`), "header says waiting");
    await click(`${visible('button[aria-label="Stop"]')}[0]`);
    await idle();
    await until(`!${visible('button[aria-label="Stop"]')}[0]`, "run stopped");
    check(await until(`!document.body.innerText.includes("Waiting for your answer")`, "not waiting"), "session no longer waiting");
  },

  async reload() {
    await start("full");
    await key("3"); await key("Enter");
    await cdp("Page.reload");
    // The reloaded app may mount the card more than once while the session opens.
    await until(`${card}?.querySelector(".chat-question-panel__progress")?.textContent === "1/4"`, "a reload shows the card again from the start");
    await click(button("Cancel"));
    await reply();
  },

  async parallel() {
    // Two calls in one turn run together: one card at a time, in either order.
    await start("parallel");
    const first = (await state()).question;
    await key("1"); await key("Enter");
    await until(`${card}?.querySelector(".chat-question-panel__prompt")?.textContent && ${card}.querySelector(".chat-question-panel__prompt").textContent !== ${literal(first)}`, "second card");
    const s = await state();
    check(s.checked.length === 0 && s.focused !== "BODY", "the next card starts fresh and focused", s);
    await key("1"); await key("Enter");
    const text = await reply();
    check(text.includes('="date-fns (Recommended)"') && text.includes('="Yes"'), "both answers reach the model", text);
  },

  async invalid() {
    await open(await create("invalid"));
    const text = await reply();
    check(text.includes("reserved"), "a reserved label is refused back to the model", text);
    check(!(await evaluate(`!!${card}`)), "no card for a refused call");
  },

  async stressContent() {
    await evaluate("window.__xss = 0");
    await start("stress");
    const label = await evaluate(`${card}.querySelectorAll("[data-option]")[1].querySelector("strong").textContent`);
    check(label === "<b>not bold</b> & <script>alert(1)</script>", "HTML labels are text", label);
    check(await evaluate(`!${card}.querySelector("b, script")`), "no injected elements in options");
    const overflow = await evaluate(`(() => { const f = ${card}.querySelector("form"); return f.scrollWidth - f.clientWidth; })()`);
    check(overflow <= 0, "long words wrap inside the card", overflow);
    await key("4"); await key("Enter");
    const preview = await evaluate(`${card}.querySelector(".questionnaire-card__preview")?.getBoundingClientRect().height`);
    check(preview > 100 && preview <= 400, "a long preview is bounded and scrolls inside its pane", preview);
    await key("2");
    await sleep(200);
    check(await evaluate(`!${card}.querySelector(".questionnaire-card__preview script, .questionnaire-card__preview img[onerror]") && window.__xss === 0`), "preview Markdown is sanitized");
    const footer = await evaluate(`(() => { const f = ${card}.querySelector("footer").getBoundingClientRect(); const c = ${card}.querySelector("form").getBoundingClientRect(); return f.bottom <= c.bottom + 1 && f.top >= c.top; })()`);
    check(footer, "the actions stay visible");
    await key("Enter", 2);
    const text = await reply();
    check(text.includes('"Compare the long previews?"="Markdown". selected preview: # Heading'), "stress answer", text.slice(0, 200));
  },

  async manySessions() {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await create("single"));
    const labels = ["date-fns (Recommended)", "Luxon", "Day.js"];
    for (const [i, id] of ids.entries()) {
      await open(id);
      await until(`!!${card}?.querySelector(".chat-question-panel__prompt")`, `card ${i}`);
      await click(option(labels[i % 3])); await click(button("Submit"));
      const text = await reply();
      check(text.includes(`="${labels[i % 3]}"`), `session ${i} gets its own answer`, text);
    }
  },

  async mash() {
    // Random keys, clicks and reloads: the card must never throw, and must end with a consistent answer.
    let seed = 7;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    for (let round = 0; round < 6; round++) {
      await start("full");
      for (let i = 0; i < 80 && (await evaluate(`!!${card}`)); i++) {
        const pick = rand(10);
        if (pick < 5) await key(String(1 + rand(5)));
        else if (pick < 7) await key(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", " "][rand(5)]);
        else if (pick < 8) await click(`[...${card}.querySelectorAll('[role="tab"]')][${rand(4)}]`).catch(() => {});
        else if (pick < 9 && (await evaluate(`document.activeElement?.tagName === "INPUT"`))) await typeText("x");
        else await key("Enter");
      }
      if (await evaluate(`!!${card}`)) await click(button("Cancel"));
      const text = await reply();
      check(/User has answered|User declined/u.test(text), `mash round ${round} settles`, text.slice(0, 120));
    }
  },

  async mobile() {
    await start("full");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    await click(`[...${card}.querySelectorAll('[role="tab"]')][2]`);
    const fits = await evaluate(`(() => { const c = ${card}.querySelector("form"); const r = c.getBoundingClientRect(); const f = c.querySelector("footer").getBoundingClientRect();
      const pre = c.querySelector(".questionnaire-card__preview").getBoundingClientRect(); const opts = c.querySelector(".questionnaire-card__options").getBoundingClientRect();
      return { inside: r.left >= 0 && r.right <= 390, overflow: c.scrollWidth - c.clientWidth, footer: f.bottom <= r.bottom + 1, stacked: pre.top >= opts.bottom - 1, docOverflow: document.documentElement.scrollWidth - 390 }; })()`);
    check(fits.inside && fits.overflow <= 0 && fits.footer && fits.stacked && fits.docOverflow <= 0, "mobile layout fits, preview stacks under options", fits);
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(receipt.artifacts, "ask-user-question-mobile.png"), Buffer.from(shot.data, "base64"));
    await click(button("Cancel"));
    await reply();
    await cdp("Emulation.clearDeviceMetricsOverride");
  },
};

for (const [name, run] of Object.entries(scenarios)) {
  if (only && !only.split(",").includes(name)) continue;
  const before = failures.length;
  try { await run(); } catch (error) {
    failures.push(`${name} threw: ${error.message}`);
    const shot = await cdp("Page.captureScreenshot", { format: "png" }).catch(() => undefined);
    if (shot) writeFileSync(join(receipt.artifacts, `ask-user-question-${name}.png`), Buffer.from(shot.data, "base64"));
  }
  console.log(`${failures.length === before ? "PASS" : "FAIL"} ${name}`);
}
check(errors.length === 0, "no page errors", errors);
console.log(`${passed} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
ws.close();
process.exit(failures.length ? 1 : 0);
