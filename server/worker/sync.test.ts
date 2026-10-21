import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { configuredResourceId } from "../runtimes/resource-policy.ts";
import { brokeredModels, buildSyncPlan, credentialHeader, mirrorPath } from "./sync.ts";

test("the mirror holds the user's PI resources with remote paths and no secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hui-sync-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const pkg = join(home, "src", "my-package");
  const remoteMirror = "/remote/.local/share/hui-worker/mirror";
  await mkdir(join(agentDir, "skills", "local"), { recursive: true });
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await mkdir(join(pkg, "node_modules", "dep"), { recursive: true });
  await mkdir(join(pkg, ".git"), { recursive: true });
  await mkdir(join(home, ".agents", "skills", "shared"), { recursive: true });
  await mkdir(join(root, "elsewhere"), { recursive: true });
  await writeFile(join(agentDir, "skills", "local", "SKILL.md"), "local skill");
  await writeFile(join(agentDir, "auth.json"), "{\"p\":{\"type\":\"api_key\",\"key\":\"secret\"}}");
  await writeFile(join(agentDir, "sessions", "transcript.jsonl"), "{}");
  await writeFile(join(agentDir, "models.json"), "{\"providers\":{\"p\":{\"baseUrl\":\"https://example.test\"}}}");
  await writeFile(join(agentDir, "AGENTS.md"), "global context");
  await writeFile(join(pkg, "package.json"), "{\"name\":\"my-package\"}");
  await writeFile(join(pkg, "index.ts"), "export default () => {}");
  await writeFile(join(pkg, "node_modules", "dep", "index.js"), "");
  await writeFile(join(pkg, ".git", "HEAD"), "");
  await writeFile(join(home, ".agents", "skills", "shared", "SKILL.md"), "shared skill");
  await writeFile(join(root, "elsewhere", "prompt.md"), "prompt");
  await writeFile(join(root, "elsewhere", "extension.ts"), "export default () => {}");
  // A symlinked directory loop must not hang the walk.
  await symlink(join(agentDir, "skills"), join(agentDir, "skills", "local", "loop"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    sessionDir: "~/transcripts",
    packages: ["npm:pi-tool", { source: "../../src/my-package", skills: ["x"] }],
    prompts: [join(root, "elsewhere", "prompt.md")],
    extensions: [join(root, "elsewhere", "extension.ts")],
    skills: ["~/.agents/skills/shared", "!**/draft"],
  }));

  const plan = await buildSyncPlan({ agentDir, home, remoteMirror, extraPaths: ["~/not-there"] });
  const paths = plan.files.map((file) => file.path);
  assert.ok(paths.includes("agent/skills/local/SKILL.md"));
  assert.ok(paths.includes("agent/AGENTS.md"));
  assert.ok(paths.includes("agent/models.json"));
  assert.ok(paths.includes("home/src/my-package/index.ts"));
  assert.ok(paths.includes("home/.agents/skills/shared/SKILL.md"));
  assert.ok(paths.includes(`root${join(root, "elsewhere", "prompt.md")}`));
  for (const path of paths) {
    assert.doesNotMatch(path, /auth\.json$|\/sessions\/|node_modules|\.git\//u, path);
  }
  assert.deepEqual(plan.packageRoots, ["home/src/my-package"]);

  const settings = JSON.parse(plan.files.find((file) => file.path === "agent/settings.json")!.content!.toString());
  assert.equal(settings.sessionDir, undefined);
  assert.deepEqual(settings.packages, ["npm:pi-tool", { source: `${remoteMirror}/home/src/my-package`, skills: ["x"] }]);
  assert.deepEqual(settings.skills, [`${remoteMirror}/home/.agents/skills/shared`, "!**/draft"]);
  assert.deepEqual(settings.extensions, [`${remoteMirror}/root${join(root, "elsewhere", "extension.ts")}`]);
  // HUI's disabled-plugin ids follow the rewritten source.
  assert.equal(plan.pluginIds.get(configuredResourceId("package", "../../src/my-package")), configuredResourceId("package", `${remoteMirror}/home/src/my-package`));
  assert.equal(mirrorPath(join(agentDir, "npm", "x"), { agentDir, home }), "agent/npm/x");
});

test("literal keys and header values in models.json are left out of the mirror for the gateway to serve", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hui-sync-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  const secrets = ["sk-literal-key", "literal-header-secret", "model-header-secret", "built-in-key"];
  await writeFile(join(agentDir, "models.json"), `{
    // PI accepts comments.
    "providers": {
      "custom": {
        "baseUrl": "https://example.test", "api": "anthropic-messages", "apiKey": "sk-literal-key",
        "headers": { "org-id": "2", "x-secret": "literal-header-secret", "x-env": "$GATEWAY_TOKEN", "x-mixed": "Bearer \${TOKEN}", "x-command": "!print-token" },
        "models": [{ "id": "m", "headers": { "x-model-token": "model-header-secret" } }],
      },
      "from-env": { "baseUrl": "https://example.test", "apiKey": "$FROM_ENV_KEY" },
      "from-command": { "baseUrl": "https://example.test", "apiKey": "!print-key" },
      "anthropic": { "apiKey": "built-in-key" },
    },
  }`);

  const plan = await buildSyncPlan({ agentDir, home, remoteMirror: "/remote/mirror" });
  const file = plan.files.find((entry) => entry.path === "agent/models.json")!;
  const text = file.content!.toString();
  for (const secret of secrets) assert.ok(!text.includes(secret), `the mirror holds ${secret}`);
  const { providers } = JSON.parse(text);
  assert.equal(providers.custom.apiKey, undefined);
  assert.equal(providers.custom.headers["org-id"], "2", "a header that carries no credential stays configuration");
  assert.equal(providers.custom.headers["x-env"], "$GATEWAY_TOKEN");
  assert.equal(providers.custom.headers["x-mixed"], "Bearer ${TOKEN}");
  assert.equal(providers.custom.headers["x-command"], "!print-token");
  assert.deepEqual(providers["from-env"], { baseUrl: "https://example.test", apiKey: "$FROM_ENV_KEY" });
  assert.deepEqual(providers["from-command"], { baseUrl: "https://example.test", apiKey: "!print-key" });
  // Nothing is left of a built-in provider's key override; its credential is served.
  assert.equal(providers.anthropic, undefined);

  // The gateway serves exactly what the mirror left out, under the names it uses.
  const { keys, env } = await brokeredModels(join(agentDir, "models.json"));
  assert.deepEqual(Object.fromEntries(keys), { anthropic: "built-in-key", custom: "sk-literal-key" });
  const variable = (value: string) => value.match(/^\$\{(HUI_SECRET_[0-9A-F]{16})\}$/u)![1]!;
  assert.deepEqual(env, {
    [variable(providers.custom.headers["x-secret"])]: "literal-header-secret",
    [variable(providers.custom.models[0].headers["x-model-token"])]: "model-header-secret",
  });
  assert.deepEqual(plan.env, env);
});

test("an invalid models.json is not mirrored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hui-sync-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "models.json"), "{ \"providers\": { \"p\": { \"apiKey\": \"sk-unparsed\" ");
  const plan = await buildSyncPlan({ agentDir, home: root, remoteMirror: "/remote/mirror" });
  assert.ok(!plan.files.some((entry) => entry.path === "agent/models.json"));
  assert.deepEqual(plan.skipped, ["models.json: invalid, not mirrored"]);
});

test("only headers whose names say they carry a credential are withheld", () => {
  const withheld = ["Authorization", "proxy-authorization", "x-auth-token", "x-api-key", "X-Api-Key", "api_key", "apikey", "x-goog-api-key",
    "cookie", "set-cookie", "x-access-key", "private-key", "x-secret-key", "x-client-secret", "x-amz-security-token", "x-e2e-token",
    "x-password", "x-passphrase", "x-passcode", "x-credential", "x-credentials", "x-jwt", "x-signature", "bearer", "x-csrf-token"];
  const kept = ["x-max-tokens", "x-routing-key", "idempotency-key", "cache-key", "x-author", "org-id", "source", "anthropic-beta",
    "x-org-tag-client_session_id", "x-request-id", "user-agent", "x-keyboard-layout", "x-tokenizer"];
  assert.deepEqual(withheld.filter((name) => !credentialHeader(name)), []);
  assert.deepEqual(kept.filter((name) => credentialHeader(name)), []);
});
