/**
 * Changes to PI's user configuration that HUI asks the `pi` CLI to make: installing and removing pi.dev
 * packages, and installing a skill from a URL through a cheap-model installer agent. PI owns those files and
 * HUI never edits them; this module validates the input, runs one mutation at a time and returns a fresh PI
 * snapshot.
 */
import { spawn } from "node:child_process";
import { piEnvironment } from "../runtimes/pi-environment.ts";
import { piCommand } from "../runtimes/pi-command.ts";

import {
  PI_AGENT_DIR,
  readConfiguredPackageSourcesAt,
  readPiConfig,
  safeSourceLabel,
  type PiSnapshot,
} from "./config.ts";

const PACKAGE_HOST = "pi.dev";
const PACKAGE_PREFIX = "/packages/";
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;
const MAX_URL_LENGTH = 2048;
const MAX_OUTPUT = 8_000;
const PACKAGE_TIMEOUT_MS = 120_000;
const SKILL_TIMEOUT_MS = 300_000;
const CHEAP_MODEL = /(haiku|flash|mini|nano|small|lite|luna|terra)/iu;

import type { PiMutationKind, PiMutationResult } from "../api/pi.ts";
export type { PiMutationKind, PiMutationResult } from "../api/pi.ts";

export class PiMutationInputError extends Error {
  override name = "PiMutationInputError";
}

export class PiMutationBusyError extends Error {
  override name = "PiMutationBusyError";
}

export class PiMutationCommandError extends Error {
  override name = "PiMutationCommandError";
}

export type PiCommandResult = { code: number; output: string };
export type PiCommandRunner = (
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<PiCommandResult>;

function safeOutput(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/giu, "https://[redacted]@")
    .replace(/([?&](?:token|key|signature|sig|credential)=)[^\s&]+/giu, "$1[redacted]")
    .trim()
    .slice(-MAX_OUTPUT);
}

export const runPiCommand: PiCommandRunner = (args, options) =>
  new Promise((resolve, reject) => {
    const cli = piCommand(args);
    const child = spawn(cli.command, cli.args, {
      cwd: options.cwd,
      env: piEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let killTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
      reject(new PiMutationCommandError("PI operation timed out."));
    }, options.timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new PiMutationCommandError(`Could not start PI: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? 1, output: safeOutput(output) });
    });
  });

export function packageSourceFromCatalogUrl(value: string): string {
  if (value.length > MAX_URL_LENGTH) throw new PiMutationInputError("The package URL is too long.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PiMutationInputError("Enter a valid pi.dev package URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== PACKAGE_HOST ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(PACKAGE_PREFIX)
  ) {
    throw new PiMutationInputError("Use a clean https://pi.dev/packages/<package> URL.");
  }
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.slice(PACKAGE_PREFIX.length)).replace(/\/$/u, "");
  } catch {
    throw new PiMutationInputError("The package URL contains invalid encoding.");
  }
  if (!NPM_PACKAGE.test(name)) {
    throw new PiMutationInputError("The pi.dev URL does not name a valid npm package.");
  }
  return `npm:${name}`;
}

export function validateSkillUrl(value: string): string {
  if (value.length > MAX_URL_LENGTH) throw new PiMutationInputError("The skill URL is too long.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PiMutationInputError("Enter a valid skill URL.");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new PiMutationInputError("Skill sources must use a clean HTTPS URL.");
  }
  return url.toString();
}

export function selectCheapModel(snapshot: PiSnapshot, override = process.env["HUI_SKILL_INSTALL_MODEL"]): string | undefined {
  if (override?.trim()) return override.trim();
  const candidate = snapshot.model.catalog.find((model) =>
    CHEAP_MODEL.test(`${model.provider}/${model.id} ${model.name}`),
  );
  if (candidate) return `${candidate.provider}/${candidate.id}`;
  return undefined;
}

function commandFailure(action: string, result: PiCommandResult): PiMutationCommandError {
  const detail = safeOutput(result.output).split("\n").filter(Boolean).at(-1);
  return new PiMutationCommandError(
    detail ? `${action} failed: ${detail}` : `${action} failed with exit code ${result.code}.`,
  );
}

type MutationDependencies = {
  run: PiCommandRunner;
  readSnapshot: () => Promise<PiSnapshot>;
  readPackageSources: (agentDir: string) => Promise<readonly string[]>;
  agentDir: string;
  cheapModel?: string;
};

export class PiMutationService {
  private active: PiMutationKind | undefined;
  private readonly dependencies: MutationDependencies;

  constructor(dependencies?: MutationDependencies) {
    this.dependencies = dependencies ?? {
      run: runPiCommand,
      readSnapshot: readPiConfig,
      readPackageSources: readConfiguredPackageSourcesAt,
      agentDir: PI_AGENT_DIR,
    };
  }

  private async exclusive<T>(kind: PiMutationKind, operation: () => Promise<T>): Promise<T> {
    if (this.active) throw new PiMutationBusyError(`A PI ${this.active} operation is already running.`);
    this.active = kind;
    try {
      return await operation();
    } finally {
      this.active = undefined;
    }
  }

  installPackage(url: string): Promise<PiMutationResult> {
    return this.exclusive("package-install", async () => {
      const source = packageSourceFromCatalogUrl(url.trim());
      const result = await this.dependencies.run(["install", source], {
        cwd: this.dependencies.agentDir,
        timeoutMs: PACKAGE_TIMEOUT_MS,
      });
      if (result.code !== 0) throw commandFailure("Package installation", result);
      return {
        kind: "package-install",
        target: safeSourceLabel(source),
        message: `Installed ${safeSourceLabel(source)}.`,
        snapshot: await this.dependencies.readSnapshot(),
      };
    });
  }

  removePackage(label: string): Promise<PiMutationResult> {
    return this.exclusive("package-remove", async () => {
      const wanted = label.trim();
      if (!wanted) throw new PiMutationInputError("A package source is required.");
      const sources = await this.dependencies.readPackageSources(this.dependencies.agentDir);
      const matches = sources.filter((source) => safeSourceLabel(source) === wanted);
      if (matches.length !== 1) {
        throw new PiMutationInputError(matches.length ? "That package label is ambiguous." : "That package is no longer configured.");
      }
      const source = matches[0]!;
      const result = await this.dependencies.run(["remove", source], {
        cwd: this.dependencies.agentDir,
        timeoutMs: PACKAGE_TIMEOUT_MS,
      });
      if (result.code !== 0) throw commandFailure("Package removal", result);
      return {
        kind: "package-remove",
        target: wanted,
        message: `Removed ${wanted}.`,
        snapshot: await this.dependencies.readSnapshot(),
      };
    });
  }

  installSkill(value: string): Promise<PiMutationResult> {
    return this.exclusive("skill-install", async () => {
      const url = validateSkillUrl(value.trim());
      const before = await this.dependencies.readSnapshot();
      const model = this.dependencies.cheapModel ?? selectCheapModel(before);
      if (!model) throw new PiMutationCommandError("No PI model is available for the skill installer agent.");
      const prompt = [
        "Install exactly one Agent Skill from the URL below into PI's user skill configuration.",
        `URL: ${url}`,
        `PI agent directory: ${this.dependencies.agentDir}`,
        "Inspect the source, locate and validate SKILL.md, and install it so a fresh PI process discovers it.",
        "Do not modify files outside the PI agent directory. Do not install unrelated packages or skills.",
        "Finish with one line beginning OK: on success or ERROR: on failure.",
      ].join("\n");
      const result = await this.dependencies.run([
        "--print",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--thinking",
        "minimal",
        "--model",
        model,
        "--tools",
        "read,bash,write,edit",
        prompt,
      ], { cwd: this.dependencies.agentDir, timeoutMs: SKILL_TIMEOUT_MS });
      if (result.code !== 0) throw commandFailure("Skill installation", result);
      const after = await this.dependencies.readSnapshot();
      const previous = new Set(before.skills.map((skill) => skill.path));
      const added = after.skills.filter((skill) => !previous.has(skill.path));
      if (added.length === 0) {
        throw new PiMutationCommandError("The installer agent finished, but PI did not discover a new skill.");
      }
      return {
        kind: "skill-install",
        target: url,
        message: `Installed ${added.map((skill) => skill.name).join(", ")}.`,
        snapshot: after,
      };
    });
  }
}
