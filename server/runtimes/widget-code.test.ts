import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { findWidgetScriptSyntaxError, validateWidget, WIDGET_CODE_MAX_BYTES, WIDGET_TITLE_MAX_LENGTH, WidgetInputError } from "./widget-code.mjs";
import showWidgetExtension from "./show-widget-extension.mjs";
import { huiToolDefinitions } from "./hui-tools.ts";
import fixture from "../agent-tools/widget-sandbox.fixture.json";

const rejects = (params: unknown, pattern: RegExp) => assert.rejects(validateWidget(params), (error: unknown) => {
  assert(error instanceof WidgetInputError);
  assert.match(error.message, pattern);
  return true;
});

test("the PI-loadable validator keeps the portable widget limits", () => {
  assert.equal(WIDGET_CODE_MAX_BYTES, fixture.codeMaxBytes);
  assert.equal(WIDGET_TITLE_MAX_LENGTH, fixture.titleMaxLength);
});

test("a fragment with a valid script is accepted and normalized", async () => {
  const code = "<div id=a>0</div><script>document.getElementById('a').textContent = String(1 + 1);</script>";
  assert.deepEqual(await validateWidget({ title: "  Sum  ", widget_code: code }), { title: "Sum", code, mode: "html", bytes: Buffer.byteLength(code) });
  assert.equal((await validateWidget({ title: "Dial", widget_code: "\n <svg viewBox='0 0 10 10'><circle r='4' cx='5' cy='5'/></svg>" })).mode, "svg");
});

test("calls without a title or markup are refused with what to send instead", async () => {
  await rejects({ title: " ", widget_code: "<p>x</p>" }, /title is required/u);
  await rejects({ title: "x".repeat(WIDGET_TITLE_MAX_LENGTH + 1), widget_code: "<p>x</p>" }, /shorten it/u);
  await rejects({ title: "T", widget_code: "  " }, /send the HTML or SVG fragment itself/u);
  await rejects({ title: "T", widget_code: "./widget.html" }, /not a file path, Markdown fence or prose/u);
  await rejects({ title: "T", widget_code: "```html\n<p>x</p>\n```" }, /not a file path, Markdown fence or prose/u);
});

test("a full document is refused: HUI supplies the document", async () => {
  for (const code of ["<!DOCTYPE html><p>x</p>", "<html><body>x</body></html>", " <head></head>", "<body>x</body>"]) {
    await rejects({ title: "T", widget_code: code }, /not a full document/u);
  }
});

test("the size limit counts UTF-8 bytes", async () => {
  await validateWidget({ title: "T", widget_code: `<p>${"x".repeat(WIDGET_CODE_MAX_BYTES - 7)}</p>` });
  await rejects({ title: "T", widget_code: `<p>${"é".repeat(WIDGET_CODE_MAX_BYTES / 2)}</p>` }, /the limit is 256 KiB/u);
});

test("a classic script syntax error is located in the widget code itself", async () => {
  const code = "<p>Sum</p>\n<script>\n  const a = 1;\n  total(a,\n    2;\n</script>";
  await rejects({ title: "T", widget_code: code }, /inline script 1 at line 5, column 5: missing \) after argument list\. Offending line: 2; Fix the script and call show_widget again\./u);
  assert.deepEqual(await findWidgetScriptSyntaxError(code), { scriptIndex: 1, message: "missing ) after argument list", line: 5, column: 5, snippet: "2;" });
});

test("module scripts are parsed as modules, outside the gateway's own context", async () => {
  await validateWidget({ title: "T", widget_code: "<div></div><script type=module>import * as d3 from 'https://esm.sh/d3@7.9.0'; await Promise.resolve(); console.log(import.meta.url, d3);</script>" });
  assert.deepEqual(await findWidgetScriptSyntaxError("<div></div>\n<script type=\"module\">\nimport x from 'https://esm.sh/x';\nexport const y = ;\n</script>"), {
    scriptIndex: 1, message: "Unexpected token ';'", line: 4, column: 18, snippet: "export const y = ;",
  });
  // Top-level await is a module feature only.
  assert.equal((await findWidgetScriptSyntaxError("<script>await 1</script>"))?.line, 1);
});

test("external, data and non-JavaScript scripts are not parsed, but count in the script index", async () => {
  const code = "<script src=\"https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js\">ignored (</script><script type=\"application/json\">{ not js</script><script type=importmap>{</script><script>broken(</script>";
  // The error sits at the end of the fourth script's own body, not of the document.
  const end = code.indexOf("broken(") + "broken(".length;
  assert.deepEqual(await findWidgetScriptSyntaxError(code), { scriptIndex: 4, message: "Unexpected end of input", line: 1, column: end + 1, snippet: code.slice(0, 160) });
  assert.equal(await findWidgetScriptSyntaxError("<script type='text/plain'>(</script><script type='text/JavaScript'>ok()</script>"), undefined);
});

test("markup that only looks like a script is not parsed", async () => {
  assert.equal(await findWidgetScriptSyntaxError("<!-- <script>(</script> --><textarea><script>(</script></textarea><p title='<script>('>x</p>"), undefined);
});

test("comments end where the browser ends them, so the scripts after them are parsed", async () => {
  for (const comment of ["<!-- x --!>", "<!-->", "<!--->", "<!-- a -- b -->"]) {
    assert.equal((await findWidgetScriptSyntaxError(`${comment}<script>broken(</script>`))?.scriptIndex, 1, comment);
  }
  // Inside a script, "--!>" does not end escaped data: the script still closes at its own end tag.
  assert.equal(await findWidgetScriptSyntaxError("<script>const s = '<!-- --!>'; console.log(s)</script>"), undefined);
});

test("SVG scripts may wrap their code in CDATA", async () => {
  assert.equal(await findWidgetScriptSyntaxError("<svg viewBox='0 0 10 10'><script><![CDATA[ if (1 < 2) console.log('ok'); ]]></script></svg>"), undefined);
  assert.equal((await findWidgetScriptSyntaxError("<svg><script><![CDATA[ if (1 < 2) { ]]></script></svg>"))?.message, "Unexpected end of input");
});

test("show_widget records the accepted call and tells the model where it is", async () => {
  const tools: ToolDefinition[] = [];
  showWidgetExtension({ registerTool: (tool) => { tools.push(tool); } });
  const [tool] = tools;
  assert.equal(tool?.name, "show_widget");
  assert.match(tool!.promptGuidelines!.join("\n"), /never a full document/u);
  const result = await tool!.execute("call-1", { title: "Counter", widget_code: "<button>+1</button>" } as never, undefined, undefined, undefined as never);
  assert.deepEqual(result.details, { widget: { version: 1, title: "Counter", mode: "html", bytes: 19 } });
  assert.match((result.content[0] as { text: string }).text, /^Showing "Counter" inline in the HUI chat \(HTML, 1 KiB\)\. It runs sandboxed/u);
  await assert.rejects(tool!.execute("call-2", { title: "Counter", widget_code: "<script>(</script>" } as never, undefined, undefined, undefined as never), WidgetInputError);
});

test("every HUI runtime offers show_widget", () => {
  assert(huiToolDefinitions().some((tool) => tool.name === "show_widget"));
  assert(huiToolDefinitions({ browser: false }).some((tool) => tool.name === "show_widget"));
});
