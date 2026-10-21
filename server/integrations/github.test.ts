import assert from "node:assert/strict";
import { GitHubConnection } from "../api/github.ts";
import { expectSchema } from "../test-support/api-schema.ts";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { GITHUB_CLI_REQUIRED } from "./github.ts";
import {
  GitHubCli,
  GitHubCliError,
  loginFailureMessage,
  parseAuthStatus,
  parseDeviceCode,
  parseGhVersion,
} from "./github.ts";

const FIXTURE = fileURLToPath(new URL("../../e2e/fixtures/github-cli-fixture.mjs", import.meta.url));

async function fakeGh(patch: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hui-gh-"));
  await chmod(FIXTURE, 0o755);
  const cli = new GitHubCli({ command: FIXTURE, env: { ...process.env, HUI_FAKE_GH_DIR: dir, ...patch } });
  return { dir, cli };
}

test("parses gh version, device codes and failure lines", () => {
  assert.equal(parseGhVersion("gh version 2.101.0 (nixpkgs)\nhttps://…"), "2.101.0");
  const output = "\n! Failed to copy one-time code to clipboard\n  No clipboard utilities available.\n\u001b[33m!\u001b[0m First copy your one-time code: DED5-6F5E\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
  assert.equal(parseDeviceCode(output), "DED5-6F5E");
  assert.equal(parseDeviceCode("Press Enter to open github.com"), undefined);
  assert.equal(loginFailureMessage(`${output}X failed to authenticate: denied\n`, 1), "failed to authenticate: denied");
  assert.equal(loginFailureMessage(output, 3), "gh auth login exited with code 3.");
  assert.equal(
    loginFailureMessage(`${output}failed to authenticate via web browser: Post "https://github.com/login/device/code": Proxy Authentication Required\n`, 1),
    'failed to authenticate via web browser: Post "https://github.com/login/device/code": Proxy Authentication Required',
  );
});

test("maps gh auth status JSON without exposing tokens", () => {
  assert.deepEqual(parseAuthStatus('{"hosts":{}}'), { status: "disconnected" });
  assert.deepEqual(
    parseAuthStatus(JSON.stringify({ hosts: { "github.com": [
      { state: "success", active: false, host: "github.com", login: "other", tokenSource: "keyring", scopes: "" },
      { state: "success", active: true, host: "github.com", login: "octocat", tokenSource: "/home/u/.config/gh/hosts.yml", scopes: "gist, read:org, repo", token: "gho_secret" },
    ] } })),
    { status: "connected", account: { host: "github.com", login: "octocat", scopes: ["gist", "read:org", "repo"], tokenSource: "/home/u/.config/gh/hosts.yml" } },
  );
  const invalid = parseAuthStatus(JSON.stringify({ hosts: { "github.com": [{ state: "error", active: true, host: "github.com", login: "x", error: "HTTP 401" }] } }));
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.message, "HTTP 401");
  const unreachable = parseAuthStatus(JSON.stringify({ hosts: { "github.com": [{ state: "error", active: true, host: "github.com", login: "x", error: "Get \"https://api.github.com/\": Proxy Authentication Required" }] } }));
  assert.equal(unreachable.status, "unknown");
  assert.match(unreachable.message ?? "", /^GitHub could not be reached: .*Proxy Authentication Required$/u);
  assert.equal(parseAuthStatus(JSON.stringify({ hosts: { "github.com": [{ state: "error", active: true, login: "x", error: "Bad credentials" }] } })).status, "invalid");
  assert.equal(parseAuthStatus(JSON.stringify({ hosts: { "github.com": [{ state: "error", active: true, login: "x" }] } })).status, "invalid");
  assert.equal(parseAuthStatus(JSON.stringify({ hosts: { "github.com": [{ state: "timeout", active: true, login: "x" }] } })).status, "unknown");
  assert.equal(parseAuthStatus("not json").status, "unknown");
});

test("reports a missing gh as required and refuses to start a login", async () => {
  const cli = new GitHubCli({ command: join(tmpdir(), "hui-no-such-gh", "gh") });
  const connection = await cli.connection();
  expectSchema(GitHubConnection, connection);
  assert.deepEqual(connection.cli, { installed: false });
  assert.equal(connection.message, GITHUB_CLI_REQUIRED);
  await assert.rejects(cli.startLogin(), (error: unknown) => error instanceof GitHubCliError && error.status === 409 && error.message === GITHUB_CLI_REQUIRED);
  assert.deepEqual(connection.login, { phase: "idle" });
});

test("device login shows the one-time code and becomes connected after approval", async () => {
  const { dir, cli } = await fakeGh({ HUI_FAKE_GH_CODE: "WXYZ-9876", HUI_FAKE_GH_PROTOCOL: "ssh" });
  const before = await cli.connection();
  expectSchema(GitHubConnection, before);
  assert.deepEqual(before.cli, { installed: true, version: "9.9.9" });
  assert.equal(before.status, "disconnected");

  const started = await cli.startLogin();
  expectSchema(GitHubConnection, started);
  assert.equal(started.login.phase, "pending");
  assert.ok(started.login.phase === "pending");
  assert.equal(started.login.userCode, "WXYZ-9876");
  assert.equal(started.login.verificationUri, "https://github.com/login/device");
  // The operator's configured git protocol survives the non-interactive login.
  assert.equal(await readFile(join(dir, "login-args"), "utf8"), "auth login --hostname github.com --web --skip-ssh-key --git-protocol ssh");
  // A second click while waiting reuses the same login rather than spawning another.
  const again = await cli.startLogin();
  assert.ok(again.login.phase === "pending" && again.login.userCode === "WXYZ-9876");

  await writeFile(join(dir, "approve"), "");
  await cli.whenLoginSettled();
  const after = await cli.connection();
  expectSchema(GitHubConnection, after);
  assert.equal(after.status, "connected");
  assert.equal(after.account?.login, "hui-e2e");
  assert.deepEqual(after.login, { phase: "idle" });
  assert.equal((await readFile(join(dir, "account"), "utf8")).trim(), "hui-e2e");
  assert.doesNotMatch(JSON.stringify(after), /token"/u);
});

test("a denied login fails with gh's reason and can be dismissed", async () => {
  const { dir, cli } = await fakeGh();
  await cli.startLogin();
  await writeFile(join(dir, "deny"), "");
  await cli.whenLoginSettled();
  const failed = await cli.connection();
  expectSchema(GitHubConnection, failed);
  assert.deepEqual(failed.login, { phase: "failed", message: "failed to authenticate via web browser: the user denied the request" });
  assert.equal(failed.status, "disconnected");
  assert.deepEqual((await cli.cancelLogin()).login, { phase: "idle" });
});

test("cancel stops the pending gh process and returns to idle", async () => {
  const { cli } = await fakeGh();
  assert.equal((await cli.startLogin()).login.phase, "pending");
  const cancelled = await cli.cancelLogin();
  expectSchema(GitHubConnection, cancelled);
  assert.deepEqual(cancelled.login, { phase: "idle" });
  assert.equal(cancelled.status, "disconnected");
});

test("an unapproved code expires and a gh without a code times out", async () => {
  const expiring = new GitHubCli({ command: FIXTURE, env: { ...process.env, HUI_FAKE_GH_DIR: (await fakeGh()).dir }, deviceCodeTtlMs: 50 });
  await expiring.startLogin();
  await expiring.whenLoginSettled();
  assert.deepEqual((await expiring.connection()).login, { phase: "failed", message: "The one-time code expired. Connect again to request a new code." });

  const dir = await mkdtemp(join(tmpdir(), "hui-gh-silent-"));
  const silent = join(dir, "gh");
  await writeFile(silent, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'gh version 1.0.0'; exit 0; fi\nif [ \"$2\" = status ]; then echo '{\"hosts\":{}}'; exit 0; fi\nexec sleep 30\n");
  await chmod(silent, 0o755);
  const quiet = new GitHubCli({ command: silent, startTimeoutMs: 50 });
  const result = await quiet.startLogin();
  expectSchema(GitHubConnection, result);
  assert.deepEqual(result.login, { phase: "failed", message: "gh did not print a one-time code. Run `gh auth login --web` in a terminal to see why." });
});

test("refuses to log in over an environment token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hui-gh-env-"));
  const gh = join(dir, "gh");
  await writeFile(gh, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'gh version 1.0.0'; exit 0; fi\necho '{\"hosts\":{\"github.com\":[{\"state\":\"success\",\"active\":true,\"host\":\"github.com\",\"login\":\"bot\",\"tokenSource\":\"GH_TOKEN\"}]}}'\n");
  await chmod(gh, 0o755);
  await assert.rejects(new GitHubCli({ command: gh }).startLogin(), /GH_TOKEN environment variable/u);
});
