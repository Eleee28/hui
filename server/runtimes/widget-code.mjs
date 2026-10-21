/**
 * Validates a `show_widget` call before HUI records it. Plain dependency-free
 * ESM, so Durable, the PI SDK worker and the PI CLI extension run the same code.
 *
 * The inline-script scanner is ported from OpenClaw 2026.9.6
 * (src/canvas/widget-script-syntax.ts, MIT; see THIRD_PARTY_NOTICES.md). HUI
 * parses with V8 through node:vm instead of acorn: classic scripts compile in
 * place, module scripts in a short-lived worker, since vm.SourceTextModule
 * needs --experimental-vm-modules. Nothing is executed or linked.
 */
import vm from "node:vm";
import { Worker } from "node:worker_threads";

export const WIDGET_CODE_MAX_BYTES = 256 * 1024;
export const WIDGET_TITLE_MAX_LENGTH = 120;

/** A call the model can fix; its message becomes the failed tool result. */
export class WidgetInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "WidgetInputError";
  }
}

/** JavaScript MIME type essences per https://mimesniff.spec.whatwg.org/#javascript-mime-type. */
const JAVASCRIPT_MIME_ESSENCES = new Set([
  "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
  "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
  "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
  "text/x-ecmascript", "text/x-javascript",
]);
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function decodeAttribute(value) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/giu, (match, decimal, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    const point = decimal ? Number(decimal) : Number.parseInt(hex, 16);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

/** `script` or `module` for inline JavaScript; undefined for an external or data script. */
function scriptSourceType(attributes) {
  let type;
  for (const attribute of attributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu)) {
    const name = (attribute[1] ?? "").toLowerCase();
    if (name === "src") return undefined;
    if (name === "type") type ??= decodeAttribute(attribute[2] ?? attribute[3] ?? attribute[4] ?? "").trim().toLowerCase();
  }
  if (type === "module") return "module";
  return !type || JAVASCRIPT_MIME_ESSENCES.has(type) ? "script" : undefined;
}

/** A tag's closing bracket, without reading quoted attribute values as markup. */
function findTagEnd(html, offset) {
  let quote = "";
  for (let index = offset; index < html.length; index++) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return html.length;
}

/** End of the HTML comment opened at `start`: `-->`, the incorrectly closed
 * `--!>`, or the abruptly closed `<!-->` and `<!--->`, as the tokenizer reads them. */
function commentEnd(code, start) {
  if (code.startsWith(">", start + 4)) return start + 5;
  if (code.startsWith("->", start + 4)) return start + 6;
  for (let index = code.indexOf("--", start + 4); index >= 0; index = code.indexOf("--", index + 1)) {
    if (code[index + 2] === ">") return index + 3;
    if (code[index + 2] === "!" && code[index + 3] === ">") return index + 4;
  }
  return code.length;
}

/** Script-looking text in double-escaped data cannot close the script element;
 * inside foreign (SVG) content a CDATA section keeps everything up to `]]>`.
 * `--!>` is matched only to be ignored: it ends a comment, not escaped script data. */
function findRawTextEnd(html, start, name, foreign) {
  const tokens = name === "script"
    ? foreign ? /<!\[CDATA\[|\]\]>|<!--|--!?>|<\/?script(?=[\t\n\f\r />])/giu : /<!--|--!?>|<\/?script(?=[\t\n\f\r />])/giu
    : new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "giu");
  tokens.lastIndex = start;
  let state = "data";
  for (const match of html.matchAll(tokens)) {
    const token = match[0].toLowerCase();
    if (state === "cdata") {
      if (token === "]]>") state = "data";
    } else if (token === "<![cdata[") state = "cdata";
    else if (token === "<!--" && state === "data") state = "escaped";
    else if (token === "-->") state = "data";
    else if (token.startsWith("</")) {
      if (state !== "double-escaped") return match.index;
      state = "escaped";
    } else if (token === "<script" && state === "escaped") state = "double-escaped";
  }
  return html.length;
}

/**
 * Inline JavaScript blocks in document order, tracking HTML contexts over the
 * original input so offsets need no normalization. SVG support covers
 * CDATA-wrapped scripts, CDATA sections, self-closing foreign elements and
 * foreignObject switching back to HTML rules, as in OpenClaw.
 */
function* inlineScripts(code) {
  const tagPattern = /<\/?([a-z][^\t\n\f\r />]*)/iuy;
  let position = 0;
  let scriptIndex = 0;
  let svgDepth = 0;
  let foreignObjectDepth = 0;
  while (position < code.length) {
    const start = code.indexOf("<", position);
    if (start < 0) break;
    position = start + 1;
    if (code.startsWith("<!--", start)) {
      position = commentEnd(code, start);
      continue;
    }
    const foreign = svgDepth > 0 && foreignObjectDepth === 0;
    if (foreign && code.startsWith("<![CDATA[", start)) {
      const end = code.indexOf("]]>", start + 9);
      position = end < 0 ? code.length : end + 3;
      continue;
    }
    tagPattern.lastIndex = start;
    const tag = tagPattern.exec(code);
    if (!tag) {
      if (code[position] === "!" || code[position] === "/") position = findTagEnd(code, position + 1) + 1;
      continue;
    }
    const attributesStart = tagPattern.lastIndex;
    const tagEnd = findTagEnd(code, attributesStart);
    position = tagEnd + 1;
    if (tagEnd === code.length) continue;
    const name = (tag[1] ?? "").toLowerCase();
    const closing = code[start + 1] === "/";
    const selfClosing = code[tagEnd - 1] === "/";
    if (name === "svg") svgDepth = closing ? Math.max(0, svgDepth - 1) : svgDepth + (selfClosing ? 0 : 1);
    else if (name === "foreignobject" && svgDepth > 0) foreignObjectDepth = closing ? Math.max(0, foreignObjectDepth - 1) : foreignObjectDepth + (selfClosing ? 0 : 1);
    if (closing) continue;
    if (name === "plaintext") break;
    if (!/^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)$/u.test(name)) continue;
    if (foreign && selfClosing) continue;
    let bodyStart = position;
    const bodyEnd = findRawTextEnd(code, bodyStart, name, foreign);
    const closingBracket = bodyEnd < code.length ? code.indexOf(">", bodyEnd) : -1;
    position = closingBracket < 0 ? code.length : closingBracket + 1;
    if (name !== "script") continue;
    scriptIndex++;
    const sourceType = scriptSourceType(code.slice(attributesStart, tagEnd));
    if (!sourceType) continue;
    let body = code.slice(bodyStart, bodyEnd);
    const trimmed = body.trim();
    if (foreign && trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")) {
      bodyStart += body.length - body.trimStart().length + 9;
      body = trimmed.slice(9, -3);
    }
    yield { scriptIndex, sourceType, body, bodyStart };
  }
}

/** Node decorates a compile error's stack as `<file>:<line>`, the source line
 * and carets under the error; at the end of the input it pads with spaces only. */
function decoratedPosition(stack) {
  const lines = String(stack ?? "").split("\n");
  const head = /:(\d+)$/u.exec(lines[0] ?? "");
  if (!head) return undefined;
  const marker = lines[2] ?? "";
  const caret = marker.indexOf("^");
  return { line: Number(head[1]), column: caret >= 0 ? caret : /^[ \t]*$/u.test(marker) ? marker.length : 0 };
}

function failure(error) {
  return { message: String(error?.message ?? error).replace(/\s+/gu, " ").slice(0, 200), position: decoratedPosition(error?.stack) };
}

function classicSyntaxError(body) {
  try {
    new vm.Script(body, { filename: "widget-script.js" });
    return undefined;
  } catch (error) {
    return failure(error);
  }
}

const MODULE_PARSER = 'const { workerData } = require("node:worker_threads"); new (require("node:vm").SourceTextModule)(workerData, { identifier: "widget-module.mjs" });';

/** An uncaught compile error leaves the worker decorated with its position. A
 * worker that cannot start leaves the check to the browser's error notice. */
function moduleSyntaxError(body) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(MODULE_PARSER, {
        eval: true,
        workerData: body,
        execArgv: ["--experimental-vm-modules", "--no-warnings"],
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => { void worker.terminate(); resolve(undefined); }, 10_000);
    worker.once("error", (error) => { clearTimeout(timer); resolve(error?.name === "SyntaxError" ? failure(error) : undefined); });
    worker.once("exit", () => { clearTimeout(timer); resolve(undefined); });
  });
}

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/gu;

function lineStarts(text) {
  const starts = [0];
  for (const match of text.matchAll(LINE_BREAK)) starts.push(match.index + match[0].length);
  return starts;
}

/** 1-based line and column of `offset` in `text`. */
function lineAndColumn(text, offset) {
  const starts = lineStarts(text);
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= offset) line++;
  return { line: line + 1, column: offset - starts[line] + 1 };
}

/** The first inline JavaScript syntax error in `code`, located in `code` itself. */
export async function findWidgetScriptSyntaxError(code) {
  for (const script of inlineScripts(code)) {
    const error = script.sourceType === "module" ? await moduleSyntaxError(script.body) : classicSyntaxError(script.body);
    if (!error) continue;
    if (!error.position) return { scriptIndex: script.scriptIndex, message: error.message };
    const starts = lineStarts(script.body);
    const lineStart = starts[Math.min(Math.max(error.position.line, 1), starts.length) - 1] ?? 0;
    const offset = script.bodyStart + Math.min(lineStart + error.position.column, script.body.length);
    const { line, column } = lineAndColumn(code, offset);
    const lineStartInCode = offset - (column - 1);
    const snippet = (code.slice(lineStartInCode).split(/[\r\n\u2028\u2029]/u, 1)[0] ?? "").trim().slice(0, 160);
    return { scriptIndex: script.scriptIndex, message: error.message, line, column, snippet };
  }
  return undefined;
}

const kib = (bytes) => Math.max(1, Math.round(bytes / 1024));

/** Normalized call or a `WidgetInputError` telling the model what to fix. */
export async function validateWidget(params) {
  const title = typeof params?.title === "string" ? params.title.trim() : "";
  if (!title) throw new WidgetInputError("title is required: a short label for the widget card.");
  if ([...title].length > WIDGET_TITLE_MAX_LENGTH) throw new WidgetInputError(`title is longer than ${WIDGET_TITLE_MAX_LENGTH} characters; shorten it.`);
  const code = typeof params?.widget_code === "string" ? params.widget_code : "";
  if (!code.trim()) throw new WidgetInputError("widget_code is required: send the HTML or SVG fragment itself.");
  const bytes = Buffer.byteLength(code, "utf8");
  if (bytes > WIDGET_CODE_MAX_BYTES) {
    throw new WidgetInputError(`widget_code is ${kib(bytes)} KiB; the limit is 256 KiB. Aggregate the data, or load a library from an allowed CDN instead of inlining it.`);
  }
  const start = code.trimStart();
  if (/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/iu.test(start)) {
    throw new WidgetInputError("widget_code must be an HTML or SVG fragment, not a full document: drop <!doctype>, <html>, <head> and <body>. HUI supplies the document, theme and bridges.");
  }
  if (!start.startsWith("<")) {
    throw new WidgetInputError("widget_code must start with HTML or SVG markup: send the markup itself, not a file path, Markdown fence or prose.");
  }
  const error = await findWidgetScriptSyntaxError(code);
  if (error) {
    const where = error.line === undefined ? "" : ` at line ${error.line}, column ${error.column}`;
    const snippet = error.snippet ? ` Offending line: ${error.snippet}` : "";
    throw new WidgetInputError(`widget_code has a JavaScript syntax error in inline script ${error.scriptIndex}${where}: ${error.message}.${snippet} Fix the script and call show_widget again.`);
  }
  return { title, code, mode: /^<svg\b/iu.test(start) ? "svg" : "html", bytes };
}
