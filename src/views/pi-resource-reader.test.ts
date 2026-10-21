import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const source = readFileSync(new URL("./pi-resource-reader.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");

test("resource reader exposes loading, error, markdown and source states", () => {
  assert.match(source, /state\.status === "loading"/);
  assert.match(source, /state\.status === "error"/);
  assert.match(source, /renderMarkdown\(document\.content\)/);
  assert.match(source, /pi-resource-reader__source/);
  assert.match(source, /first 256 KiB/);
  assert.match(source, /Copy \$\{document\.fileName\}/);
  assert.match(source, /state\.copied \? icons\.check : icons\.copy/);
});

test("resource reader is a responsive native modal", () => {
  assert.match(source, /class="hui-modal-dialog pi-resource-reader-modal"/);
  assert.match(source, /aria-labelledby="pi-resource-reader-title"/);
  assert.match(css, /\.pi-resource-reader-modal\s*\{[^}]*width:\s*min\(920px/s);
  assert.match(css, /\.pi-resource-reader-modal\s*\{[^}]*--openclaw-modal-height-limit:\s*calc\(100dvh - 48px\)/s);
  assert.match(css, /\.pi-resource-reader-modal \.md-preview-dialog__title\s*\{[^}]*margin:\s*0/s);
  assert.match(css, /\.pi-resource-reader-modal \.md-preview-dialog__meta\s*\{[^}]*padding-block:\s*12px/s);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.pi-resource-reader-modal\s*\{[^}]*calc\(100vw - 16px\)/s);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.pi-resource-reader-modal\s*\{[^}]*--openclaw-modal-height-limit:\s*90dvh/s);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.pi-resource-reader-modal \.md-preview-dialog__header\s*\{[^}]*flex-direction:\s*row/s);
});
