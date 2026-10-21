/**
 * A bot's own skills (HUI-18): `skills/<name>/SKILL.md` in its home folder, `BOTS_DIR/<id>` on the host that runs its chat,
 * with the files beside it (a template's scripts and references). Only that bot's chat loads them
 * (`DurableHost.skillDirsFor`), beside the skills of its directory; its Tools & skills page lists them with the rest, so
 * each can be turned off like any other. Imports write them and exports read them, through this port (a bot on a worker
 * goes through its host: `worker/host-bots.ts`).
 *
 * Writes never follow a link: a `skills` folder, a skill folder or a folder inside it that is a link is refused, and
 * every file is replaced atomically, owner-only, like SOUL.md (a script arrives without permission to run). Reads keep
 * to text: hidden files and folders, installed packages, caches, logs, links, binaries and oversized files stay behind,
 * each with the reason.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BOT_TEMPLATE_LIMITS, type BotTemplateSkillFile } from "./templates/formats.ts";
import { BOTS_DIR } from "./bots.ts";
import { caseClash, skillFilePath } from "./templates/common.ts";

/** The folder of a bot's own skills, inside its home. */
export const BOT_SKILLS_DIR = "skills";
/** A skill's folder name as PI's loader wants a skill's name. */
export const BOT_SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
/** The largest SKILL.md read back. */
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SKILLS = 200;
/** How deep a skill's folders are read. */
const MAX_DEPTH = 4;

/** One of a bot's own skills: its folder's name, its SKILL.md, the text files beside it and what was left out of them. */
export type BotOwnSkill = { name: string; text: string; files?: BotTemplateSkillFile[]; skipped?: { path: string; reason: string }[] };

export type BotSkillFiles = {
  /** Writes each skill's SKILL.md and files, making the folders it needs (owner-only). */
  write(botId: string, skills: readonly BotOwnSkill[]): Promise<void>;
  /** The bot's own skills, by name; none without the folder. */
  read(botId: string): Promise<BotOwnSkill[]>;
  /** Whether this machine keeps the files beside a SKILL.md (an older worker keeps SKILL.md only). */
  files: boolean;
};

/** Where a bot's own skills are, below its home folder. */
export function botSkillsDir(home: string): string {
  return join(home, BOT_SKILLS_DIR);
}

/** A folder that must be a real directory when it exists: a link (or a file) in its place is refused. */
async function realFolder(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing to write skills through ${path}: it is not a folder.`);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomically(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function why(name: string): string | undefined {
  if (name.startsWith(".")) return "a hidden file or folder";
  if (name === "node_modules" || name === "__pycache__") return "installed packages or a cache";
  if (name.endsWith(".log")) return "a log";
  return undefined;
}

/** The text files beside a SKILL.md, and what stays behind with the reason. */
async function folderFiles(directory: string): Promise<Pick<BotOwnSkill, "files" | "skipped">> {
  const files: BotTemplateSkillFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;
  const walk = async (folder: string, prefix: string, depth: number): Promise<void> => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path === "SKILL.md") continue;
      const reason = why(entry.name) ?? (entry.isSymbolicLink() ? "a link" : undefined);
      if (reason) {
        skipped.push({ path, reason });
        continue;
      }
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(join(folder, entry.name), path, depth + 1);
        else skipped.push({ path, reason: `deeper than ${MAX_DEPTH} folders` });
        continue;
      }
      if (!entry.isFile()) continue;
      const { size } = await lstat(join(folder, entry.name));
      const limit = files.length >= BOT_TEMPLATE_LIMITS.skillFiles ? `more than ${BOT_TEMPLATE_LIMITS.skillFiles} files`
        : size > BOT_TEMPLATE_LIMITS.skillFileBytes ? `larger than ${BOT_TEMPLATE_LIMITS.skillFileBytes / 1024} KB`
        : total + size > BOT_TEMPLATE_LIMITS.skillFilesBytes ? `past the skill's ${BOT_TEMPLATE_LIMITS.skillFilesBytes / 1024 / 1024} MB`
        : undefined;
      if (limit) {
        skipped.push({ path, reason: limit });
        continue;
      }
      const data = await readFile(join(folder, entry.name));
      let text: string | undefined;
      try {
        text = data.includes(0) ? undefined : UTF8.decode(data);
      } catch { /* not text */ }
      if (text === undefined) {
        skipped.push({ path, reason: "not text" });
        continue;
      }
      total += size;
      files.push({ path, text });
    }
  };
  await walk(directory, "", 0);
  return { ...(files.length ? { files } : {}), ...(skipped.length ? { skipped } : {}) };
}

export function localBotSkills(botsDir: string = BOTS_DIR): BotSkillFiles {
  const home = (botId: string) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/u.test(botId)) throw new Error("Not a bot id.");
    return join(botsDir, botId);
  };
  return {
    files: true,

    async write(botId, skills) {
      const folder = botSkillsDir(home(botId));
      for (const skill of skills) {
        if (!BOT_SKILL_NAME.test(skill.name)) throw new Error(`Not a skill name: ${JSON.stringify(skill.name)}.`);
        for (const file of skill.files ?? []) if (skillFilePath(file.path) !== file.path) throw new Error(`Not a file of a skill's folder: ${JSON.stringify(file.path)}.`);
        const clash = caseClash((skill.files ?? []).map((file) => file.path));
        if (clash) throw new Error(`Two files of skill ${skill.name} differ only by case: ${JSON.stringify(clash)}.`);
      }
      if (!skills.length) return;
      if (!await realFolder(home(botId))) await mkdir(home(botId), { recursive: true, mode: 0o700 });
      if (!await realFolder(folder)) await mkdir(folder, { mode: 0o700 });
      for (const skill of skills) {
        const directory = join(folder, skill.name);
        if (!await realFolder(directory)) await mkdir(directory, { mode: 0o700 });
        await writeAtomically(join(directory, "SKILL.md"), skill.text);
        for (const file of skill.files ?? []) {
          const parts = file.path.split("/");
          let inside = directory;
          for (const part of parts.slice(0, -1)) {
            inside = join(inside, part);
            if (!await realFolder(inside)) await mkdir(inside, { mode: 0o700 });
          }
          await writeAtomically(join(inside, parts.at(-1)!), file.text);
        }
      }
    },

    async read(botId) {
      const folder = botSkillsDir(home(botId));
      if (!await realFolder(folder).catch(() => false)) return [];
      const skills: BotOwnSkill[] = [];
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SKILLS)) {
        if (!entry.isDirectory() || !BOT_SKILL_NAME.test(entry.name)) continue;
        const file = join(folder, entry.name, "SKILL.md");
        const info = await lstat(file).catch(() => undefined);
        if (!info?.isFile() || info.size > MAX_SKILL_BYTES) continue;
        skills.push({ name: entry.name, text: await readFile(file, "utf8"), ...await folderFiles(join(folder, entry.name)) });
      }
      return skills;
    },
  };
}
