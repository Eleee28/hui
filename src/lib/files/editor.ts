/**
 * The Files view's text editor: CodeMirror 6 themed from HUI's tokens, with the file's language loaded on demand.
 * The Files view imports this module dynamically, so CodeMirror stays out of the main bundle until a text file
 * opens; the languages themselves are in `code-languages.ts`, shared with the Diff view's highlighting. Colors are
 * CSS variables, so the editor follows theme and light/dark changes without being rebuilt.
 *
 * The extension set and highlight mapping follow AgentsInTheCloud's file editor (packages/files/src/client,
 * MIT, see THIRD_PARTY_NOTICES.md).
 */
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { FileTextChange } from "../editable-text.ts";
import { loadLanguage } from "../code-languages.ts";
import { fileLanguage } from "./languages.ts";

/** Token colors come from the same variables that color Markdown code blocks in the chat. */
const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword, tags.definitionKeyword], color: "var(--hljs-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: "var(--hljs-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--hljs-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.meta, tags.processingInstruction, tags.annotation], color: "var(--hljs-meta)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.propertyName), tags.heading, tags.labelName], color: "var(--hljs-title)" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName, tags.self], color: "var(--hljs-type)" },
  { tag: [tags.attributeName, tags.propertyName], color: "var(--hljs-attribute)" },
  { tag: tags.inserted, color: "var(--hljs-addition)" },
  { tag: tags.deleted, color: "var(--hljs-deletion)" },
  { tag: [tags.link, tags.url], color: "var(--link)", textDecoration: "underline" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "var(--bg)",
    fontSize: "var(--hui-files-editor-font-size, 13px)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono, var(--font-mono, ui-monospace, monospace))", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--text-strong, var(--text))", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-strong, var(--text))" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--selection-bg, color-mix(in srgb, var(--accent) 28%, transparent))",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--bg-hover) 55%, transparent)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--muted)", borderRight: "1px solid var(--border)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--bg-hover) 55%, transparent)", color: "var(--text)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", cursor: "pointer" },
  ".cm-matchingBracket, .cm-nonmatchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)", outline: "none" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 14%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 30%, transparent)", outline: "1px solid color-mix(in srgb, var(--warn) 60%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--warn) 55%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--bg-elevated, var(--panel))", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel input, .cm-panel button, .cm-panel label": { font: "inherit", fontSize: "12px", color: "inherit" },
  ".cm-textfield": { backgroundColor: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm, 4px)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm, 4px)" },
  ".cm-tooltip": { backgroundColor: "var(--popover, var(--bg-elevated))", color: "var(--popover-foreground, var(--text))", border: "1px solid var(--border)", borderRadius: "var(--radius-md, 6px)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--menu-selected, var(--bg-hover))", color: "var(--text-strong, var(--text))" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--muted)" },
  ".cm-line.cm-hui-target-line": { backgroundColor: "color-mix(in srgb, var(--accent) 16%, transparent)", boxShadow: "inset 2px 0 0 var(--accent)" },
});

/** The line a file reference in the chat pointed at, highlighted until the text changes or another line is shown. */
const setTargetLine = StateEffect.define<number | null>();
const targetLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = transaction.docChanged ? Decoration.none : decorations;
    for (const effect of transaction.effects) {
      if (!effect.is(setTargetLine)) continue;
      next = effect.value === null
        ? Decoration.none
        : Decoration.set([Decoration.line({ class: "cm-hui-target-line" }).range(transaction.state.doc.line(effect.value).from)]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export type FileEditorOptions = {
  parent: HTMLElement;
  text: string;
  path: string;
  readOnly: boolean;
  /** Editor changes in ascending order, offsets into the previous editor text. Not called for `setText`. */
  onChange(changes: FileTextChange[]): void;
  /** Mod-S: save now. */
  onSave(): void;
};

export type FileEditorHandle = {
  /** Replaces the whole text (a reload or another view's edit) without reporting it as an edit. */
  setText(text: string): void;
  text(): string;
  setReadOnly(readOnly: boolean): void;
  focus(): void;
  /** Re-measures after the editor was hidden. */
  refresh(): void;
  /** Scrolls to a 1-based line (clamped to the file), puts the cursor there and highlights the line. */
  revealLine(line: number, column?: number): void;
  destroy(): void;
};

export async function createFileEditor(options: FileEditorOptions): Promise<FileEditorHandle> {
  const language = await loadLanguage(fileLanguage(options.path));
  const editable = new Compartment();
  let applying = false;
  const editableState = (readOnly: boolean) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        targetLine,
        syntaxHighlighting(highlightStyle),
        theme,
        language,
        fileLanguage(options.path) === "markdown" || fileLanguage(options.path) === "plain" ? EditorView.lineWrapping : [],
        editable.of(editableState(options.readOnly)),
        EditorView.contentAttributes.of({ "aria-label": `Contents of ${options.path}` }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || applying) return;
          const changes: FileTextChange[] = [];
          update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
            changes.push({ from, to, insert: inserted.toString() });
          });
          options.onChange(changes);
        }),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => { options.onSave(); return true; } },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
      ],
    }),
  });
  return {
    setText(text) {
      if (view.state.doc.toString() === text) return;
      applying = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      } finally {
        applying = false;
      }
    },
    text: () => view.state.doc.toString(),
    setReadOnly(readOnly) {
      view.dispatch({ effects: editable.reconfigure(editableState(readOnly)) });
    },
    focus: () => view.focus(),
    refresh: () => view.requestMeasure(),
    revealLine(line, column) {
      const doc = view.state.doc;
      const number = Math.min(Math.max(1, Math.trunc(line)), doc.lines);
      const target = doc.line(number);
      const position = Math.min(target.from + Math.max(0, Math.trunc(column ?? 1) - 1), target.to);
      view.dispatch({
        selection: { anchor: position },
        effects: [setTargetLine.of(number), EditorView.scrollIntoView(position, { y: "center" })],
      });
    },
    destroy: () => view.destroy(),
  };
}
