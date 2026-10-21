import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { planRelease } from "../scripts/release.mjs";
import { NIGHTLY_VERSION, nightlyVersion } from "../scripts/nightly-version.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "hui-release-plan-"));
  t.onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.test");
  git("config", "commit.gpgsign", "false");
  const commit = (version, subject, lockVersion = version) => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ version: lockVersion, packages: { "": { version: lockVersion } } }));
    git("add", ".");
    git("commit", "-qm", subject, "--allow-empty");
    return git("rev-parse", "HEAD");
  };
  const base = commit("1.0.0", "feat: original version");
  git("tag", "v1.0.0");
  return { cwd, git, commit, base, plan: (extra = {}) => planRelease({ cwd, base, repository: "example/hui", ...extra }) };
}

test("ordinary PRs do not create releases", (t) => {
  const f = fixture(t);
  f.commit("1.0.0", "fix: ordinary change");
  assert.deepEqual(f.plan(), { changed: false });
});
test("changelog includes every change since last version, not just the bump", (t) => {
  const f = fixture(t);
  const first = f.commit("1.0.0", "fix: first change");
  const base = f.commit("1.0.0", "docs: second change");
  f.commit("1.1.0", "chore: release v1.1.0");
  const result = f.plan({ base });
  assert.equal(result.tag, "v1.1.0");
  assert.match(result.changelog, /fix: first change/);
  assert.match(result.changelog, /docs: second change/);
  assert.match(result.changelog, new RegExp(`/commit/${first}`));
  assert.match(result.changelog, /compare\/v1.0.0\.\.\./);
  assert.doesNotMatch(result.changelog, /original version/);
});
test("manual tag and retries exclude the current tag from the baseline", (t) => {
  const f = fixture(t);
  f.commit("1.1.0", "feat: new release");
  f.git("tag", "v1.1.0");
  assert.match(f.plan({ tag: "v1.1.0" }).changelog, /feat: new release/);
  assert.equal(f.plan().changed, true);
  assert.throws(() => f.plan({ tag: "v1.2.0" }), /tag must match/);
});
test("invalid, prerelease and decreasing versions are rejected", (t) => {
  const f = fixture(t);
  for (const version of ["01.1.0", "1.1.0-beta.1", "garbage", "0.9.0"]) {
    f.commit(version, "chore: version");
    assert.throws(() => f.plan(), /SemVer|must increase/);
  }
});
test("lockfile version drift is rejected", (t) => {
  const f = fixture(t);
  f.commit("1.1.0", "chore: bad lockfile", "1.0.0");
  assert.throws(() => f.plan(), /lock.json versions/);
});
test("existing tags on another commit cannot be reused", (t) => {
  const f = fixture(t);
  f.git("tag", "v1.1.0");
  f.commit("1.1.0", "chore: version");
  assert.throws(() => f.plan(), /another commit/);
});
test("first release includes history and ignores unrelated tags", (t) => {
  const f = fixture(t);
  f.git("tag", "-d", "v1.0.0");
  f.git("tag", "preview");
  f.commit("1.1.0", "feat: initial release");
  assert.match(f.plan().changelog, /original version/);
  assert.match(f.plan().changelog, /Initial release/);
});
test("a repository's first push plans its initial stable release", (t) => {
  const f = fixture(t);
  f.git("tag", "-d", "v1.0.0");
  assert.equal(f.plan({ base: "0".repeat(40) }).tag, "v1.0.0");
  assert.match(f.plan({ base: "0".repeat(40) }).changelog, /Initial release/u);
});
test("stable baseline is selected numerically and must precede the new version", (t) => {
  const f = fixture(t);
  f.git("tag", "v1.9.0");
  f.git("tag", "v1.10.0");
  f.git("tag", "v2.0.0-beta.1");
  f.commit("1.11.0", "chore: release");
  assert.match(f.plan().changelog, /since v1.10.0/);
  f.commit("1.5.0", "chore: invalid release");
  assert.throws(() => f.plan(), /last stable tag/);
});
test("branch changes are included once without merge commit duplication", (t) => {
  const f = fixture(t);
  f.git("switch", "-qc", "feature");
  f.commit("1.0.0", "feat: branch change <script>");
  f.git("switch", "-q", "main");
  f.git("merge", "--no-ff", "feature", "-m", "Merge feature");
  f.commit("1.1.0", "chore: release");
  const notes = f.plan().changelog;
  assert.equal(notes.match(/branch change/gu).length, 1);
  assert.doesNotMatch(notes, /Merge feature/);
  assert.ok(notes.includes("\\<script\\>"));
});

test("Actions entrypoint writes outputs, artifact and summary for a version PR", (t) => {
  const f = fixture(t);
  f.commit("1.1.0", "feat: action integration");
  const eventPath = join(f.cwd, "event.json");
  const outputPath = join(f.cwd, "outputs");
  const summaryPath = join(f.cwd, "summary.md");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: f.base } } }));
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/release.mjs", import.meta.url))], {
    cwd: f.cwd,
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath, GITHUB_REF_TYPE: "branch", GITHUB_REPOSITORY: "example/hui" },
  });
  assert.equal(readFileSync(outputPath, "utf8"), "changed=true\ntag=v1.1.0\n");
  const changelog = readFileSync(join(f.cwd, "release-changelog.md"), "utf8");
  assert.match(changelog, /feat: action integration/);
  assert.equal(readFileSync(summaryPath, "utf8"), changelog);
});

test("a nightly is a prerelease of the next patch, ordered by commit time and naming its commit", () => {
  const sha = "b0f30d567fb0eb56325ab3c9f028a40a1f78b307";
  const version = nightlyVersion("0.1.2", "2026-10-04T15:11:49+02:00", sha);
  assert.equal(version, "0.1.3-nightly.20261004131149.gb0f30d5");
  assert.match(version, NIGHTLY_VERSION);
  assert.equal(nightlyVersion("1.9.9", "2026-01-02T03:04:05Z", sha), "1.9.10-nightly.20260102030405.gb0f30d5");
  for (const [base, date, commit] of [["0.1.2-rc.1", "2026-10-04T13:11:49Z", sha], ["0.1", "2026-10-04T13:11:49Z", sha],
    ["0.1.2", "not a date", sha], ["0.1.2", "2026-10-04T13:11:49Z", "b0f30d5"]]) {
    assert.throws(() => nightlyVersion(base, date, commit));
  }
});

test("the nightly script stamps the checked-out commit", (t) => {
  const { cwd, git } = fixture(t);
  const script = fileURLToPath(new URL("../scripts/nightly-version.mjs", import.meta.url));
  const printed = execFileSync(process.execPath, [script], { cwd, encoding: "utf8", env: { ...process.env, GITHUB_SHA: "" } }).trim();
  assert.match(printed, NIGHTLY_VERSION);
  assert(printed.startsWith("1.0.1-nightly."));
  assert(printed.endsWith(`.g${git("rev-parse", "--short=7", "HEAD")}`));
});
