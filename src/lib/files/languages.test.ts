import assert from "node:assert/strict";
import { test } from "vitest";
import { fileLanguage } from "./languages.ts";

test("files get their language from their name", () => {
  assert.equal(fileLanguage("src/components/files-view.ts"), "typescript");
  assert.equal(fileLanguage("App.TSX"), "tsx");
  assert.equal(fileLanguage("index.mjs"), "javascript");
  assert.equal(fileLanguage("package.json"), "json");
  assert.equal(fileLanguage("README.md"), "markdown");
  assert.equal(fileLanguage("scripts/run.sh"), "shell");
  assert.equal(fileLanguage("flake.nix"), "shell");
  assert.equal(fileLanguage(".github/workflows/ci.yml"), "yaml");
  assert.equal(fileLanguage("Cargo.toml"), "toml");
  assert.equal(fileLanguage("Dockerfile"), "dockerfile");
  assert.equal(fileLanguage("Dockerfile.dev"), "dockerfile");
  assert.equal(fileLanguage(".env.local"), "properties");
  assert.equal(fileLanguage("Makefile"), "shell");
  assert.equal(fileLanguage("logo.svg"), "xml");
  assert.equal(fileLanguage("LICENSE"), "plain");
  assert.equal(fileLanguage("notes.unknown"), "plain");
});
