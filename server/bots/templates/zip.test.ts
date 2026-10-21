import assert from "node:assert/strict";
import { test } from "vitest";
import { crc32, deflateSync } from "node:zlib";
import { isPng, pngTextChunks } from "./png.ts";
import { isZip, readZip, safeRelativePath, writeZip, ZipError } from "./zip.ts";

const LIMITS = { files: 100, totalBytes: 1024 * 1024 };

test("an archive HUI writes reads back whole, deflated or stored, with UTF-8 names", () => {
  const entries = [
    { path: "bot.json", data: Buffer.from(JSON.stringify({ hello: "world".repeat(50) })) },
    { path: "skills/señal/SKILL.md", data: Buffer.from("---\nname: señal\n---\nbody\n") },
    { path: "tiny", data: Buffer.from("x") },
  ];
  const zip = writeZip(entries, new Date(2026, 9, 7, 12, 30));
  assert.equal(isZip(zip), true);
  assert.deepEqual(readZip(zip, LIMITS).map((entry) => [entry.path, entry.data.toString()]), entries.map((entry) => [entry.path, entry.data.toString()]));
});

test("paths that would leave the archive are refused; folders and archive litter are skipped", () => {
  assert.equal(safeRelativePath("../etc/passwd"), undefined);
  assert.equal(safeRelativePath("/etc/passwd"), undefined);
  assert.equal(safeRelativePath("C:/Windows"), undefined);
  assert.equal(safeRelativePath("a/../../b"), undefined);
  assert.equal(safeRelativePath("a\\b\\SKILL.md"), "a/b/SKILL.md");
  assert.equal(safeRelativePath("./a/b"), "a/b");
  assert.equal(safeRelativePath("a/\u0007"), undefined);
  // writeZip refuses such a path itself, so the archive is built by patching a valid name of the same length.
  const zip = writeZip([{ path: "aa/evil", data: Buffer.from("x") }]);
  const patched = Buffer.from(zip.toString("latin1").replaceAll("aa/evil", "../evil"), "latin1");
  assert.throws(() => readZip(patched, LIMITS), (error: unknown) => error instanceof ZipError && /outside its own folder/u.test(error.message));
  const litter = writeZip([{ path: "__MACOSX/x", data: Buffer.from("x") }, { path: "w/.DS_Store", data: Buffer.from("x") }, { path: "w/SOUL.md", data: Buffer.from("soul") }]);
  assert.deepEqual(readZip(litter, LIMITS).map((entry) => entry.path), ["w/SOUL.md"]);
});

test("an archive is bounded before and while it unpacks: entries, declared sizes, sizes that lie, checksums", () => {
  const many = writeZip(Array.from({ length: 5 }, (_, index) => ({ path: `f${index}`, data: Buffer.from("x") })));
  assert.throws(() => readZip(many, { files: 4, totalBytes: 1024 }), /holds 5 entries; HUI takes at most 4/u);
  const big = writeZip([{ path: "big", data: Buffer.alloc(4096, 0x41) }]);
  assert.throws(() => readZip(big, { files: 10, totalBytes: 1024 }), /unpacks to more than/u);
  // A deflated entry that claims to be smaller than it inflates to is refused, not followed.
  const lying = Buffer.from(big);
  const central = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(10, central + 24);
  assert.throws(() => readZip(lying, LIMITS), /could not be unpacked|does not match its checksum/u);
  const corrupt = Buffer.from(writeZip([{ path: "a", data: Buffer.from("hello") }]));
  corrupt.writeUInt8(corrupt.readUInt8(32) ^ 0xff, 32);
  assert.throws(() => readZip(corrupt, LIMITS), ZipError);
  assert.throws(() => readZip(Buffer.from("not a zip"), LIMITS), /not a ZIP archive/u);
});

/** A PNG with the given chunks after its header, and IEND. */
function png(chunks: readonly [string, Buffer][]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", Buffer.alloc(13)), ...chunks.map(([type, data]) => chunk(type, data)), chunk("IEND", Buffer.alloc(0))]);
}

test("a PNG's text chunks come out by keyword: tEXt, zTXt and iTXt, compressed or not", () => {
  const image = png([
    ["tEXt", Buffer.from("chara\0abc", "latin1")],
    ["zTXt", Buffer.concat([Buffer.from("comment\0\0", "latin1"), deflateSync(Buffer.from("zipped"))])],
    ["iTXt", Buffer.concat([Buffer.from("ccv3\0\0\0en\0\0", "latin1"), Buffer.from("ünïcode", "utf8")])],
    ["iTXt", Buffer.concat([Buffer.from("packed\0\x01\0\0\0", "latin1"), deflateSync(Buffer.from("small", "utf8"))])],
    ["tEXt", Buffer.from("chara\0second", "latin1")],
  ]);
  assert.equal(isPng(image), true);
  const chunks = pngTextChunks(image);
  assert.equal(chunks.get("chara"), "abc", "the first of a keyword wins");
  assert.equal(chunks.get("comment"), "zipped");
  assert.equal(chunks.get("ccv3"), "ünïcode");
  assert.equal(chunks.get("packed"), "small");
  assert.equal(pngTextChunks(Buffer.from("nope")).size, 0);
});
