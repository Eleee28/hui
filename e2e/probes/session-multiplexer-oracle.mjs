// Compare against independently loaded OpenClaw 2026.9.5 shipped functions.
// Usage: node e2e/probes/session-multiplexer-oracle.mjs /path/to/dist/control-ui/assets
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import * as hui from "../../src/lib/session/multiplexer.ts";

const assets = process.argv[2];
if (!assets) throw new Error("Pass the installed OpenClaw 2026.9.5 assets directory.");
const selected = [];
for (const [file, names] of [
  ["control-ui-boot-shared-Bt2ZINpX.js", ["xs", "J", "ws", "Ts", "Y", "X", "Ds", "Os", "ks", "As", "Ms", "Ns", "Ps"]],
  ["control-ui-boot-chat-CLUFzlXZ.js", ["Un", "Wn"]],
]) {
  const source = readFileSync(join(assets, file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(functions.length, names.length, `Pinned reference changed: ${file}`);
  selected.push(...functions.map((node) => node.getText(ast)));
}
// Only primitive imported helpers are adapted; layout/drop functions above are
// executed verbatim, never copied from HUI or from expected test values.
const oracle = new Function(`"use strict";
const Fs=.15, L=.3;
const v = n => { if (!Number.isFinite(n) || n <= 0) throw Error("Invalid weight"); return n; };
const Ee = (id,prefix) => Number(id.slice(prefix.length)) || 0;
const me = weights => { const sum=weights.reduce((a,b)=>a+b,0); return weights.map(n=>n/sum); };
${selected.join("\n")}
return {xs,Ds,Os,ks,As,Ns,Ps,Un,Wn};`)();
const convert = (layout) => ({ ...layout, columns: layout.columns.map((column) => ({ ...column, panes: column.panes.map(({ id, sessionKey }) => ({ id, sessionId: sessionKey })) })) });
let actual = hui.singleSessionLayout("a");
let expected = oracle.xs("c1", "p1", "a");
let seed = 49171;
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
for (let i = 0; i < 1000; i++) {
  const panes = hui.sessionPanes(actual);
  const pane = panes[Math.floor(random() * panes.length)];
  const operation = panes.length < 3 ? 0 : panes.length > 12 ? 1 : Math.floor(random() * 6);
  if (operation === 0) {
    const direction = ["left", "right", "up", "down"][Math.floor(random() * 4)];
    const session = `session-${i % 5}`; // Duplicate sessions deliberately included.
    actual = hui.splitSessionPane(actual, pane.id, session, direction);
    expected = oracle.Ds(expected, pane.id, session, direction);
  } else if (operation === 1) {
    actual = hui.closeSessionPane(actual, pane.id);
    expected = oracle.Os(expected, pane.id);
  } else if (operation === 2) {
    actual = hui.focusSessionPane(actual, pane.id);
    expected = oracle.As(expected, pane.id);
  } else if (operation === 3) {
    actual = hui.replacePaneSession(actual, pane.id, `replacement-${i}`);
    expected = oracle.ks(expected, pane.id, `replacement-${i}`);
  } else if (operation === 4) {
    const index = Math.floor(random() * actual.columns.length);
    const ratio = random();
    actual = hui.resizeSessionLayout(actual, undefined, index, ratio);
    expected = oracle.Ns(expected, index, ratio);
  } else {
    const { column, paneIndex } = hui.locateSessionPane(actual, pane.id);
    const ratio = random();
    actual = hui.resizeSessionLayout(actual, column.id, paneIndex, ratio);
    expected = oracle.Ps(expected, column.id, paneIndex, ratio);
  }
  assert.deepEqual(actual, convert(expected), `layout operation ${i}`);
  assert.deepEqual(hui.parseSessionLayout(actual), actual);
}
const rect = { left: 73, top: 51, width: 820, height: 639 };
for (let x = 0; x <= 100; x++) for (let y = 0; y <= 100; y++) {
  const point = [rect, rect.left + rect.width * x / 100, rect.top + rect.height * y / 100];
  const zone = oracle.Un(...point);
  assert.deepEqual(hui.sessionDropZone(...point), zone);
  assert.deepEqual(hui.sessionDropRect(rect, zone), oracle.Wn(rect, zone));
}
console.log(JSON.stringify({ reference: "OpenClaw 2026.9.5 ec9c1a13", functionsSha256: createHash("sha256").update(selected.join("\n")).digest("hex"), layoutTransitions: 1000, dropPositions: 10201, result: "pass" }, null, 2));
