/**
 * Reading one file's unified patch (Git's hunks, as `/__hui/sessions/:id/diff…` sends them) into lines the Diff view
 * draws: each line's kind and old/new line numbers, a missing final newline, and CRLF endings, plus the pairing of
 * removed and added runs for the side-by-side layout. Pure, so it is tested without a DOM.
 */

export type DiffLineKind = "context" | "add" | "del";

export type DiffLine = {
  kind: DiffLineKind;
  /** The text without its prefix and without a trailing carriage return. */
  text: string;
  oldNumber?: number;
  newNumber?: number;
  /** The line ended in CRLF. */
  cr?: true;
  /** Git's "\ No newline at end of file" follows this line. */
  noNewline?: true;
};

export type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The function or section Git names after the second `@@`, if any. */
  section: string;
  lines: DiffLine[];
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/u;

/** The hunks of a patch. Lines outside a hunk (Git's headers, a stray message) are ignored. */
export function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldNumber = 0;
  let newNumber = 0;
  let last: DiffLine | undefined;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const raw of lines) {
    const header = HUNK.exec(raw);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        section: header[5]?.trim() ?? "",
        lines: [],
      };
      hunks.push(current);
      oldNumber = current.oldStart;
      newNumber = current.newStart;
      last = undefined;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("\\")) {
      if (last) last.noNewline = true;
      continue;
    }
    const prefix = raw[0];
    let body = raw.slice(1);
    const cr = body.endsWith("\r");
    if (cr) body = body.slice(0, -1);
    let line: DiffLine;
    if (prefix === "+") line = { kind: "add", text: body, newNumber: newNumber++ };
    else if (prefix === "-") line = { kind: "del", text: body, oldNumber: oldNumber++ };
    // An empty line is an empty context line whose space was trimmed along the way.
    else if (prefix === " " || raw === "") line = { kind: "context", text: body, oldNumber: oldNumber++, newNumber: newNumber++ };
    else continue;
    if (cr) line.cr = true;
    current.lines.push(line);
    last = line;
  }
  return hunks;
}

/** A row of the side-by-side layout: the old line on the left, the new one on the right (either may be missing). */
export type SplitRow = { left?: DiffLine; right?: DiffLine };

/** Pairs each run of removed lines with the added run after it, row by row; context lines sit on both sides. */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      const row: SplitRow = {};
      if (removed[index]) row.left = removed[index];
      if (added[index]) row.right = added[index];
      rows.push(row);
    }
    removed = [];
    added = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "del") {
      if (added.length) flush();
      removed.push(line);
    } else if (line.kind === "add") added.push(line);
    else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

/** Lines in a patch, the measure for collapsing a large one. */
export function patchLineCount(patch: string): number {
  if (!patch) return 0;
  let count = 1;
  for (let index = patch.indexOf("\n"); index >= 0; index = patch.indexOf("\n", index + 1)) count++;
  return patch.endsWith("\n") ? count - 1 : count;
}

/** Whether some changed lines end in CRLF and others do not, so the view marks line endings. */
export function mixedLineEndings(hunks: readonly DiffHunk[]): boolean {
  let withCr = false;
  let without = false;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.cr) withCr = true;
      else without = true;
      if (withCr && without) return true;
    }
  }
  return false;
}
