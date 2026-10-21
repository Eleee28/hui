#!/usr/bin/env node
/** Browser-E2E PI wrapper for package/skill mutations.
 * Mutation commands touch only the isolated PI_AGENT_DIR. Every other command
 * delegates to the real PI binary so HUI still exercises the actual RPC probe. */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR;
const realPi = process.env.HUI_E2E_REAL_PI;
if (!agentDir || !realPi) throw new Error("PI_CODING_AGENT_DIR and HUI_E2E_REAL_PI are required");

async function settings() {
  try {
    return JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

async function save(value) {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (args[0] === "install" && args[1]) {
  const current = await settings();
  current.packages = [...new Set([...(Array.isArray(current.packages) ? current.packages : []), args[1]])];
  await save(current);
  process.stdout.write(`Installed ${args[1]}\n`);
  process.exit(0);
}

if (args[0] === "remove" && args[1]) {
  const current = await settings();
  current.packages = (Array.isArray(current.packages) ? current.packages : []).filter((source) => source !== args[1]);
  await save(current);
  process.stdout.write(`Removed ${args[1]}\n`);
  process.exit(0);
}

if (args.includes("--print")) {
  const skillDir = join(agentDir, "skills", "fixture-installed");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: fixture-installed\ndescription: Installed by the isolated E2E agent.\n---\n", "utf8");
  process.stdout.write("OK: installed fixture-installed\n");
  process.exit(0);
}

const child = spawn(realPi, args, { stdio: "inherit", env: process.env });
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
