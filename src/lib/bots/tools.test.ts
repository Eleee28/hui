import assert from "node:assert/strict";
import { test } from "vitest";
import type { BotCatalog, BotCatalogTool } from "../../api/schema/bots.ts";
import { botToolsOffLabel, botToolsSummary, groupBotTools, matchingSkills, parseBotCatalog, skillsAfter, toolsAfter } from "./tools.ts";
import { parseBot } from "./bots.ts";

const tool = (name: string, group: BotCatalogTool["group"], extra: Partial<BotCatalogTool> = {}): BotCatalogTool => ({
  name, label: name, description: `the ${name} tool`, group, source: group === "extension" ? "user · a.js" : "HUI", powerful: false, enabled: true, ...extra,
});

const CATALOG: BotCatalog = {
  tools: [
    tool("read", "files"), tool("bash", "shell", { powerful: true, enabled: false }), tool("sessions_spawn", "hui", { powerful: true }),
    tool("echo", "extension"), tool("weather", "extension", { source: "user · b.js" }), tool("other", "extension"), tool("message_bot", "bots"),
  ],
  skills: [
    { name: "alpha", path: "/s/alpha/SKILL.md", description: "Writes release notes.", source: "/s", enabled: true },
    { name: "beta", path: "/s/beta/SKILL.md", description: "Triage bugs.", source: "HUI defaults", enabled: false },
  ],
  alwaysOn: [{ name: "write_soul", description: "Rewrite its SOUL.md" }],
  disabledTools: ["bash"],
  disabledSkills: [{ name: "beta", path: "/s/beta/SKILL.md" }],
  live: true,
};

test("tools group as Files, Shell, HUI, each extension by its source, then Bots, keeping their order", () => {
  assert.deepEqual(groupBotTools(CATALOG.tools).map((group) => [group.title, group.source ?? "", group.tools.map((each) => each.name)]), [
    ["Files", "", ["read"]], ["Shell", "", ["bash"]], ["HUI", "", ["sessions_spawn"]],
    ["Extension", "user · a.js", ["echo", "other"]], ["Extension", "user · b.js", ["weather"]], ["Bots", "", ["message_bot"]],
  ]);
  assert.deepEqual(groupBotTools([]), []);
});

test("the summary says everything is on, or how much is off", () => {
  assert.equal(botToolsSummary(CATALOG), "1 of 7 tools and 1 of 2 skills are off.");
  assert.equal(botToolsSummary({ tools: [tool("read", "files")], skills: [] }), "Everything is on: 1 tool and 0 skills.");
  assert.equal(botToolsSummary({ tools: [tool("read", "files", { enabled: false })], skills: [] }), "1 of 1 tool is off.");
  assert.equal(botToolsSummary({ tools: [], skills: CATALOG.skills }), "1 of 2 skills is off.");
  // The overview has only the bot's record, which lists what is off.
  assert.equal(botToolsOffLabel({}), "Everything on");
  assert.equal(botToolsOffLabel({ disabledTools: ["bash", "write"] }), "2 tools off");
  assert.equal(botToolsOffLabel({ disabledTools: ["bash"], disabledSkills: [{ name: "a", path: "/a" }, { name: "b", path: "/b" }, { name: "c", path: "/c" }] }), "1 tool and 3 skills off");
});

test("skills are searched by every word in their name, description or source; switches change whole lists", () => {
  assert.deepEqual(matchingSkills(CATALOG.skills, "  ").map((skill) => skill.name), ["alpha", "beta"]);
  assert.deepEqual(matchingSkills(CATALOG.skills, "BUGS triage").map((skill) => skill.name), ["beta"]);
  assert.deepEqual(matchingSkills(CATALOG.skills, "defaults").map((skill) => skill.name), ["beta"]);
  assert.deepEqual(matchingSkills(CATALOG.skills, "nothing"), []);
  assert.deepEqual(toolsAfter(CATALOG, "bash", true), []);
  assert.deepEqual(toolsAfter(CATALOG, "read", false), ["bash", "read"]);
  assert.deepEqual(skillsAfter(CATALOG, CATALOG.skills[1]!, true), []);
  assert.deepEqual(skillsAfter(CATALOG, CATALOG.skills[0]!, false), [{ name: "beta", path: "/s/beta/SKILL.md" }, { name: "alpha", path: "/s/alpha/SKILL.md" }]);
});

test("the catalog is narrowed on the way in, and a bot's lists come with its record", () => {
  const parsed = parseBotCatalog({
    ...CATALOG, tools: [...CATALOG.tools, { label: "no name" }, { name: "odd", group: "weird" }], skills: [...CATALOG.skills, { name: "x" }],
    request: { id: "q", sessionId: "s", title: "Allow access to bash (powerful)?", message: "Why." }, extra: true,
  });
  assert.equal(parsed.tools.length, 8);
  assert.equal(parsed.tools.at(-1)?.group, "extension", "an unknown group is an extension's");
  assert.equal(parsed.skills.length, 2);
  assert.deepEqual(parsed.request, { id: "q", sessionId: "s", title: "Allow access to bash (powerful)?", message: "Why." });
  assert.throws(() => parseBotCatalog({ tools: [] }), /did not come back/u);
  assert.equal(parseBotCatalog({ ...CATALOG, request: { id: "q" } }).request, undefined);
  const bot = parseBot({ id: "b", name: "Ada", sessionId: "s", disabledTools: ["bash", 3], disabledSkills: [{ name: "beta", path: "/p" }, { name: "x" }] });
  assert.deepEqual([bot?.disabledTools, bot?.disabledSkills], [["bash"], [{ name: "beta", path: "/p" }]]);
  assert.equal("disabledTools" in parseBot({ id: "b", name: "Ada", sessionId: "s" })!, false);
});
