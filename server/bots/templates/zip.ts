/**
 * The little of ZIP that bot templates need: reading an archive someone picked (an OpenClaw workspace, a HUI export)
 * and writing HUI's export. Stored and deflated entries only, no ZIP64 and no encryption, with node:zlib doing the
 * deflating. Reading is bounded before anything is inflated (entries, declared sizes) and while inflating (each
 * entry's output), so an archive can't expand past `BOT_TEMPLATE_LIMITS`; every path is checked to stay inside the
 * archive.
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  override name = "ZipError";
}

export type ZipEntry = { path: string; data: Buffer };

export type ZipLimits = { files: number; totalBytes: number };

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** The end record, and the most of a comment that may follow it. */
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;

/** Whether `data` starts like a ZIP archive (an empty one included). */
export function isZip(data: Buffer): boolean {
  return data.length >= 4 && (data.readUInt32LE(0) === LOCAL || data.readUInt32LE(0) === END);
}

/**
 * A path inside an archive or a folder, as HUI keeps it: forward slashes, no leading slash, no empty, `.` or `..`
 * segment; undefined for one that would leave it (absolute, a drive, `..`) or holds a control character.
 */
export function safeRelativePath(raw: string): string | undefined {
  const path = raw.replaceAll("\\", "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || /\p{Cc}/u.test(path)) return undefined;
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) return undefined;
  return parts.join("/");
}

/** Archive litter from macOS and Windows that never belongs to a template. */
export function isArchiveLitter(path: string): boolean {
  return path.startsWith("__MACOSX/") || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/u.test(path);
}

function endRecord(data: Buffer): number {
  const lowest = Math.max(0, data.length - END_SIZE - MAX_COMMENT);
  for (let at = data.length - END_SIZE; at >= lowest; at -= 1) if (data.readUInt32LE(at) === END) return at;
  throw new ZipError("This file is not a ZIP archive, or it is damaged.");
}

/** Every file of an archive (folders and litter left out), each path checked; throws `ZipError` for anything else. */
export function readZip(data: Buffer, limits: ZipLimits): ZipEntry[] {
  const end = endRecord(data);
  const count = data.readUInt16LE(end + 10);
  const size = data.readUInt32LE(end + 12);
  const offset = data.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported: zip the folder again with a standard tool.");
  if (offset + size > end) throw new ZipError("This ZIP archive is damaged: its directory lies outside the file.");
  if (count > limits.files) throw new ZipError(`This archive holds ${count} entries; HUI takes at most ${limits.files}.`);
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || data.readUInt32LE(at) !== CENTRAL) throw new ZipError("This ZIP archive is damaged: its directory ends early.");
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const expectedCrc = data.readUInt32LE(at + 16);
    const compressed = data.readUInt32LE(at + 20);
    const uncompressed = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const rawName = data.subarray(at + 46, at + 46 + nameLength).toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
    at += 46 + nameLength + extraLength + commentLength;
    if (rawName.endsWith("/") || rawName.endsWith("\\")) continue;
    const path = safeRelativePath(rawName);
    if (!path) throw new ZipError(`This archive holds a file outside its own folder (${JSON.stringify(rawName.slice(0, 200))}); HUI does not unpack it.`);
    if (isArchiveLitter(path)) continue;
    if ((flags & 0x1) !== 0) throw new ZipError(`${path} is encrypted; HUI only reads unencrypted archives.`);
    if (method !== 0 && method !== 8) throw new ZipError(`${path} uses a compression HUI does not read (method ${method}); zip it again with a standard tool.`);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new ZipError("ZIP64 archives are not supported: zip the folder again with a standard tool.");
    total += uncompressed;
    if (total > limits.totalBytes) throw new ZipError(`This archive unpacks to more than ${Math.round(limits.totalBytes / 1024 / 1024)} MB; HUI takes at most that.`);
    if (local + 30 > data.length || data.readUInt32LE(local) !== LOCAL) throw new ZipError(`This ZIP archive is damaged: ${path} has no data.`);
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    if (start + compressed > data.length) throw new ZipError(`This ZIP archive is damaged: ${path} is cut short.`);
    const stored = data.subarray(start, start + compressed);
    let content: Buffer;
    try {
      // One byte more than declared: an entry that inflates past its size is refused, never followed.
      content = method === 0 ? Buffer.from(stored) : inflateRawSync(stored, { maxOutputLength: uncompressed + 1 });
    } catch {
      throw new ZipError(`This ZIP archive is damaged: ${path} could not be unpacked.`);
    }
    if (content.length !== uncompressed || (crc32(content) >>> 0) !== expectedCrc) throw new ZipError(`This ZIP archive is damaged: ${path} does not match its checksum.`);
    if (seen.has(path)) throw new ZipError(`This archive holds ${path} twice.`);
    seen.add(path);
    entries.push({ path, data: content });
  }
  return entries;
}

/** DOS date and time of `date`, local, as ZIP keeps them. */
function dosTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** An archive of `entries`, in order: deflated where that is smaller, UTF-8 names, dated `at`. */
export function writeZip(entries: readonly ZipEntry[], at: Date = new Date()): Buffer {
  const { time, date } = dosTime(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const path = safeRelativePath(entry.path);
    if (!path || path !== entry.path) throw new ZipError(`Not a path inside an archive: ${entry.path}`);
    const name = Buffer.from(path, "utf8");
    const deflated = deflateRawSync(entry.data);
    const method = deflated.length < entry.data.length ? 8 : 0;
    const body = method === 8 ? deflated : entry.data;
    const checksum = crc32(entry.data) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push(header, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Owner read and write, as HUI writes a bot's files.
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(END_SIZE);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
