import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectTypeOf, test } from "vitest";
import { PiResourceDocument } from "../api/pi.ts";
import { expectSchema } from "../test-support/api-schema.ts";

type OriginalPiResourceDocument = {
  id: string;
  kind: "skill" | "package" | "extension";
  title: string;
  fileName: string;
  format: "markdown" | "code" | "json";
  content: string;
  truncated: boolean;
};

expectTypeOf<PiResourceDocument>().toEqualTypeOf<OriginalPiResourceDocument>();

import { readPiConfigAt } from "./config.ts";
import { PiResourceNotFoundError, readPiResourceDocumentAt } from "./resource-reader.ts";

async function fixture(): Promise<string> {
  const agentDir = await mkdtemp(join(tmpdir(), "hui-pi-reader-"));
  await mkdir(join(agentDir, "skills", "demo"), { recursive: true });
  await mkdir(join(agentDir, "demo-package"), { recursive: true });
  await writeFile(join(agentDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill.\n---\n\n# Demo skill\n", "utf8");
  await writeFile(join(agentDir, "demo-package", "README.md"), "# Demo package\n\nPackage documentation.\n", "utf8");
  await writeFile(join(agentDir, "extension.ts"), "export default function demo() {}\n", "utf8");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    packages: ["./demo-package"],
    extensions: ["./extension.ts"],
  }), "utf8");
  return agentDir;
}

test("reads an inventoried skill by opaque id", async () => {
  const agentDir = await fixture();
  try {
    const snapshot = await readPiConfigAt(agentDir);
    const skill = snapshot.skills.find((entry) => entry.name === "demo");
    assert(skill);
    const document = await readPiResourceDocumentAt(agentDir, "skill", skill.id);
    expectSchema(PiResourceDocument, document);
    assert.equal(document.title, "demo");
    assert.equal(document.fileName, "SKILL.md");
    assert.equal(document.format, "markdown");
    assert.match(document.content, /# Demo skill/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("the bundled generator is readable through its stable inventory id", async (t) => {
  const agentDir = await fixture();
  t.onTestFinished(() => rm(agentDir, { recursive: true, force: true }));
  const skill = (await readPiConfigAt(agentDir)).skills.find((entry) => entry.origin === "hui");
  assert(skill);
  const document = await readPiResourceDocumentAt(agentDir, "skill", skill.id);
  assert.equal(document.title, "create-verification-skill");
  assert.match(document.content, /name: create-verification-skill/u);
  assert.match(document.content, /good practices/u);
});

test("reads package documentation and direct extension source", async () => {
  const agentDir = await fixture();
  try {
    const snapshot = await readPiConfigAt(agentDir);
    const packageResource = snapshot.settings.resources.find((entry) => entry.kind === "package");
    const extensionResource = snapshot.settings.resources.find((entry) => entry.kind === "extension");
    assert(packageResource && extensionResource);

    const packageDocument = await readPiResourceDocumentAt(agentDir, "plugin", packageResource.id);
    expectSchema(PiResourceDocument, packageDocument);
    assert.equal(packageDocument.fileName, "README.md");
    assert.equal(packageDocument.format, "markdown");
    assert.match(packageDocument.content, /Package documentation/);

    const extensionDocument = await readPiResourceDocumentAt(agentDir, "plugin", extensionResource.id);
    expectSchema(PiResourceDocument, extensionDocument);
    assert.equal(extensionDocument.fileName, "extension.ts");
    assert.equal(extensionDocument.format, "code");
    assert.match(extensionDocument.content, /export default/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("rejects ids outside the current PI inventory", async () => {
  const agentDir = await fixture();
  try {
    await assert.rejects(
      readPiResourceDocumentAt(agentDir, "plugin", "000000000000000000000000"),
      PiResourceNotFoundError,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
