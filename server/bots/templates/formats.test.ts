/**
 * Every importer against small synthetic fixtures written for these tests (nothing here is copied from another
 * platform's real templates), and the detection that picks the importer.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { crc32 } from "node:zlib";
import { readFile } from "node:fs/promises";
import { BOT_FACE_COLORS } from "../../bots-format.ts";
import { cardFromPng, parseCharacterCard } from "./character-card.ts";
import { parseClaudeCodeAgent } from "./claude-code.ts";
import { TemplateFormatError, type ImportFile } from "./common.ts";
import { parseCrewAiAgents } from "./crewai.ts";
import { readFileTemplates, readFolderTemplates, readTextTemplates } from "./detect.ts";
import { flightRows, grokBotUrl, parseGrokBotPage } from "./grok.ts";
import { identityFields, parseOpenClawWorkspace } from "./openclaw.ts";
import { isStockLettaPrompt, parseLettaAgentFile } from "./letta.ts";
import { parseTextTemplate } from "./text.ts";
import { writeZip } from "./zip.ts";
import { BOT_TEMPLATE_FORMATS, BOT_TEMPLATE_LIMITS } from "./formats.ts";

test("template formats and limits match the portable fixture", async () => {
  const fixture = JSON.parse(await readFile(new URL("./formats.fixture.json", import.meta.url), "utf8"));
  assert.deepEqual({ formats: BOT_TEMPLATE_FORMATS, limits: BOT_TEMPLATE_LIMITS }, fixture);
});

const file = (path: string, text: string): ImportFile => ({ path, data: Buffer.from(text, "utf8") });

/* ── Grok Bot ─────────────────────────────────────────────────────────── */

/** A Next.js page pushing `payload` in pieces of `size` characters, as the App Router streams it. */
function nextPage(payload: string, size = 97): string {
  const pushes: string[] = [];
  for (let at = 0; at < payload.length; at += size) pushes.push(`<script>self.__next_f.push([1,${JSON.stringify(payload.slice(at, at + size))}])</script>`);
  return `<!DOCTYPE html><html><head><script>(self.__next_f=self.__next_f||[]).push([0])</script></head><body>${pushes.join("")}</body></html>`;
}

const INSTRUCTIONS = "You plan trips.\nAsk where to and when — then plan day by day. 🧭";

function grokPayload(): string {
  const bot = {
    name: "Trip Planner", author: { name: "Ada", username: "ada" }, description: "Plans trips end to end", instructions: "$2", emoji: "🧳",
    memories: [{ name: "Home city", description: "Madrid" }, "Prefers trains"],
    skills: [{ name: "Packing list", description: "Make a packing list for a trip", content: "List clothes by day.\nAdd documents." }],
    routines: [{ name: "Weekly deals", prompt: "Look for cheap trains this week", schedule: "every monday at 9am" }, { title: "Empty" }],
    integrations: [{ name: "Web search", description: "Search the web" }, { name: "Gmail", description: "Read and send mail" }],
    conversationStarters: ["Plan a weekend"],
  };
  const text = Buffer.from(INSTRUCTIONS, "utf8");
  return [
    `0:["$","$L1",null,{"children":"$L3"}]\n`,
    `1:I["chunk",["a","b"],"default"]\n`,
    `2:T${text.length.toString(16)},${INSTRUCTIONS}`,
    `3:["$","main",null,{"bot":${JSON.stringify(bot)}}]\n`,
  ].join("");
}

test("a Grok Bot page's bot comes out of its server-components payload: instructions from a text row, memories, skills, routines, integrations", () => {
  const url = "https://x.ai/bot/marketplace/bots/trip-planner";
  const template = parseGrokBotPage(nextPage(grokPayload()), url);
  assert.equal(template.format, "grok");
  assert.equal(template.name, "Trip Planner");
  assert.equal(template.author, "Ada");
  assert.equal(template.description, "Plans trips end to end");
  assert.equal(template.soul, INSTRUCTIONS, "a text row's length counts bytes, so emoji and dashes survive");
  assert.equal(template.emoji, "🧳");
  assert.deepEqual(template.memories, [{ name: "Home city", text: "Madrid" }, { text: "Prefers trains" }]);
  assert.deepEqual(template.skills, [{ name: "Packing list", description: "Make a packing list for a trip", content: "List clothes by day.\nAdd documents." }]);
  assert.deepEqual(template.routines, [{ name: "Weekly deals", prompt: "Look for cheap trains this week", schedule: "every monday at 9am" }]);
  assert.deepEqual(template.integrations, [{ name: "Web search", description: "Search the web" }, { name: "Gmail", description: "Read and send mail" }]);
  assert.match(template.dropped.join("\n"), /Routine Empty: it has no prompt\./u);
  assert.match(template.dropped.join("\n"), /1 conversation starter: a HUI bot's chat has none\./u);
  assert.equal(template.origin, url);
});

test("a payload whose rows don't parse is still searched for the bot's object; a page without one says to paste instead", () => {
  const html = nextPage(`not a row {"x":1,"bot":{"name":"Brief","instructions":"Answer in one line.","skills":[]}} trailing`);
  assert.equal(parseGrokBotPage(html).soul, "Answer in one line.");
  assert.throws(() => parseGrokBotPage("<html><body>Nothing</body></html>"), (error: unknown) => error instanceof TemplateFormatError && /paste them instead/u.test(error.message));
  assert.throws(() => parseGrokBotPage(nextPage(`0:{"name":"No instructions here"}\n`)), /could not find the bot's instructions[\s\S]*paste them instead/u);
  const rows = flightRows(`a:T5,héllo\nb:{"k":1}\n`);
  assert.equal(rows.text.get("a"), "héll", "five bytes (é takes two), not five characters");
  assert.equal(rows.json.get("b"), "{\"k\":1}", "the row after a text row starts right where its bytes end");
});

test("a marketplace bot that keeps its job in its memories: its creator, empty instructions, a memory in a text row, a routine's summary, its color and shape", () => {
  const job = "JOB\nOwns: the weekly plan.\nNever books anything.";
  const bytes = Buffer.from(job, "utf8").length.toString(16);
  const bot = {
    id: "planner", name: "Weekly Planner", creatorName: "Sample Creator", description: "Plans the week", instructions: "", color: "blue", shape: "cloud", imageUrl: "https://example.com/p.jpg",
    memories: [{ id: "memory-0", name: "memory 1", description: "$a" }], skills: [], routines: [{ id: "routine-0", name: "Sunday plan", summary: "Disabled by default. Draft next week's plan." }],
    integrations: [{ id: "integration-0", name: "Google Calendar", description: "" }],
  };
  const page = nextPage(`9:["$","main",null,{"children":[["$","script",null,{"type":"application/ld+json"}],{"bot":${JSON.stringify(bot)}}]}]\na:T${bytes},${job}`);
  const template = parseGrokBotPage(page, "https://x.ai/bot/marketplace/bots/planner");
  assert.deepEqual([template.name, template.author, template.description, template.soul], ["Weekly Planner", "Sample Creator", "Plans the week", ""]);
  assert.deepEqual(template.memories, [{ name: "memory 1", text: job }]);
  assert.deepEqual(template.routines, [{ name: "Sunday plan", prompt: "Disabled by default. Draft next week's plan." }]);
  assert.deepEqual(template.avatar, { shape: "cloud", color: BOT_FACE_COLORS.find((color) => color.id === "blue")!.hex });
  assert.match(template.dropped.join("\n"), /Its picture/u);
  assert.deepEqual(template.integrations, [{ name: "Google Calendar" }]);
});

test("only marketplace links on x.ai over https are fetched", () => {
  assert.equal(grokBotUrl("https://x.ai/bot/marketplace/bots/trip-planner"), "https://x.ai/bot/marketplace/bots/trip-planner");
  assert.equal(grokBotUrl(" https://www.x.ai/bot/marketplace/bots/trip_planner/?ref=share "), "https://x.ai/bot/marketplace/bots/trip_planner");
  for (const bad of ["http://x.ai/bot/marketplace/bots/a", "https://x.ai.evil.com/bot/marketplace/bots/a", "https://x.ai/bot/marketplace/bots/../a", "https://evil.com/?u=https://x.ai/bot/marketplace/bots/a", "https://x.ai/other/a"]) {
    assert.equal(grokBotUrl(bad), undefined, bad);
  }
});

/* ── OpenClaw ─────────────────────────────────────────────────────────── */

const WORKSPACE = [
  file("nova-agent/SOUL.md", "# SOUL.md - Who You Are\n\nYou are Nova. Be warm, be brief.\n"),
  file("nova-agent/IDENTITY.md", "# IDENTITY.md - Who Am I?\n\n- **Name:** Nova\n- **Creature:**\n  _(AI? robot? familiar?)_\n- **Vibe:** warm and sharp\n- **Emoji:** 🦊\n- **Avatar:** avatars/nova.png\n\nNotes:\n\n- Save this file at the workspace root.\n"),
  file("nova-agent/AGENTS.md", "# AGENTS.md\n\nRead memory/YYYY-MM-DD.md every session.\n"),
  file("nova-agent/USER.md", "# USER.md\n\n- **Name:** Dani\n- **Timezone:** Europe/Madrid\n"),
  file("nova-agent/MEMORY.md", "# MEMORY.md\n\nLong-term notes.\n\n## Projects\nHUI is a Lit app.\n\n## Preferences\nShort answers.\nNo emojis.\n"),
  file("nova-agent/HEARTBEAT.md", "# HEARTBEAT.md\n\n# Keep this file empty to skip heartbeats.\n\nCheck that the nightly build is green.\n"),
  file("nova-agent/TOOLS.md", "# TOOLS.md\n\nCamera: front door.\n"),
  file("nova-agent/BOOTSTRAP.md", "# BOOTSTRAP.md\n"),
  file("nova-agent/memory/2026-10-01.md", "Did things.\n"),
  file("nova-agent/skills/weather/SKILL.md", "---\nname: weather\ndescription: Current weather and forecasts\n---\n\nUse wttr.in for the forecast.\n"),
  file("nova-agent/skills/weather/scripts/get.sh", "curl wttr.in\n"),
];

test("an OpenClaw workspace: SOUL.md, IDENTITY.md's name, emoji and vibe, memories, its heartbeat as a routine, its skills; AGENTS.md left out with the reason", () => {
  const template = parseOpenClawWorkspace(WORKSPACE, "nova-agent.zip");
  assert.equal(template.format, "openclaw");
  assert.equal(template.name, "Nova");
  assert.equal(template.emoji, "🦊");
  assert.equal(template.description, "warm and sharp");
  assert.equal(template.title, undefined, "the creature line still holds the template's hint");
  assert.equal(template.soul, "# SOUL.md - Who You Are\n\nYou are Nova. Be warm, be brief.");
  assert.deepEqual(template.memories.map((memory) => memory.name ?? ""), ["", "Projects", "Preferences", "About the operator (USER.md)"]);
  assert.deepEqual(template.routines, [{ name: "Heartbeat", prompt: "Check that the nightly build is green.", schedule: "every 30m", description: "HEARTBEAT.md, which OpenClaw checks about every 30 minutes." }]);
  assert.deepEqual(template.skills, [{ name: "weather", description: "Current weather and forecasts", content: "Use wttr.in for the forecast." }]);
  const dropped = template.dropped.join("\n");
  assert.match(dropped, /AGENTS\.md: OpenClaw's operating manual/u);
  assert.match(dropped, /TOOLS\.md/u);
  assert.match(dropped, /BOOTSTRAP\.md/u);
  assert.match(dropped, /1 daily memory log/u);
  assert.match(dropped, /avatar \(avatars\/nova\.png\)/u);
  assert.match(dropped, /Skill weather: 1 supporting file/u);
});

test("IDENTITY.md reads plain and bold lines, values on the next line, and skips its template's hints; a blank USER.md stays out", () => {
  const fields = identityFields("- Name: Rex\n- **Emoji**: 🐶\n- **Vibe:**\n  calm\n- **Creature:** _(pick one)_\n");
  assert.deepEqual([...fields], [["name", "Rex"], ["emoji", "🐶"], ["vibe", "calm"]]);
  const template = parseOpenClawWorkspace([file("SOUL.md", "Hi"), file("USER.md", "# USER.md\n\n- **Name:**\n- **Pronouns:** _(optional)_\n")]);
  assert.equal(template.memories.length, 0);
  assert.equal(template.name, "OpenClaw Bot");
});

/* ── Claude Code ──────────────────────────────────────────────────────── */

test("a Claude Code subagent: its name as a display name, its tools list, MCP tools as integrations, its model and color", () => {
  const template = parseClaudeCodeAgent("---\nname: code-reviewer\ndescription: Reviews code for quality. Use after edits.\ntools: Read, Grep, Glob, Bash, mcp__github__create_issue\nmodel: sonnet\ncolor: purple\npermissionMode: plan\n---\nYou are a senior code reviewer.\n\nBe specific.\n", ".claude/agents/code-reviewer.md");
  assert.equal(template.name, "Code Reviewer");
  assert.equal(template.description, "Reviews code for quality. Use after edits.");
  assert.equal(template.soul, "You are a senior code reviewer.\n\nBe specific.");
  assert.deepEqual(template.tools, ["Read", "Grep", "Glob", "Bash"]);
  assert.deepEqual(template.integrations, [{ name: "mcp__github__create_issue", description: "create_issue of the github MCP server" }]);
  assert.equal(template.model, "sonnet");
  assert.equal(template.avatar?.color, BOT_FACE_COLORS.find((color) => color.id === "lilac")!.hex);
  assert.match(template.dropped.join("\n"), /Front matter permissionMode/u);
  const listed = parseClaudeCodeAgent("---\nname: helper\ndescription: Helps\ntools:\n  - Read\n  - Write\nmodel: inherit\n---\nHelp.\n");
  assert.deepEqual(listed.tools, ["Read", "Write"]);
  assert.equal(listed.model, undefined, "inherit is the parent's model: nothing to keep");
  assert.equal(parseClaudeCodeAgent("---\nname: open\ndescription: All tools\n---\nGo.\n").tools, undefined, "no list: every tool, so no restriction");
});

/* ── Letta ────────────────────────────────────────────────────────────── */

const LETTA_STOCK = "You are Letta, the latest version of Limnal Corporation's digital companion. Your core memory unit is held inside the initial system instructions. Use archival memory for facts.";

test("a Letta agent file with blocks and tools by id: the persona is the soul, Letta's stock prompt and memory tools stay out, the history is skipped", () => {
  const [entry, ...rest] = parseLettaAgentFile({
    agents: [{ name: "Companion", system: LETTA_STOCK, block_ids: ["block-0", "block-1", "block-2"], tool_ids: ["tool-0", "tool-1", "tool-2"], llm_config: { model: "gpt-4o-mini", model_endpoint_type: "openai" }, messages: [{}, {}, {}] }],
    blocks: [{ id: "block-0", label: "persona", value: "I am Sam, a curious companion." }, { id: "block-1", label: "human", value: "Name: Chad" }, { id: "block-2", label: "projects", value: "Building HUI" }],
    tools: [{ id: "tool-0", name: "send_message" }, { id: "tool-1", name: "web_search", description: "Search the web" }, { id: "tool-2", name: "roll_dice", source_code: "def roll_dice():\n    return 4" }],
  }, "companion.af");
  assert.equal(rest.length, 0);
  const template = entry!.template;
  assert.equal(template.name, "Companion");
  assert.equal(template.soul, "I am Sam, a curious companion.");
  assert.deepEqual(template.memories, [{ name: "About the operator", text: "Name: Chad" }, { name: "projects", text: "Building HUI" }]);
  assert.deepEqual(template.integrations, [{ name: "web_search", description: "Search the web" }, { name: "roll_dice" }]);
  assert.equal(template.model, "openai/gpt-4o-mini");
  const dropped = template.dropped.join("\n");
  assert.match(dropped, /Letta's stock prompt/u);
  assert.match(dropped, /memory and messaging tools \(send_message\)/u);
  assert.match(dropped, /3 messages of its history/u);
  assert.match(template.notes.join("\n"), /custom tools' code is not imported/u);
  assert.equal(isStockLettaPrompt("Be concise."), false);
});

test("an older single-agent file keeps its own system prompt under Instructions; several agents are several candidates", () => {
  const [old] = parseLettaAgentFile({ name: "Helper", system: "Be helpful and concise.", core_memory: [{ label: "persona", value: "I help." }], tools: [{ name: "core_memory_append" }], llm_config: { handle: "anthropic/claude-sonnet-4-5" } });
  assert.equal(old!.template.soul, "I help.\n\n## Instructions\n\nBe helpful and concise.");
  assert.equal(old!.template.model, "anthropic/claude-sonnet-4-5");
  const both = readTextTemplates(JSON.stringify({ agents: [{ name: "A", system: "One." }, { name: "B", system: "Two." }] }), "pair.af");
  assert.deepEqual(both.map((choice) => [choice.key, choice.template.name, choice.template.soul]), [["0", "A", "One."], ["1", "B", "Two."]]);
});

/* ── character cards ──────────────────────────────────────────────────── */

const CARD_V2 = {
  spec: "chara_card_v2", spec_version: "2.0",
  data: {
    name: "Aria", description: "{{char}} is a librarian who helps {{user}}.", personality: "Kind and precise", scenario: "A quiet library at dusk",
    first_mes: "*{{char}} looks up at {{user}}* Welcome back!", mes_example: "<START>\n{{user}}: Hi", system_prompt: "{{original}}\nStay in character.",
    post_history_instructions: "Never break character.", alternate_greetings: ["Hello there"], creator: "Ada", tags: ["fantasy"],
    character_book: { entries: [{ keys: ["library", "hours"], content: "The library opens at 9.", enabled: true, name: "Hours" }, { keys: ["vault"], content: "Hidden", enabled: false }, { keys: ["cat"], content: "{{char}} has a cat.", enabled: true }] },
  },
};

test("a V2 card: system prompt, description, personality and scenario as the soul, first_mes as the opener, book entries as memories, macros filled in", () => {
  const template = parseCharacterCard(CARD_V2, "aria.json", { operator: "Dani" });
  assert.equal(template.name, "Aria");
  assert.equal(template.author, "Ada");
  assert.equal(template.soul, "Stay in character.\n\n## Who I am\n\nAria is a librarian who helps Dani.\n\n## Personality\n\nKind and precise\n\n## Scenario\n\nA quiet library at dusk");
  assert.equal(template.opener, "*Aria looks up at Dani* Welcome back!");
  assert.deepEqual(template.memories, [{ name: "Hours", text: "The library opens at 9." }, { name: "cat", text: "Aria has a cat." }]);
  const dropped = template.dropped.join("\n");
  assert.match(dropped, /1 disabled character book entry/u);
  assert.match(dropped, /example messages, its post-history instructions, 1 alternate greeting/u);
  const anonymous = parseCharacterCard(CARD_V2);
  assert.match(anonymous.soul, /helps the operator\./u);
  assert.equal(anonymous.opener, "*Aria looks up at you* Welcome back!");
});

/** A PNG holding a text chunk. */
function pngWith(keyword: string, text: string): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", Buffer.alloc(13)), chunk("tEXt", Buffer.from(`${keyword}\0${text}`, "latin1")), chunk("IEND", Buffer.alloc(0))]);
}

test("a V3 card inside a PNG's ccv3 chunk, and a V1 card, import too; an image without a card is refused", () => {
  const v3 = { spec: "chara_card_v3", spec_version: "3.0", data: { name: "Bolt", nickname: "The courier", description: "Fast.", first_mes: "Package for {{user}}!", personality: "", scenario: "" } };
  const image = pngWith("ccv3", Buffer.from(JSON.stringify(v3)).toString("base64"));
  assert.equal((cardFromPng(image) as { data: { name: string } }).data.name, "Bolt");
  const [choice] = readFileTemplates("bolt.png", image);
  assert.equal(choice!.template.format, "character-card");
  assert.equal(choice!.template.name, "Bolt");
  assert.equal(choice!.template.title, "The courier");
  assert.equal(choice!.template.opener, "Package for you!");
  assert.match(choice!.template.dropped.join("\n"), /Its picture/u);
  const v1 = readTextTemplates(JSON.stringify({ name: "Old", first_mes: "Hey.", personality: "Grumpy" }), "old.json");
  assert.equal(v1[0]!.template.soul, "## Personality\n\nGrumpy");
  assert.throws(() => readFileTemplates("plain.png", pngWith("Software", "paint")), /an image without a character card/u);
});

/* ── CrewAI ───────────────────────────────────────────────────────────── */

const CREW = "researcher:\n  role: >\n    {topic} Senior Data Researcher\n  goal: >\n    Uncover cutting-edge developments in {topic}\n  backstory: >\n    You're a seasoned researcher.\n  llm: openai/gpt-4o\n  tools:\n    - SerperDevTool\nreporting_analyst:\n  role: Reporting Analyst\n  goal: Create detailed reports\n  backstory: You're meticulous.\n  verbose: true\n";

test("CrewAI agents.yaml: each agent a candidate, role as title, goal and backstory as the soul, placeholders flagged", () => {
  const agents = parseCrewAiAgents(CREW, "config/agents.yaml");
  assert.deepEqual(agents.map((agent) => agent.key), ["researcher", "reporting_analyst"]);
  const [researcher, analyst] = agents.map((agent) => agent.template);
  assert.equal(researcher!.name, "Researcher");
  assert.equal(researcher!.title, "{topic} Senior Data Researcher");
  assert.equal(researcher!.soul, "## Goal\n\nUncover cutting-edge developments in {topic}\n\n## Backstory\n\nYou're a seasoned researcher.");
  assert.equal(researcher!.model, "openai/gpt-4o");
  assert.deepEqual(researcher!.integrations, [{ name: "SerperDevTool" }]);
  assert.match(researcher!.notes.join("\n"), /placeholders \{topic\}/u);
  assert.equal(analyst!.name, "Reporting Analyst");
  assert.match(analyst!.dropped.join("\n"), /CrewAI settings verbose/u);
});

/* ── HUI's own export ──────────────────────────────────────────────────── */

test("a version 1 HUI export reads back whole: profile, soul, its own skills, exact routines, lists, and the memory after its line", () => {
  const manifest = {
    format: "hui-bot" as const, version: 1 as const, exportedAt: "2026-10-07T10:00:00.000Z",
    bot: { name: "Ada", handle: "ada", title: "Planner", avatar: { emoji: "🦉", shape: "heart" as const, ears: "bear" as const, color: "#2fc49a" }, model: "hui-e2e/fixture", thinking: "high", memoryModel: "hui-e2e/other", voice: { language: "es" as const }, tagging: "mention" as const },
    routines: [{ name: "Digest", prompt: "Sum up the day.", schedule: { kind: "cron" as const, expression: "0 18 * * *", timezone: "Europe/Madrid" }, enabled: true }],
    disabledTools: ["bash"], disabledSkills: [{ name: "release-notes", path: "/x/release-notes/SKILL.md" }], skills: ["plans"], memory: "memory.md" as const,
  };
  const zip = writeZip([
    file("bot.json", JSON.stringify(manifest)), file("SOUL.md", "# Who I am\n\nAda plans.\n"),
    file("skills/plans/SKILL.md", "---\nname: plans\ndescription: Plan a week\n---\n\nPlan it.\n"),
    file("memory.md", "# Memory of @ada (Ada)\n\nIntro for people.\n\n---\n\n<chat>\n0+3|user: plan my week\n</chat>\n"),
  ]);
  const [choice] = readFileTemplates("ada.hui-bot.zip", zip);
  const template = choice!.template;
  assert.deepEqual([template.format, template.name, template.title, template.emoji, template.avatar, template.model], ["hui", "Ada", "Planner", "🦉", { shape: "heart", ears: "bear", color: "#2fc49a" }, "hui-e2e/fixture"]);
  assert.deepEqual(template.hui, { handle: "ada", thinking: "high", memoryModel: "hui-e2e/other", voice: { language: "es" }, tagging: "mention", disabledTools: ["bash"], disabledSkills: ["release-notes"] });
  assert.equal(template.soul, "# Who I am\n\nAda plans.");
  assert.deepEqual(template.skills, [{ name: "plans", description: "Plan a week", content: "Plan it." }]);
  assert.deepEqual(template.routines, [{ name: "Digest", prompt: "Sum up the day.", automation: { kind: "cron", expression: "0 18 * * *", timezone: "Europe/Madrid" }, schedule: "cron 0 18 * * * Europe/Madrid" }]);
  assert.deepEqual(template.memories, [{ name: "Memory of @ada when it was exported", text: "<chat>\n0+3|user: plan my week\n</chat>" }], "only what follows the line");
  assert.throws(() => readFileTemplates("future.zip", writeZip([{ path: "bot.json", data: Buffer.from(JSON.stringify({ ...manifest, version: 3 })) }])), /exported by a newer HUI/u);
});

test("a version 2 HUI template brings its open points, needs, triggers and the text files beside its skills; a cron runs in the importer's zone", () => {
  const manifest = {
    format: "hui-bot", version: 2,
    bot: { name: "{{user}}'s reviewer", model: "claude-sonnet-4-5" },
    routines: [{ name: "Sweep", prompt: "Review what waits.", schedule: { kind: "cron", expression: "0 9 * * 1-5" } }, { name: "Often", prompt: "Look.", schedule: { kind: "every", everyMs: 1_800_000 } }],
    triggers: [
      { name: "Reviews", filter: { prLinks: true, match: { field: "fields.channel", op: "equals", value: "reviews" } }, prompt: "Review it.", cooldownSeconds: 60, delivery: "steer" },
      { name: "reviews", filter: {}, cooldownSeconds: 60 }, { name: "", filter: {} },
    ],
    disabledTools: ["bash"], disabledSkills: ["review"], skills: ["review"],
    open: [{ kind: "ask", where: "SOUL.md", question: "Which repositories should I watch?" }, { kind: "confirm", where: "Trigger “Reviews”", question: "Keep it?", excerpt: "Review it.", operator: true }, { kind: "maybe", question: "x" }],
    needs: ["The GitHub CLI signed in", "The GitHub CLI signed in", " "],
  };
  const zip = writeZip([
    file("bot.json", JSON.stringify(manifest)), file("SOUL.md", "# Who I am\n\nI review [ask: the repositories to watch].\n"),
    file("skills/review/SKILL.md", "---\nname: review\ndescription: Review a pull request\n---\n\nRun scripts/approve.sh.\n"),
    file("skills/review/scripts/approve.sh", "#!/bin/sh\ngh pr review \"$1\" --approve\n"),
    { path: "skills/review/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]) },
  ]);
  const template = readFileTemplates("reviewer.hui-bot.zip", zip)[0]!.template;
  assert.equal(template.name, "{{user}}'s reviewer", "{{user}} stays until an import fills it in");
  assert.equal(template.hui?.handle, undefined, "a template carries no handle");
  assert.deepEqual(template.skills, [{ name: "review", description: "Review a pull request", content: "Run scripts/approve.sh.", files: [{ path: "scripts/approve.sh", text: "#!/bin/sh\ngh pr review \"$1\" --approve\n" }] }]);
  assert.match(template.dropped.join("\n"), /Skill review: logo\.png \(not text\)\./u);
  assert.deepEqual(template.routines.map((routine) => [routine.schedule, routine.automation]), [["cron 0 9 * * 1-5", undefined], ["every 30m", { kind: "every", everyMs: 1_800_000 }]]);
  assert.deepEqual(template.triggers, [{ name: "Reviews", filter: { prLinks: true, match: { field: "fields.channel", op: "equals", value: "reviews" } }, prompt: "Review it.", cooldownSeconds: 60, delivery: "steer" }]);
  assert.match(template.dropped.join("\n"), /Trigger reviews: another one has its name\./u);
  assert.match(template.dropped.join("\n"), /A trigger HUI can't read\./u);
  assert.deepEqual(template.open, [{ kind: "ask", where: "SOUL.md", question: "Which repositories should I watch?" }, { kind: "confirm", where: "Trigger “Reviews”", question: "Keep it?", excerpt: "Review it.", operator: true }]);
  assert.deepEqual(template.needs, ["The GitHub CLI signed in"]);
  assert.deepEqual(template.memories, []);
});

/* ── detection ────────────────────────────────────────────────────────── */

test("detection picks the importer by content: archives, folders, JSON, front matter, YAML, else plain text", () => {
  const zip = writeZip(WORKSPACE.map((entry) => ({ path: entry.path, data: entry.data })));
  assert.equal(readFileTemplates("nova.zip", zip)[0]!.template.name, "Nova");
  assert.equal(readFileTemplates("agents.yaml", Buffer.from(CREW)).length, 2);
  assert.equal(readFileTemplates("reviewer.md", Buffer.from("---\nname: reviewer\ndescription: Reviews\n---\nReview.\n"))[0]!.template.format, "claude-code");
  const agents = readFolderTemplates([file("repo/.claude/agents/a.md", "---\nname: a\ndescription: A\n---\nA."), file("repo/.claude/agents/b.md", "---\nname: b\ndescription: B\n---\nB."), file("repo/README.md", "# Repo")]);
  assert.deepEqual(agents.map((agent) => agent.template.name), ["A", "B"]);
  assert.equal(readTextTemplates(nextPage(grokPayload()), undefined)[0]!.template.format, "grok", "a pasted page source");
  const text = readTextTemplates("# Nova\n\nYou are Nova.", undefined)[0]!.template;
  assert.deepEqual([text.format, text.name, text.soul], ["text", "Nova", "# Nova\n\nYou are Nova."]);
  assert.equal(parseTextTemplate("Be terse.").name, "Imported Bot");
  assert.equal(parseTextTemplate("Be terse.", "night-owl.txt").name, "Night Owl");
  assert.throws(() => readTextTemplates("[1, 2, 3]", undefined), /found no bot to import in this JSON/u);
  assert.throws(() => readFileTemplates("x.yaml", Buffer.from("foo: bar\n")), /found no bot to import in this YAML file/u);
  assert.throws(() => readTextTemplates("   ", undefined), /nothing to import/u);
  assert.throws(() => readFolderTemplates([file("a.txt", "x"), file("b.txt", "y")], {}, "stuff"), /found no bot to import in stuff/u);
  assert.throws(() => readFileTemplates("blob.bin", Buffer.from([0, 1, 2, 3])), /neither text nor a format HUI reads/u);
});
