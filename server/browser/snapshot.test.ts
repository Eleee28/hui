import assert from "node:assert/strict";
import { test } from "vitest";
import { renderSnapshot, SnapshotRefs, SNAPSHOT_MAX_CHARS, clampSnapshotChars, type AxNode } from "./snapshot.ts";

let nextId = 0;
type Spec = { role: string; name?: string; value?: string; ignored?: boolean; backend?: number; props?: Record<string, unknown>; children?: Spec[] };

/** Builds a Chrome-shaped flat AX node list from a nested description. */
function tree(spec: Spec, parentId?: string): AxNode[] {
  const nodeId = String(++nextId);
  const children = (spec.children ?? []).map((child) => tree(child, nodeId));
  const node: AxNode = {
    nodeId,
    ...(parentId ? { parentId } : {}),
    ...(spec.ignored ? { ignored: true } : {}),
    role: { type: "role", value: spec.role },
    ...(spec.name !== undefined ? { name: { type: "computedString", value: spec.name } } : {}),
    ...(spec.value !== undefined ? { value: { type: "string", value: spec.value } } : {}),
    properties: Object.entries(spec.props ?? {}).map(([name, value]) => ({ name, value: { type: "unknown", value } })),
    childIds: children.map((list) => list[0]!.nodeId),
    ...(spec.backend !== undefined ? { backendDOMNodeId: spec.backend } : {}),
  };
  return [node, ...children.flat()];
}

const text = (name: string): Spec => ({ role: "StaticText", name, children: [{ role: "InlineTextBox", name }] });

function page(): AxNode[] {
  return tree({ role: "RootWebArea", name: "Fixture", backend: 1, props: { focusable: true, url: "http://127.0.0.1:9/" }, children: [{
    role: "generic", backend: 2, children: [
      { role: "heading", name: "Browser fixture", backend: 3, props: { level: 1 }, children: [text("Browser fixture")] },
      { role: "paragraph", backend: 4, children: [text("Hello "), { role: "strong", children: [text("world")] }, text(" paragraph.")] },
      { role: "LabelText", backend: 5, children: [text("Name "), {
        role: "textbox", name: "Name", value: "Alex", backend: 6, props: { focusable: true, editable: "plaintext" },
        children: [{ role: "generic", backend: 7, props: { editable: "plaintext" }, children: [text("Alex")] }],
      }] },
      { role: "button", name: "Greet", backend: 8, props: { focusable: true }, children: [text("Greet")] },
      { role: "link", name: "Next page", backend: 9, props: { focusable: true, url: "http://127.0.0.1:9/next" }, children: [text("Next page")] },
      { role: "link", name: "Elsewhere", backend: 10, props: { focusable: true, url: "https://example.com/a?b=1" }, children: [text("Elsewhere")] },
      { role: "combobox", name: "Color", value: "Red", backend: 11, props: { focusable: true, expanded: false }, children: [{
        role: "MenuListPopup", children: [
          { role: "option", name: "Red", backend: 12, props: { selected: true } },
          { role: "option", name: "Blue", backend: 13, props: { selected: false } },
        ],
      }] },
      { role: "checkbox", name: "Remember me", backend: 14, props: { focusable: true, checked: "true", disabled: true } },
      { role: "generic", backend: 15, props: { focusable: true }, children: [text("Custom focusable")] },
      { role: "status", backend: 16, props: { live: "polite" } },
      { role: "none", ignored: true, children: [{ role: "paragraph", backend: 17, children: [text("Inside an ignored wrapper")] }] },
      { role: "list", backend: 18, children: [{ role: "listitem", backend: 19, children: [{ role: "ListMarker", name: "• " }, text("First")] }] },
      { role: "separator", backend: 20 },
    ],
  }] });
}

test("renders the role outline with refs only on interactive elements", () => {
  const refs = new SnapshotRefs();
  const result = renderSnapshot(page(), refs, { pageUrl: "http://127.0.0.1:9/" });
  assert.equal(result.text, [
    "- heading \"Browser fixture\" [level=1]",
    "- paragraph: Hello world paragraph.",
    "- text: Name",
    "- textbox \"Name\" [ref=e1]: Alex",
    "- button \"Greet\" [ref=e2]",
    "- link \"Next page\" [ref=e3] [url=/next]",
    "- link \"Elsewhere\" [ref=e4] [url=https://example.com/a?b=1]",
    "- combobox \"Color\" [ref=e5]: Red",
    "  - MenuListPopup",
    "    - option \"Red\" [ref=e6] [selected]",
    "    - option \"Blue\" [ref=e7]",
    "- checkbox \"Remember me\" [ref=e8] [checked] [disabled]",
    "- generic [ref=e9]: Custom focusable",
    "- paragraph: Inside an ignored wrapper",
    "- list",
    "  - listitem: First",
    "- separator",
  ].join("\n"));
  assert.equal(result.truncated, false);
  assert.equal(result.lines, 17);
  assert.deepEqual(refs.target("e2"), { backendNodeId: 8, role: "button", name: "Greet" });
  assert.equal(refs.target("e1")?.backendNodeId, 6);
  assert.equal(refs.size, 9);
});

test("refs stay stable within a document and are never reused after it changes", () => {
  const refs = new SnapshotRefs();
  renderSnapshot(page(), refs);
  const again = renderSnapshot(page(), refs);
  assert.match(again.text, /button "Greet" \[ref=e2\]/u);
  refs.reset();
  assert.equal(refs.target("e2"), undefined);
  const next = renderSnapshot(page(), refs);
  assert.doesNotMatch(next.text, /\[ref=e2\]/u);
  assert.match(next.text, /button "Greet" \[ref=e11\]/u);
});

test("interactive, query and character limits narrow the output explicitly", () => {
  const interactive = renderSnapshot(page(), new SnapshotRefs(), { interactive: true });
  assert.deepEqual(interactive.text.split("\n"), [
    "- textbox \"Name\" [ref=e1]: Alex",
    "- button \"Greet\" [ref=e2]",
    "- link \"Next page\" [ref=e3] [url=http://127.0.0.1:9/next]",
    "- link \"Elsewhere\" [ref=e4] [url=https://example.com/a?b=1]",
    "- combobox \"Color\" [ref=e5]: Red",
    "- option \"Red\" [ref=e6] [selected]",
    "- option \"Blue\" [ref=e7]",
    "- checkbox \"Remember me\" [ref=e8] [checked] [disabled]",
    "- generic [ref=e9]: Custom focusable",
  ]);
  const query = renderSnapshot(page(), new SnapshotRefs(), { query: "LINK next" });
  assert.equal(query.matched, 1);
  assert.match(query.text, /^- link "Next page"/u);
  const many = tree({ role: "RootWebArea", children: Array.from({ length: 400 }, (_, index) => ({ role: "button", name: `Button ${index}`, backend: 1_000 + index })) });
  const truncated = renderSnapshot(many, new SnapshotRefs(), { maxChars: 500 });
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.text.length <= 500);
  assert.ok(truncated.text.endsWith("]"), "truncation happens at a line boundary");
  assert.equal(clampSnapshotChars(10), 500);
  assert.equal(clampSnapshotChars(1e9), SNAPSHOT_MAX_CHARS);
  assert.equal(clampSnapshotChars("x"), 12_000);
});

test("malformed trees, cycles and long names stay bounded", () => {
  const cyclic: AxNode[] = [
    { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
    { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "A ".repeat(200) }, backendDOMNodeId: 5, childIds: ["1", "missing"] },
  ];
  const result = renderSnapshot(cyclic, new SnapshotRefs());
  assert.equal(result.lines, 1);
  assert.ok(result.text.length < 200);
  assert.match(result.text, /…" \[ref=e1\]$/u);
  assert.equal(renderSnapshot([], new SnapshotRefs()).text, "");
});
