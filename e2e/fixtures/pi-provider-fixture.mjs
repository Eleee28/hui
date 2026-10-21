#!/usr/bin/env node
/** Deterministic Anthropic-compatible provider for Browser E2E.
 * It is not a PI replacement: the real `pi --mode rpc` process talks to this
 * local provider, executes its real read tool and persists its real JSONL. */
import { appendFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";

let port = Number(process.env.HUI_E2E_PROVIDER_PORT ?? 43127);

/** What the export reviewer flags in fixture bots: a teammate's name, the repositories to watch and an approval rule. */
const REVIEW_PASSAGES = [
  { quote: "Pat Doe", group: "remove", reason: "A teammate's name.", replacement: "a teammate" },
  { quote: "acme/widgets", group: "ask", reason: "The owner's own repository.", label: "the repositories to watch", question: "Which repositories should I watch for pull requests?" },
  { quote: "Approve only when CI is green", group: "confirm", reason: "An approval rule.", question: "Should I approve only when CI is green, or do you want other rules?" },
];

const workspace = process.env.HUI_E2E_WORKSPACE;
const logFile = process.env.HUI_E2E_PROVIDER_LOG;
if (!workspace || !logFile) throw new Error("HUI_E2E_WORKSPACE and HUI_E2E_PROVIDER_LOG are required");

const replayWaiters = new Set();
const replayReadyWaiters = new Set();
/** Responses held so far, and who waits for a count of them: a resent request held again is told apart by count. */
let heldCount = 0;
const heldCountWaiters = new Set();
const signalReplayReady = () => {
  for (const ready of replayReadyWaiters) ready();
  replayReadyWaiters.clear();
};
const subagentSteeringWaiters = new Set();
let subagentParentWaiting = false;
const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const event = (response, value) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
const messageStart = (response) => event(response, {
  type: "message_start",
  message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
});
const finish = (response, reason = "end_turn") => {
  event(response, { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } });
  event(response, { type: "message_stop" });
  response.end();
};
const text = (response, value, index = 0) => {
  event(response, { type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } });
  event(response, { type: "content_block_delta", index, delta: { type: "text_delta", text: value } });
  event(response, { type: "content_block_stop", index });
};
const toolUse = (response, id, name, input, index = 0) => {
  event(response, { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
  event(response, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
  event(response, { type: "content_block_stop", index });
};
const flattenedText = (value) => JSON.stringify(value ?? []);
/** An OptChat turn opens its first user message with the memory's view (one text block, or several where cache marks
 * split it); fixtures answer what follows it, never the summaries of earlier turns. */
const withoutView = (message) => {
  const content = Array.isArray(message?.content) ? message.content : undefined;
  if (content?.[0]?.type !== "text" || !String(content[0].text).startsWith("<chat>\n")) return message;
  const end = content.findIndex((block) => block?.type === "text" && String(block.text).endsWith("\n</chat>"));
  return end === -1 ? message : { ...message, content: content.slice(end + 1) };
};
/** Plain text of every tool result so far, so a multi-step fixture can reuse
 * refs from an earlier browser snapshot without JSON escaping. */
const toolResultTexts = (messages) => (Array.isArray(messages) ? messages : []).flatMap((message) =>
  (Array.isArray(message?.content) ? message.content : []).filter((block) => block?.type === "tool_result").map((block) =>
    typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((item) => item?.text ?? "").join("") : ""));
/** `E2E_BROWSER_SLOW` paces each browser step like a model that thinks for a
 * moment, so the chat's live browser preview can be observed mid-run. */
const browserPace = (body) => flattenedText(body.messages).includes("E2E_BROWSER_SLOW")
  ? new Promise((resolve) => setTimeout(resolve, 1_500))
  : Promise.resolve();
const BROWSER_FIXTURE_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>HUI browser fixture</title>
  <style>
    body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: #1f2328; background: #f6f8fa; }
    main { max-width: 560px; margin: 48px auto; padding: 32px; border-radius: 12px; background: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 12%); }
    h1 { margin-top: 0; font-size: 28px; }
    label { display: block; margin: 20px 0 8px; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #d0d7de; border-radius: 6px; font: inherit; }
    button { margin-top: 16px; padding: 10px 18px; border: 0; border-radius: 6px; color: #fff; background: #0969da; font: inherit; cursor: pointer; }
    #greeting { min-height: 1.5em; margin: 20px 0 0; font-size: 20px; font-weight: 600; color: #1a7f37; }
  </style>
</head>
<body>
  <main>
    <h1>HUI browser fixture</h1>
    <p>Served by the deterministic E2E provider and driven by an agent through HUI's managed browser.</p>
    <label for="name">Name</label>
    <input id="name" autocomplete="off">
    <button type="button" id="greet">Greet</button>
    <p id="greeting" role="status"></p>
  </main>
  <script>
    document.getElementById("greet").addEventListener("click", () => {
      const name = document.getElementById("name").value;
      document.getElementById("greeting").textContent = "Hello, " + name + "! Rendered by page JavaScript.";
      console.log("greeted", name);
    });
  </script>
</body>
</html>`;
/** A small built-in widget for show_widget checks. */
const COUNTER_WIDGET = `<div id="counter" class="row">
<style>#counter{gap:12px}#counter output{min-width:3ch;font:600 22px/1 var(--font-mono);color:var(--text-strong)}</style>
<button type="button" class="primary" id="counter-add">Add one</button>
<output id="counter-value" aria-live="polite">0</output>
<span class="muted">Clicks stay inside the sandbox.</span>
<script>
let count = 0;
document.getElementById("counter-add").addEventListener("click", () => {
  count += 1;
  document.getElementById("counter-value").textContent = String(count);
});
</script>
</div>`;
const optionalFile = (path) => readFile(path, "utf8").catch(() => undefined);
const toolResultFrom = (message) => {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const block = blocks.find((item) => item?.type === "tool_result");
  if (!block) return undefined;
  const content = typeof block.content === "string"
    ? block.content
    : Array.isArray(block.content)
      ? block.content.map((item) => item?.text ?? "").join("")
      : "";
  let result;
  try { result = JSON.parse(content); } catch { result = content; }
  return { id: block.tool_use_id, result };
};

/** True once POST /control/release-replay frees the response, false if the
 * client disconnected first (an abort). */
const heldUntilRelease = (response) => new Promise((resolve) => {
  heldCount += 1;
  for (const waiter of heldCountWaiters) waiter();
  const release = () => {
    replayWaiters.delete(release);
    response.off("close", disconnected);
    resolve(true);
  };
  const disconnected = () => {
    replayWaiters.delete(release);
    resolve(false);
  };
  replayWaiters.add(release);
  response.once("close", disconnected);
  signalReplayReady();
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true });
  if (request.method === "GET" && url.pathname === "/browser-fixture") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return response.end(BROWSER_FIXTURE_PAGE);
  }
  if (request.method === "GET" && url.pathname === "/control/wait-subagent-parent") {
    subagentParentWaiting = true;
    const release = () => json(response, 200, { command: "released" });
    replayWaiters.add(release);
    request.on("close", () => replayWaiters.delete(release));
    for (const complete of subagentSteeringWaiters) complete();
    subagentSteeringWaiters.clear();
    return;
  }
  if (request.method === "GET" && url.pathname === "/control/wait-command") {
    const release = () => json(response, 200, { command: "released" });
    replayWaiters.add(release);
    signalReplayReady();
    request.on("close", () => replayWaiters.delete(release));
    return;
  }
  if (request.method === "GET" && url.pathname === "/control/wait-replay-ready") {
    const ready = () => json(response, 200, { ready: true });
    if (replayWaiters.size > 0) return ready();
    replayReadyWaiters.add(ready);
    request.on("close", () => replayReadyWaiters.delete(ready));
    return;
  }
  if (request.method === "GET" && url.pathname === "/control/wait-held") {
    const count = Number(url.searchParams.get("count") ?? 1);
    const check = () => {
      if (heldCount < count) return;
      heldCountWaiters.delete(check);
      json(response, 200, { held: heldCount });
    };
    heldCountWaiters.add(check);
    request.on("close", () => heldCountWaiters.delete(check));
    return check();
  }
  if (request.method === "POST" && url.pathname === "/control/release-replay") {
    for (const release of replayWaiters) release();
    replayWaiters.clear();
    return json(response, 200, { ok: true });
  }
  if (request.method !== "POST" || url.pathname !== "/v1/messages") {
    process.stderr.write(`HUI E2E provider rejected ${request.method} ${url.pathname}\n`);
    return json(response, 404, { error: "not found" });
  }

  // Opt-in credential check, e.g. to prove a remote worker got the key.
  const requiredKey = process.env.HUI_E2E_PROVIDER_KEY;
  if (requiredKey && request.headers["x-api-key"] !== requiredKey) {
    return json(response, 401, { type: "error", error: { type: "authentication_error", message: "fixture provider: wrong API key" } });
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // A fixture provider whose x-client-session-id header interpolates `${PI_CLIENT_SESSION_ID}`
  // logs the identity HUI resolved for the request.
  const clientSessionId = request.headers["x-client-session-id"];
  // And one with an x-e2e-token header logs that, e.g. to prove a remote worker got it.
  const header = request.headers["x-e2e-token"];
  await appendFile(logFile, `${JSON.stringify({ ...body, ...(clientSessionId === undefined ? {} : { clientSessionId }), ...(header === undefined ? {} : { header }) })}\n`, "utf8");
  const source = flattenedText(withoutView(body.messages?.at(-1)));
  const latestToolResult = toolResultFrom(body.messages?.at(-1));

  // OptChat's compactor: one short kind-tagged line per step, naming the step's first marker. A message holding
  // E2E_HOLD_MEMORY waits for POST /control/release-replay; E2E_OVERSIZE_MEMORY gets one line over the limit first.
  if (flattenedText(body.system).includes("You write the memory of")) {
    const blocks = Array.isArray(body.messages?.at(-1)?.content) ? body.messages.at(-1).content : [];
    const step = String(blocks.at(-1)?.text ?? "");
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    messageStart(response);
    if (step.startsWith("That line is ")) { text(response, "FIXTURE_MEMORY retried, now short"); return finish(response); }
    // After the ruler paragraph and the instruction: the message, or the two lines to merge.
    const input = step.split("\n").slice(4).join("\n");
    const marker = /\b(?:E2E|OPT)_[A-Z0-9_]+/u.exec(input)?.[0] ?? "lines";
    const compress = step.includes("\nCompress this message into one line");
    if (compress && input.includes("E2E_HOLD_MEMORY") && !(await heldUntilRelease(response))) return;
    if (compress && input.includes("E2E_OVERSIZE_MEMORY")) { text(response, `FIXTURE_MEMORY ${"oversize ".repeat(70)}`); return finish(response); }
    text(response, compress ? `${input.slice(0, input.indexOf(":"))}: FIXTURE_MEMORY ${marker}` : `FIXTURE_MEMORY merged ${marker}`);
    return finish(response);
  }
  if (source.includes("E2E_ERROR")) return json(response, 500, { type: "error", error: { type: "api_error", message: "fixture provider error" } });

  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  messageStart(response);

  // A bot export's reviewer (Settings' utility model): a change for each fixture passage the part holds, and a need for a
  // part that runs gh.
  if (flattenedText(body.system).includes("You check a HUI bot before its owner shares it")) {
    const changes = REVIEW_PASSAGES.filter((change) => source.includes(change.quote));
    text(response, JSON.stringify({ changes, needs: source.includes("gh pr") ? ["The GitHub CLI signed in, with access to the repositories it reviews"] : [] }));
    return finish(response);
  }

  // Tool calls a test chooses: E2E_CALL:<base64url JSON of { name, input }, or an array of them> calls them all in one
  // response, and the next answer quotes every result.
  // E2E_ASK_USER:<name> does the same with ask_user_question and the workspace's `ask-<name>.json`: its input, or an
  // array of inputs for parallel calls.
  const chosen = /E2E_CALL:([A-Za-z0-9_-]+)/u.exec(source)?.[1];
  const asked = /E2E_ASK_USER:([a-z0-9-]+)/u.exec(source)?.[1];
  if (chosen || asked) {
    const calls = asked
      ? [JSON.parse(await readFile(`${workspace}/ask-${asked}.json`, "utf8"))].flat().map((input) => ({ name: "ask_user_question", input }))
      : [JSON.parse(Buffer.from(chosen, "base64url").toString("utf8"))].flat();
    calls.forEach((call, index) => toolUse(response, `tool-e2e-call-${index}`, call.name, call.input ?? {}, index));
    return finish(response, "tool_use");
  }
  if (String(latestToolResult?.id ?? "").startsWith("tool-e2e-call-")) {
    text(response, `tool answered: ${toolResultTexts([body.messages?.at(-1)]).join(" | ")}`);
    return finish(response);
  }

  // A bot asking the operator for the shell through request_access; its reply is the tool's answer.
  if (source.includes("E2E_REQUEST_ACCESS")) {
    toolUse(response, "tool-e2e-request-access", "request_access", { tools: ["bash"], reason: "I need the shell to run the test suite before I report back." });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-request-access") {
    text(response, typeof latestToolResult.result === "string" ? latestToolResult.result : JSON.stringify(latestToolResult.result));
    return finish(response);
  }

  // A bot messaging another bot through HUI's message_bot tool: @bob, or the handle after it (E2E_MESSAGE_BOT @home).
  if (source.includes("E2E_MESSAGE_BOT")) {
    const to = /E2E_MESSAGE_BOT (@[a-z0-9-]+)/u.exec(source)?.[1] ?? "@bob";
    toolUse(response, "tool-e2e-message-bot", "message_bot", { to, message: "hello from the fixture" });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-message-bot") {
    text(response, `message_bot answered: ${typeof latestToolResult.result === "string" ? latestToolResult.result : JSON.stringify(latestToolResult.result)}`);
    return finish(response);
  }
  // A bot imported from a HUI template with open points: its first turn greets and starts on them.
  if (source.includes("[HUI bot created]") && source.includes("from: template") && source.includes("Not agreed yet")) {
    text(response, "Hi! I came from a template someone shared. First thing to agree: which repositories should I watch for pull requests?");
    return finish(response);
  }
  // An imported bot's first turn, which HUI starts to send its template's opener: the opener, as written.
  if (source.includes("[HUI bot created]") && source.includes("Your template opens with the message below")) {
    const opener = "and reply with that message only.";
    const blocks = Array.isArray(body.messages?.at(-1)?.content) ? body.messages.at(-1).content : [];
    const said = blocks.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
    text(response, said.slice(said.lastIndexOf(opener) + opener.length).trim());
    return finish(response);
  }
  // A new bot's first turn, which HUI starts: the first conversation's opening question. A bot still called
  // "New Bot", whose soul section says it has no name yet, asks what to call it first, as its prompt tells it to.
  if (source.includes("[HUI bot created]")) {
    text(response, flattenedText(body.system).includes("You have no name yet")
      ? "Hi, I'm new here and I don't have a name yet. What would you like to call me?"
      : "Hi, I'm new here. What would you like me to look after for you?");
    return finish(response);
  }
  // A bot saving its own SOUL.md with its write_soul tool.
  if (source.includes("E2E_WRITE_SOUL")) {
    toolUse(response, "tool-e2e-write-soul", "write_soul", { soul: "# Who I am\nE2E_SOUL_TEXT: a terse fixture bot.\n" });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-write-soul") {
    text(response, "I wrote my SOUL.md. To change it, just tell me.");
    return finish(response);
  }
  // A bot naming itself with set_profile, as the operator said.
  if (source.includes("E2E_SET_PROFILE")) {
    toolUse(response, "tool-e2e-set-profile", "set_profile", { name: "Echo", title: "Fixture tester" });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-set-profile") {
    text(response, `set_profile answered: ${typeof latestToolResult.result === "string" ? latestToolResult.result : JSON.stringify(latestToolResult.result)}`);
    return finish(response);
  }
  // A bot scheduling itself with its routines tool, "every 5 minutes until #82 is green": a temporary routine, every 5
  // minutes for at most 3 runs or 3 hours. That routine's own turn (its prompt carries E2E_ROUTINE_DONE) removes it.
  if (String(latestToolResult?.id ?? "").startsWith("tool-e2e-routine-")) {
    text(response, `routines answered: ${typeof latestToolResult.result === "string" ? latestToolResult.result : JSON.stringify(latestToolResult.result)}`);
    return finish(response);
  }
  if (source.includes("E2E_ROUTINE_DONE")) {
    toolUse(response, "tool-e2e-routine-remove", "routines", { action: "remove", routine: "Watch #82" });
    return finish(response, "tool_use");
  }
  if (source.includes("E2E_ROUTINE_ADD")) {
    toolUse(response, "tool-e2e-routine-add", "routines", {
      action: "add", name: "Watch #82", prompt: "E2E_ROUTINE_DONE Check whether PR #82 is green, and remove this routine once it is.",
      every: "5m", until: new Date(Date.now() + 3 * 3_600_000).toISOString(), runs: 3,
    });
    return finish(response, "tool_use");
  }

  if (source.includes("E2E_SHARED_TERMINAL")) {
    toolUse(response, "tool-terminal-list", "terminal", { action: "list" });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-terminal-list") {
    const terminal = latestToolResult.result?.terminals?.[0];
    if (!terminal) { text(response, "No shared terminal was opened."); return finish(response); }
    toolUse(response, "tool-terminal-read", "terminal", { action: "read", sessionId: terminal.id });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-terminal-read") {
    toolUse(response, "tool-terminal-input", "terminal", { action: "input", sessionId: latestToolResult.result.terminal.id, data: "printf '%s%s\\n' PI_SHARED_ TERMINAL; printf 'Shared variable: %s\\n' \"$shared_from_user\"\r" });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-terminal-input") {
    text(response, "I sent the command to your shared terminal. The output appears in the same panel; your shell state is preserved.");
    return finish(response);
  }

  // A real PI browser tool call against HUI's managed headless browser:
  // open the fixture page, type into the field found in the snapshot, click,
  // read the text page JavaScript rendered, then capture a screenshot.
  if (source.includes("E2E_BROWSER") && !source.includes("Name this coding-agent session")) {
    if (!(Array.isArray(body.tools) ? body.tools : []).some((tool) => tool?.name === "browser")) {
      text(response, "The browser tool is not available in this session.");
      return finish(response);
    }
    await browserPace(body);
    toolUse(response, "tool-e2e-browser-open", "browser", { action: "open", url: `http://127.0.0.1:${port}/browser-fixture` });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id?.startsWith("tool-e2e-browser-")) {
    await browserPace(body);
    const snapshots = toolResultTexts(body.messages).join("\n");
    const ref = (pattern) => pattern.exec(snapshots)?.[1];
    const step = latestToolResult.id.slice("tool-e2e-browser-".length);
    const next = {
      open: ["type", { action: "act", kind: "type", ref: ref(/textbox "Name" \[ref=(e\d+)\]/u), text: "HUI agent" }],
      type: ["click", { action: "act", kind: "click", ref: ref(/button "Greet" \[ref=(e\d+)\]/u) }],
      click: ["text", { action: "text", selector: "#greeting" }],
      text: ["screenshot", { action: "screenshot" }],
    }[step];
    if (next && (next[1].action !== "act" || next[1].ref)) {
      toolUse(response, `tool-e2e-browser-${next[0]}`, "browser", next[1]);
      return finish(response, "tool_use");
    }
    const greeting = /Hello, [^\n]*/u.exec(snapshots)?.[0];
    text(response, greeting
      ? `The headless browser rendered: **${greeting}**\n\nI opened the fixture page, typed into the Name field, clicked Greet and captured a screenshot, all without a browser window.`
      : `The browser fixture did not reach the expected state after ${step}.`);
    return finish(response);
  }

  if (source.includes("E2E_CODE_PARITY")) {
    text(response, `\`\`\`unknown\n${Array.from({ length: 10 }, (_, index) => `line ${index + 1}: ${"fixture ".repeat(24)}`).join("\n")}\n\`\`\``);
    return finish(response);
  }

  if (source.includes("E2E_FILE_LINKS")) {
    text(response, [
      "I looked at `src/lib/greeting.ts:3`, `README.md` and the folder `docs/`; the filler ends at `src/lib/greeting.ts#L58`.",
      "",
      "`src/lib/missing.ts` and `notes/todo.md:12` do not exist; run `npm test`, call `greet()` and keep version `1.2.3`.",
      "",
      "See [the design notes](docs/design.md#L2), [a missing page](docs/missing.md) and [the website](https://example.com/docs/design.md).",
      "",
      "```ts",
      "import { greet } from \"./src/lib/greeting.ts\";",
      "```",
    ].join("\n"));
    return finish(response);
  }

  if (source.includes("E2E_MARKDOWN_PARITY")) {
    text(response, "# Markdown parity\n\nParagraph with **bold**, *emphasis*, ~~removed~~, `inline code` and [a link](https://example.com).\n\n## Subheading\n\n- First item\n- Second item\n\n1. First ordered\n2. Second ordered\n\n> A quoted paragraph.\n> Its second line.\n\n---\n\n```text\nfixture code\nsecond line\n```\n\nFinal paragraph.");
    return finish(response);
  }

  if (source.includes("E2E_RICH_EMBEDS")) {
    text(response, "# Model the idea\n\n```mermaid\nflowchart LR\n  Idea[Idea] --> Model{Useful model}\n  Model -->|yes| Explain[Explain clearly]\n  Model -->|no| Prose[Use concise prose]\n```\n\n## Compare the evidence\n\n```chart\n{\"$schema\":\"https://vega.github.io/schema/vega-lite/v6.json\",\"title\":\"Clarity by format\",\"width\":\"container\",\"height\":220,\"data\":{\"values\":[{\"format\":\"Prose\",\"score\":48},{\"format\":\"Diagram\",\"score\":82},{\"format\":\"Chart\",\"score\":91}]},\"mark\":{\"type\":\"bar\",\"cornerRadiusEnd\":4},\"encoding\":{\"x\":{\"field\":\"format\",\"type\":\"nominal\",\"axis\":{\"labelAngle\":0}},\"y\":{\"field\":\"score\",\"type\":\"quantitative\",\"scale\":{\"domain\":[0,100]}},\"color\":{\"field\":\"format\",\"legend\":null}}}\n```\n\nInline identity: $e^{i\\pi}+1=0$.\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\n> [!TIP]\n> Pick the smallest visual model that makes the relationship obvious.\n\nhttps://x.com/jack/status/20\n\n[This labeled X link stays a link](https://x.com/jack/status/20)");
    return finish(response);
  }

  if (source.includes("https://acme.slack.com/archives/C01234567/p1723456789012345")) {
    text(response, "https://app.slack.com/client/T01234567/C01234567");
    return finish(response);
  }

  if (source.includes("E2E_PRESENT_MEDIA")) {
    toolUse(response, "tool-e2e-present-media", "present_media", {
      paths: [
        `${workspace}/media-sample.png`,
        `${workspace}/media-sample.mp4`,
        `${workspace}/media-sample.mp3`,
        `${workspace}/media-notes.pdf`,
      ],
    });
    return finish(response, "tool_use");
  }

  if (latestToolResult?.id === "tool-e2e-present-media") {
    text(response, "The image, video, audio and download are attached above using HUI's media contract.");
    return finish(response);
  }

  // show_widget. E2E_SHOW_WIDGET shows `widget.html` from the workspace, titled
  // by `widget-title.txt`, or the built-in counter; E2E_WIDGET_PROBE shows the
  // committed sandbox probe; E2E_WIDGET_SYNTAX first sends a script with a
  // syntax error, then the fixed counter once HUI rejects it. Session-naming
  // requests quote the prompt and are left to their own branches below.
  const naming = source.includes("Generate a concise session title") || source.includes("Name this coding-agent session");
  if (!naming && source.includes("E2E_WIDGET_PROBE")) {
    toolUse(response, "tool-e2e-widget", "show_widget", { title: "Sandbox probe", widget_code: await readFile(new URL("./widget-probe.html", import.meta.url), "utf8") });
    return finish(response, "tool_use");
  }
  if (!naming && source.includes("E2E_WIDGET_SYNTAX")) {
    toolUse(response, "tool-e2e-widget-broken", "show_widget", { title: "Counter", widget_code: COUNTER_WIDGET.replace("count += 1;", "count += ;") });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-widget-broken") {
    toolUse(response, "tool-e2e-widget", "show_widget", { title: "Counter", widget_code: COUNTER_WIDGET });
    return finish(response, "tool_use");
  }
  if (!naming && source.includes("E2E_SHOW_WIDGET")) {
    const code = await optionalFile(`${workspace}/widget.html`);
    const title = (await optionalFile(`${workspace}/widget-title.txt`))?.trim() || (code ? "Fixture widget" : "Counter");
    toolUse(response, "tool-e2e-widget", "show_widget", { title, widget_code: code ?? COUNTER_WIDGET });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-widget") {
    text(response, "The widget is shown above. It runs in HUI's sandbox, so I cannot see what you do in it.");
    return finish(response);
  }

  // secret_request. E2E_SECRET_REQUEST asks the operator for a secret; once it
  // is provided, a real bash call reads the file and prints only its length,
  // so the value itself never reaches this provider, then deletes the file.
  if (!naming && source.includes("E2E_SECRET_REQUEST")) {
    toolUse(response, "tool-e2e-secret", "secret_request", { label: "Fixture API key", reason: "The fixture proves an agent can use a secret without seeing it." });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-secret") {
    const path = /It is in (\S+) until/u.exec(String(latestToolResult.result))?.[1];
    if (!path) { text(response, `No secret to use: ${latestToolResult.result}`); return finish(response); }
    toolUse(response, "tool-e2e-secret-use", "bash", { command: `printf 'Secret length: %s\\n' "$(wc -c < '${path}' | tr -d ' ')" && rm '${path}'` });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-secret-use") {
    text(response, "I used the secret in a command without seeing it, then deleted its file.");
    return finish(response);
  }

  if (source.includes("[HUI subagent completion event]") && source.includes("E2E_STEERING_CHILD")) {
    text(response, "Parent incorporated the child result through steering.");
    return finish(response);
  }
  if (latestToolResult?.id === "tool-e2e-steering-spawn") {
    toolUse(response, "tool-e2e-steering-parent-work", "bash", {
      command: `curl --silent --show-error --noproxy '*' --fail http://127.0.0.1:${port}/control/wait-subagent-parent`,
      timeout: 120,
    });
    return finish(response, "tool_use");
  }
  if (source.includes("E2E_STEERING_CHILD")) {
    const complete = () => {
      text(response, "Child steering result ready.");
      finish(response);
    };
    if (subagentParentWaiting) complete();
    else subagentSteeringWaiters.add(complete);
    response.on("close", () => subagentSteeringWaiters.delete(complete));
    return;
  }
  if (source.includes("E2E_SUBAGENTS_STEERING")) {
    subagentParentWaiting = false;
    toolUse(response, "tool-e2e-steering-spawn", "sessions_spawn", {
      task: "E2E_STEERING_CHILD",
      label: "Steering researcher",
    });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-subagent-spawn") {
    text(response, "Subagent started in its own session.");
    return finish(response);
  }
  if (source.includes("[HUI subagent completion event]")) {
    const count = /count: (\d+)/.exec(source)?.[1] ?? "1";
    text(response, `Parent reviewed ${count} subagent result(s) against the task and continued on its own.`);
    return finish(response);
  }
  if (source.includes("E2E_SUBAGENTS_COORDINATE")) {
    toolUse(response, "tool-e2e-sessions-list", "sessions_list", {});
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-sessions-list") {
    const sessions = latestToolResult.result?.sessions ?? [];
    const child = sessions.find((session) => session.parentSessionKey || session.subagentStatus);
    if (!child?.sessionKey) {
      text(response, "No child session was visible.");
      return finish(response);
    }
    toolUse(response, "tool-e2e-sessions-history", "sessions_history", {
      sessionKey: child.sessionKey,
      limit: 20,
    });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-sessions-history") {
    const sessionKey = latestToolResult.result?.sessionKey;
    toolUse(response, "tool-e2e-sessions-send", "sessions_send", {
      sessionKey,
      message: "E2E_CROSS_SESSION",
      timeoutSeconds: 10,
    });
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-sessions-send") {
    text(response, `Coordination complete: ${latestToolResult.result?.reply ?? "no reply"}`);
    return finish(response);
  }
  // Inter-session prompts include the sender title. Check the payload before
  // the title-based launch fixture so a parent named E2E_SUBAGENTS_START does
  // not make its child spawn another agent.
  if (source.includes("E2E_CROSS_SESSION")) {
    text(response, "Cross-session reply from child.");
    return finish(response);
  }
  if (source.includes("E2E_SUBAGENTS_MULTI")) {
    toolUse(response, "tool-e2e-subagent-a", "sessions_spawn", { task: "E2E_SUBAGENT_CHILD quick", label: "Quick researcher" }, 0);
    toolUse(response, "tool-e2e-subagent-b", "sessions_spawn", { task: "E2E_SUBAGENT_CHILD_SLOW", label: "Slow verifier" }, 1);
    return finish(response, "tool_use");
  }
  if (source.includes("E2E_SUBAGENT_CHILD_SLOW")) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    text(response, "Slow verifier result: all checks passed.");
    return finish(response);
  }
  if (source.includes("E2E_SUBAGENTS_START")) {
    toolUse(response, "tool-e2e-subagent-spawn", "sessions_spawn", {
      task: "E2E_SUBAGENT_CHILD",
      label: "Fixture researcher",
    });
    return finish(response, "tool_use");
  }
  if (source.includes("E2E_SUBAGENT_CHILD")) {
    text(response, "Subagent child result: the fixture contract is working.");
    return finish(response);
  }
  // A tool result means PI has completed the real tool call and is asking the
  // fixture for the final assistant message.
  if (latestToolResult?.id === "tool-e2e-suggest-b" || latestToolResult?.id === "tool-e2e-suggest-a") {
    text(response, "I flagged two follow-ups as suggestion cards instead of doing them now.");
    return finish(response);
  }
  // Text, a tool call, then the final answer, in one turn.
  if (!naming && source.includes("E2E_MIDTURN_MESSAGE")) {
    text(response, "**What to check** for the checkout alert\n\n1. Is the error rate up on every host or only a few? Look at the [service dashboard](https://example.com/dashboard/checkout).\n2. Any new error patterns in the [error logs](https://example.com/logs?query=status%3Aerror).", 0);
    toolUse(response, "tool-e2e-midturn", "read", { path: `${workspace}/fixture.txt` }, 1);
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id === "tool-e2e-midturn") {
    text(response, "Started two helpers in the background; I'll report when they're back.");
    return finish(response);
  }
  if (source.includes("tool_result")) {
    text(response, "# Tool complete\n\n- output received\n- **Markdown verified**\n\n```text\nfixture-ok\n```\n\n| Check | Result |\n| --- | --- |\n| Tool | Passed |");
    return finish(response);
  }
  if (source.includes("Draft a Jira work item")) {
    // Utility-model draft for the Jira create dialog: picks CI-1 when offered.
    // "Docs cleanup" names a key outside the candidates to show that state.
    const parent = source.includes("SESSION TITLE: Docs cleanup") ? "DOCS-7" : source.includes("CI-1 | Epic") ? "CI-1" : "";
    const description = "## Context\n\nThe retry wrapper in `ci/run.sh` hides flaky failures.\n\n## Scope\n\n- Surface the first failure\n- Keep one retry for network errors\n\n## Acceptance criteria\n\n- Flaky jobs report the original error\n- Retries are logged with their cause";
    text(response, JSON.stringify({ summary: "Surface flaky CI failures instead of retrying silently", description, parent }));
    return finish(response);
  }
  if (source.includes("Name this coding-agent session and its Git branch")) {
    // Utility-model names for a new worktree session without an operator
    // branch name: a descriptive title plus a branch HUI must strip of its prefix.
    // A prompt containing E2E_HOLD_NAMING waits for POST
    // /control/release-replay, so a check can observe "Naming worktree".
    if (source.includes("E2E_HOLD_NAMING")) {
      const released = await new Promise((resolve) => {
        const release = () => { replayWaiters.delete(release); resolve(true); };
        replayWaiters.add(release);
        response.once("close", () => { replayWaiters.delete(release); resolve(false); });
        signalReplayReady();
      });
      if (!released) return;
    }
    text(response, "Title: Improve session naming\nBranch: feature/improve-session-naming");
    return finish(response);
  }
  if (source.includes("Generate a concise session title (3-6 words, max 60 characters)")) {
    // E2E_HOLD_NAMING waits for POST /control/release-replay, so a check can
    // see a plain session open under its provisional title before this answer.
    if (source.includes("E2E_HOLD_NAMING")) {
      const released = await new Promise((resolve) => {
        const release = () => { replayWaiters.delete(release); resolve(true); };
        replayWaiters.add(release);
        response.once("close", () => { replayWaiters.delete(release); resolve(false); });
        signalReplayReady();
      });
      if (!released) return;
    }
    text(response, "Improve session naming");
    return finish(response);
  }
  if (source.includes("Name the Git branch")) {
    // Utility-model worktree name for the backlog start dialog, deliberately
    // with a prefix, type word and Jira key that HUI must strip. A task titled
    // with E2E_HOLD_BRANCH waits for POST /control/release-replay, so a check
    // can type its own name before this late suggestion arrives.
    if (source.includes("E2E_HOLD_BRANCH")) {
      const released = await new Promise((resolve) => {
        const release = () => { replayWaiters.delete(release); resolve(true); };
        replayWaiters.add(release);
        response.once("close", () => { replayWaiters.delete(release); resolve(false); });
        signalReplayReady();
      });
      if (!released) return;
    }
    text(response, "feature/CI-2-fix-rate-limit-jira-proxy");
    return finish(response);
  }
  if (source.includes("E2E_PULL_REQUEST")) {
    // Prints a PR URL from a command HUI recognizes as `gh pr create`, so the
    // session row gets a pull request badge without touching GitHub.
    const input = { command: "printf '%s\\n' 'https://github.com/hui-e2e/fixture/pull/7' # gh pr create", timeout: 120 };
    event(response, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-e2e-pull-request", name: "bash", input: {} } });
    event(response, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    event(response, { type: "content_block_stop", index: 0 });
    return finish(response, "tool_use");
  }
  if (source.includes("E2E_PRINT_ENV")) {
    // The HUI and PI directories and HUI-held secrets an agent shell inherits, if any.
    const input = { command: "env | grep -E '^(HUI_CONFIG_DIR|HUI_DURABLE_DIR|PI_CODING_AGENT_DIR|HUI_SECRET_[0-9A-F]+|HUI_WORKER_SECRETS)=' ; echo env-done", timeout: 120 };
    event(response, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-e2e-env", name: "bash", input: {} } });
    event(response, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    event(response, { type: "content_block_stop", index: 0 });
    return finish(response, "tool_use");
  }
  if (source.includes("E2E_COMMAND")) {
    const command = source.includes("E2E_COMMAND_RUNNING")
      ? `curl --silent --show-error --noproxy '*' --fail http://127.0.0.1:${port}/control/wait-command`
      : source.includes("E2E_COMMAND_FAILURE") ? "false" : "printf '%s\\n' 'command fixture' 42 | head -n 2";
    const input = { command, timeout: 120 };
    event(response, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-e2e-command", name: "bash", input: {} } });
    event(response, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    event(response, { type: "content_block_stop", index: 0 });
    return finish(response, "tool_use");
  }
  // OptChat's own tools on the conversation's first two messages, and on a line that does not exist.
  if (source.includes("E2E_ZOOM")) {
    toolUse(response, "tool-e2e-zoom-message", "zoom", { id: 0, n: 1 }, 0);
    toolUse(response, "tool-e2e-zoom-lines", "zoom", { id: 0, n: 2 }, 1);
    toolUse(response, "tool-e2e-zoom-missing", "zoom", { id: 1, n: 2 }, 2);
    toolUse(response, "tool-e2e-date", "date", { id: 0 }, 3);
    return finish(response, "tool_use");
  }
  if (latestToolResult?.id?.startsWith("tool-e2e-watcher-")) {
    text(response, "Watchers are running; HUI shows them in this conversation.");
    return finish(response);
  }
  if (source.includes("E2E_WATCHER")) {
    toolUse(response, "tool-e2e-watcher-quick", "watcher", {
      action: "start",
      purpose: "Post /merge when approved",
      target: "https://github.com/ddoghq/web-ui/pull/21532",
      outcome: "post /merge",
      command: "printf 'posted /merge\\n'",
    }, 0);
    toolUse(response, "tool-e2e-watcher-long", "watcher", {
      action: "start",
      purpose: "Wait for #21532 review signals",
      command: "printf 'watching #21532\\n'; sleep 600",
    }, 1);
    return finish(response, "tool_use");
  }
  // A tool a PI extension registers, which only exists when the runtime loaded it.
  if (source.includes("E2E_EXTENSION_TOOL")) {
    toolUse(response, "tool-e2e-extension", "fixture_echo", { text: "from the model" });
    return finish(response, "tool_use");
  }
  if (source.includes("E2E_SUGGEST_TASK")) {
    toolUse(response, "tool-e2e-suggest-a", "suggest_task", {
      title: "Replace native terminal switcher select with HUI picker",
      problem: "The terminal pane header in `src/components/terminal-pane.ts` still switches terminals with a native `<select>`. It renders the browser's own dropdown, so it looks different from every other HUI picker and ignores the theme.",
      fix: "Render the switcher with `renderPicker` from `src/views/settings-picker.ts`, as the panel selector already does, and cover keyboard selection with a focused test.",
    }, 0);
    toolUse(response, "tool-e2e-suggest-b", "suggest_task", {
      title: "Investigate transcript jump after reconnect",
      problem: "After the event stream reconnects, the transcript sometimes scrolls back to the top even though auto-follow was on. Seen twice with long sessions; not reproduced on demand yet.",
    }, 1);
    return finish(response, "tool_use");
  }
  if (source.includes("E2E_PROGRESS") || source.includes("E2E_CLEAR_PROGRESS")) {
    const input = source.includes("E2E_CLEAR_PROGRESS")
      ? { markdown: "", plan: [] }
      : { markdown: "**Browser fixture** · real PI tool signal", plan: [
          { step: "Read fixture", status: "completed" },
          { step: "Verify presentation", status: "in_progress" },
        ] };
    event(response, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-e2e-progress", name: "progress_card", input: {} } });
    event(response, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    event(response, { type: "content_block_stop", index: 0 });
    return finish(response, "tool_use");
  }
  if (source.includes("E2E_RICH") || source.includes("E2E_TOOL_FAILURE")) {
    event(response, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
    event(response, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspecting the fixture." } });
    event(response, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "e2e-signature" } });
    event(response, { type: "content_block_stop", index: 0 });
    const path = source.includes("E2E_TOOL_FAILURE") ? `${workspace}/missing.txt` : `${workspace}/fixture.txt`;
    event(response, { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-e2e-1", name: "read", input: {} } });
    event(response, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path }) } });
    event(response, { type: "content_block_stop", index: 1 });
    return finish(response, "tool_use");
  }
  if (source.includes("E2E_ABORT")) {
    event(response, { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } });
    event(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Abort prefix" } });
    request.on("close", () => response.end());
    return;
  }
  if (source.includes("E2E_REPLAY")) {
    event(response, { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } });
    event(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Replay prefix — " } });
    if (!(await heldUntilRelease(response))) return;
    event(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "replay suffix" } });
    event(response, { type: "content_block_stop", index: 0 });
    return finish(response);
  }

  // PI's compaction summarizer; a distinct reply shows where the summary lands.
  // E2E_SLOW_COMPACT in the conversation holds it until POST
  // /control/release-replay, so a check can watch, queue into or cancel it.
  if (flattenedText(body.system).includes("context summarization assistant")) {
    if (source.includes("E2E_SLOW_COMPACT") && !(await heldUntilRelease(response))) return;
    text(response, "FIXTURE_SUMMARY");
    return finish(response);
  }
  // Attachment requests reach this branch. The request log is the proof that
  // PI, not merely HUI's HTTP boundary, received the image/file-expanded input.
  text(response, source.includes("image") ? "Attachment received by PI." : "Fixture response.");
  finish(response);
}).listen(port, "127.0.0.1", () => {
  port = server.address().port;
  process.stdout.write(`HUI E2E provider: http://127.0.0.1:${port}/v1\n`);
});
