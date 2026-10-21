/** The automatic cleanup of a bot's export: what it changes before any model reads it, and what it leaves alone. */
import assert from "node:assert/strict";
import { test } from "vitest";
import { caseClash, skillFilePath } from "./common.ts";
import { cleanText, nameFromUsername, personalIn } from "./cleanup.ts";

const IDENTITY = { operator: "Dani Fernandez", homes: ["/Users/dani.fernandez"], username: "dani.fernandez", hostnames: ["COMP-K7WX9J.local"], workers: ["devbox", "dev"] };
const clean = (text: string) => cleanText(text, IDENTITY);

test("the operator's name, home folders, e-mail addresses, machine and worker names in paths, tailnet names, IPs, Slack IDs, keys and trigger links go", () => {
  const { text, hits } = clean([
    "I'm Dani's helper; Dani Fernandez works with ana@example.com.",
    "Run /Users/dani.fernandez/dd/x.sh, /home/bits/y or /Users/someone/z. Branches start with dani.fernandez/feature.",
    "ssh devbox:/srv, https://devbox.tail1234.ts.net/x, COMP-K7WX9J.local/share, 10.1.2.3, Slack C0123ABCD.",
    `token: ghp_${"a".repeat(36)}; API_KEY=abcdef1234567890abcd; Bearer abcdefghijklmnopqrstu; /__hui/hooks/AbC123_-x.`,
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
  ].join("\n"));
  assert.equal(text, [
    "I'm {{user}}'s helper; {{user}} works with [removed].",
    "Run ~/dd/x.sh, ~/y or ~/z. Branches start with [removed]/feature.",
    "ssh [removed]:/srv, https://[removed]/x, [removed]/share, [removed], Slack [removed].",
    "token: [removed]; API_KEY=[removed]; Bearer [removed]; /__hui/hooks/[removed].",
    "[removed]",
  ].join("\n"));
  assert.deepEqual(hits.find((hit) => hit.kind === "a key or token"), { kind: "a key or token", sample: "ghp_…", count: 3 }, "a secret is never shown whole");
  assert.deepEqual(hits.find((hit) => hit.kind === "your name"), { kind: "your name", sample: "Dani Fernandez", count: 2 });
});

test("without a profile name the account's names go, one placeholder a mention; a user name reads as a name only when the account's full name bears it out", () => {
  const identity = { homes: [], username: "dani.fernandez", hostnames: [], workers: [], names: ["Daniel Fernandez Ocana", "Dani Fernandez"] };
  const { text, hits } = cleanText("Dani asked me. Daniel Fernandez Ocana reviews; Dani Fernandez Ocana approves. Ask Fernandez.", identity);
  assert.equal(text, "{{user}} asked me. {{user}} reviews; {{user}} approves. Ask {{user}}.");
  assert.deepEqual(hits.map((hit) => [hit.kind, hit.count]), [["your name", 5]]);
  assert.equal(personalIn("dani-reviews", identity), "your name");
  assert.equal(nameFromUsername("dani.fernandez", "Daniel Fernandez Ocana"), "Dani Fernandez", "a short name begins a word of the full name");
  assert.equal(nameFromUsername("dani.fernandez", undefined), undefined, "nothing bears it out");
  assert.equal(nameFromUsername("build.agent", "Daniel Fernandez Ocana"), undefined, "a service account");
  assert.equal(nameFromUsername("dfernandez", "Daniel Fernandez Ocana"), undefined, "not first.last");
  assert.equal(nameFromUsername("ci.user2", "Ci User"), undefined, "a part with a digit");
  const someone = (names: string[], operator?: string) => ({ homes: [], username: "x", hostnames: [], workers: [], names, ...(operator ? { operator } : {}) });
  assert.equal(cleanText("Ask García-López or López or García. Ping O'Brien, Sean.", someone(["María García-López", "Sean O'Brien"])).text,
    "Ask {{user}} or {{user}} or {{user}}. Ping {{user}}, {{user}}.", "a hyphen or an apostrophe in a name");
  assert.equal(cleanText("Ubuntu 22 runs it; Will will do.", someone(["Ubuntu"], "Will")).text, "Ubuntu 22 runs it; Will will do.", "a one-word common or generic name stays");
  assert.equal(personalIn("ubuntu-setup", someone(["Ubuntu"])), undefined, "a skill named after a generic account name stays");
});

test("ordinary text stays: common words of a name, git's address, loopback, versions, generic machine names outside paths", () => {
  const text = "Will you approve? Mark it and ping the dev team. git clone git@github.com:acme/widgets.git; curl 127.0.0.1:8080; v1.2.3 and 1.2.3; Dani is gone? no: danish pastry.";
  const willMark = cleanText(text, { ...IDENTITY, operator: "Will Mark" });
  assert.equal(willMark.text, text, "a name made of common words is left to the reviewer");
  assert.equal(clean(text).text, text.replace("Dani is gone", "{{user}} is gone"));
  assert.deepEqual(cleanText("", IDENTITY), { text: "", hits: [] });
  const started = Date.now();
  cleanText(`${"a+b/".repeat(60_000)} ${"ab.".repeat(80_000)} ${"x".repeat(200_000)}@`, IDENTITY);
  assert.ok(Date.now() - started < 5_000, "long text without spaces stays fast");
});

test("code that reads a secret, words with a digit and a worker's home are not a person's; identifiers that name them are", () => {
  const code = "token = process.env.GITHUB_TOKEN\napi_key = os.environ.get('K')\nsecret: $SECRET_VALUE_HERE\nmodel GPT4TURBO";
  assert.deepEqual(clean(code), { text: code, hits: [] }, "a script reading its token from the environment keeps traveling");
  const worker = cleanText("cd /srv/bits/app && ssh devbox.lan", { ...IDENTITY, homes: ["/Users/dani.fernandez", "/srv/bits"], hostnames: ["COMP-K7WX9J.local", "devbox.lan"] });
  assert.equal(worker.text, "cd ~/app && ssh devbox.lan", "a worker's home goes; its host name only inside a path");
  assert.equal(personalIn("dani-reviews", IDENTITY), "your name");
  assert.equal(personalIn("scripts/approve.sh", IDENTITY), undefined);
  assert.equal(personalIn("notes-COMP-K7WX9J.md", IDENTITY), "this machine's name");
  assert.equal(skillFilePath("skill.md"), undefined, "a second SKILL.md in another case would overwrite the instructions");
  assert.equal(skillFilePath("docs/Skill.MD"), "docs/Skill.MD", "only beside it");
  assert.equal(caseClash(["a.sh", "b.sh", "A.sh"]), "A.sh");
});

test("relative paths, words with a digit and names that only contain a worker's are left alone", () => {
  const text = "Edit src/home/index.ts and templates/Users/list.html; use DOCKER2024 and UBUNTU2204 images.";
  assert.deepEqual(clean(text), { text, hits: [] });
  assert.equal(clean("cd /home/bits/app").text, "cd ~/app", "a home folder where a path starts still goes");
  const workers = { ...IDENTITY, workers: ["lab", "gpu"] };
  assert.equal(personalIn("label-issues", workers), undefined);
  assert.equal(personalIn("debug-gpus", workers), undefined);
  assert.equal(personalIn("lab-notes.md", workers), "a worker's name");
  assert.equal(personalIn("templates/home/index.html", IDENTITY), undefined);
});
