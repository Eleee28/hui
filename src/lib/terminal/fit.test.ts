import assert from "node:assert/strict";
import { test } from "vitest";
import { prepareReflow, ptyResize, skipHiddenFits, wrappedRowsAbove } from "./fit.ts";

const host = { clientWidth: 800, clientHeight: 600 };
const sent = { cols: 80, rows: 24 };

test("a changed, valid grid on a measurable host resizes the PTY", () => {
  assert.deepEqual(ptyResize(host, { cols: 100, rows: 30 }, sent), { cols: 100, rows: 30 });
  assert.deepEqual(ptyResize(host, { cols: 900, rows: 400 }, sent), { cols: 500, rows: 300 }, "clamped to the gateway's limits");
});

test("an unchanged grid, a hidden host or an unusable grid sends nothing", () => {
  assert.equal(ptyResize(host, { cols: 80, rows: 24 }, sent), undefined);
  assert.equal(ptyResize({ clientWidth: 0, clientHeight: 0 }, { cols: 100, rows: 30 }, sent), undefined);
  assert.equal(ptyResize({ clientWidth: 800, clientHeight: 0 }, { cols: 100, rows: 30 }, sent), undefined);
  assert.equal(ptyResize(null, { cols: 100, rows: 30 }, sent), undefined);
  assert.equal(ptyResize(host, { cols: 1, rows: 30 }, sent), undefined);
  assert.equal(ptyResize(host, { cols: 100, rows: 0 }, sent), undefined);
  assert.equal(ptyResize(host, { cols: Number.NaN, rows: 30 }, sent), undefined);
});

/** A stand-in with Gespenst's shape: its own ResizeObserver calls `this.resize()` and setFont calls `this.fit()`. */
class FakeTerminal {
  calls: string[] = [];
  resize(cols?: number, rows?: number) { this.calls.push(cols === undefined ? "fit-by-resize" : `resize ${cols}x${rows}`); }
  fit() { this.calls.push("fit"); }
  observe() { this.resize(); }
  setFont() { this.fit(); }
}

test("a hidden host never refits the grid, but explicit PTY sizes still apply", () => {
  const terminal = new FakeTerminal();
  let size = { clientWidth: 0, clientHeight: 0 };
  skipHiddenFits(terminal, () => size);
  terminal.observe();
  terminal.setFont();
  terminal.fit();
  terminal.resize(120, 40);
  assert.deepEqual(terminal.calls, ["resize 120x40"]);
  size = host;
  terminal.observe();
  terminal.setFont();
  assert.deepEqual(terminal.calls, ["resize 120x40", "fit-by-resize", "fit"]);
});

test("the cursor's soft-wrapped line is found from the rows read around it", () => {
  const rows = [
    { index: 40, wrapContinuation: false }, // earlier output
    { index: 41, wrapContinuation: false }, // the prompt's first row
    { index: 42, wrapContinuation: true },
    { index: 43, wrapContinuation: true }, // the cursor's row
  ];
  assert.equal(wrappedRowsAbove(rows, 43), 2);
  assert.equal(wrappedRowsAbove(rows, 41), 0);
  assert.equal(wrappedRowsAbove(rows.slice(2), 43), 2, "a continuation row's predecessor belongs to the line even when it was not read");
});

/**
 * Replays what a shell does after SIGWINCH on a terminal that already reflowed its line: bash moves down to its old
 * last row, back up to its old first row (zsh and fish just move up by the cursor's old row) and redraws there.
 * Returns the row the redraw starts on, relative to the reflowed line's first row.
 */
function shellRedrawRow(line: { rowsAbove: number; cursorColumn: number; cols: number; text: string }, oldCols: number, prepared: string, bash: boolean): number {
  // The cursor after the prepared output: rows below the line start (the screen has room below in these cases).
  let row = line.rowsAbove;
  for (const [, count, command] of prepared.matchAll(/\u001b\[(\d*)([AJ])|\n/gu)) {
    if (command === "A") row -= Number(count || 1);
  }
  row += (prepared.match(/\n/gu) ?? []).length;
  const offset = Math.max(line.rowsAbove * line.cols + line.cursorColumn, 0);
  const oldCursorRow = Math.floor(offset / oldCols);
  const oldLastRow = Math.max(Math.floor(Math.max(0, Math.max([...line.text].length, offset) - 1) / oldCols), oldCursorRow);
  if (bash) row += oldLastRow - oldCursorRow - oldLastRow;
  else row -= oldCursorRow;
  return row;
}

test("a prompt is redrawn exactly over its reflowed copy, whether the width shrank or grew", () => {
  const prompt = "[dani@geekom:/tmp/hui-visual-mokDi8/workspace]$ ";
  // Shrank 67 → 37: the one-row prompt now takes two rows and the cursor sits on the second.
  const narrow = { rowsAbove: 1, cursorColumn: prompt.length - 37, cols: 37, text: prompt.trimEnd() };
  const shrink = prepareReflow(narrow, 67);
  assert.equal(shrink, "\r\u001b[1A\u001b[J");
  for (const bash of [true, false]) assert.equal(shellRedrawRow(narrow, 67, shrink, bash), 0, "no broken copy above");
  // Grew 37 → 67: the two-row prompt is one row again; the shell still believes its cursor is on its second row.
  const wide = { rowsAbove: 0, cursorColumn: prompt.length, cols: 67, text: prompt.trimEnd() };
  const grow = prepareReflow(wide, 37);
  assert.equal(grow, "\r\u001b[J\n");
  for (const bash of [true, false]) assert.equal(shellRedrawRow(wide, 37, grow, bash), 0, "the output above is not overwritten");
});

test("typed input past the cursor gives bash room to move down to its old last row", () => {
  // 30 columns of prompt and input on one 80-column row, cursor at column 5; the PTY was 10 columns wide.
  const line = { rowsAbove: 0, cursorColumn: 5, cols: 80, text: "x".repeat(30) };
  const prepared = prepareReflow(line, 10);
  assert.equal(prepared, "\r\u001b[J\n\n\u001b[2A", "down to the old last row (2), back up to the old cursor row (0)");
  for (const bash of [true, false]) assert.equal(shellRedrawRow(line, 10, prepared, bash), 0);
});

test("an empty line under a running program needs no movement", () => {
  assert.equal(prepareReflow({ rowsAbove: 0, cursorColumn: 0, cols: 80, text: "" }, 120), "\r\u001b[J");
});
