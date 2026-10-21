/**
 * HUI's system prompt for Durable conversations, built by PI's own section
 * builder from PI's resource loader: SYSTEM.md / HUI's default preamble,
 * APPEND_SYSTEM, AGENTS.md context files, skills and the working directory,
 * plus HUI's presentation and active-tool sections. This loader runs with no
 * extensions; a session's PI extensions (`durable-extensions.ts`) add their
 * tools' snippets and may change the prompt of a run, as in PI. Skills load per
 * directory, and a bot's chat adds its own (`skills/` in its home folder,
 * `bots/skills.ts`); it lists only the ones the operator left on
 * (`bots/durable-access.ts`), so two chats in one directory can differ. A
 * session on Ultra adds OpenClaw's plan, delegate and verify section.
 */
import { DefaultResourceLoader, type BuildSystemPromptOptions, type Skill } from "@earendil-works/pi-coding-agent";
import { defineExtension, section, type ConversationId, type PromptInput } from "@earendil-works/pi-durable";
import type { Settings } from "../hui-settings.ts";
import { enabledBundledSkillPaths, isBundledSkillPreference } from "../pi/bundled-skills.ts";
import { createPolicySettingsManager } from "./resource-policy.ts";
import { HUI_DEFAULT_PROMPT } from "./hui-prompt.ts";
import { HUI_PRESENTATION_PROMPT } from "./hui-presentation.ts";
import { huiToolDefinitions } from "./hui-tools.ts";
import type { Contribution, RunPrompt } from "./durable-extensions.ts";

export type PromptSettings = Pick<Settings, "disabledSkills" | "browser" | "codemode" | "disabledPlugins">;

/** The skills of a bot's chat: the ones it has of a directory's, and its own `skills` section when it loads them with
 * `load_skill`. */
export type BotSkills = {
  skills(skills: readonly Skill[]): Skill[];
  section(skills: readonly Skill[], selectedTools: readonly string[]): string | undefined;
};

/** What a conversation's PI extensions add: their tools' snippets, and the prompt `before_agent_start` gave the run. */
export type PromptExtras = { readonly contributions: Record<string, Contribution>; readonly run?: RunPrompt };

const internal = async <T>(path: string): Promise<T> =>
  await import(new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href) as T;
const { buildSystemPromptSections } = await internal<{ buildSystemPromptSections(input: BuildSystemPromptOptions): Record<string, string> }>("./core/system-prompt.js");
const PI_TOOL_CONTRIBUTIONS: Record<string, Contribution> = {
  read: (await internal<{ readToolSystemPromptContribution: Contribution }>("./core/tools/read.js")).readToolSystemPromptContribution,
  bash: (await internal<{ bashToolSystemPromptContribution: Contribution }>("./core/tools/bash.js")).bashToolSystemPromptContribution,
  edit: (await internal<{ editToolSystemPromptContribution: Contribution }>("./core/tools/edit.js")).editToolSystemPromptContribution,
  write: (await internal<{ writeToolSystemPromptContribution: Contribution }>("./core/tools/write.js")).writeToolSystemPromptContribution,
};
const HUI_TOOL_CONTRIBUTIONS: Record<string, Contribution> = {
  ...Object.fromEntries(huiToolDefinitions().map((tool) => [
    tool.name, { snippet: tool.promptSnippet ?? "", guidelines: tool.promptGuidelines ?? [] },
  ])),
};

/** PI's section order, then HUI's; the builder tags every section but the preamble. Sections an extension adds in
 * `before_agent_start` follow PI's, already tagged, in `extension_sections`. */
const SECTION_KEYS = [
  "preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd", "extension_sections",
  "hui_presentation", "hui_tools", "hui_tool_guidelines", "hui_ultra",
] as const;
const KNOWN_SECTIONS = new Set<string>(SECTION_KEYS);

/** Same text as the PI worker's `huiPromptExtension`. */
export function huiToolSections(selectedTools: readonly string[], contributions: Record<string, Contribution>): Record<string, string> {
  const activeTools = selectedTools.map((name) => {
    const snippet = contributions[name]?.snippet;
    return `- ${name}${snippet ? `: ${snippet}` : ""}`;
  }).join("\n");
  const guidelines = [...new Set(selectedTools.flatMap((name) => contributions[name]?.guidelines ?? []))]
    .map((line) => `- ${line}`).join("\n");
  return {
    hui_presentation: HUI_PRESENTATION_PROMPT,
    hui_tools: activeTools
      ? `Active callable tools for this turn (PI provides their full schemas separately):\n${activeTools}`
      : "No callable tools are active for this turn.",
    ...(guidelines ? { hui_tool_guidelines: guidelines } : {}),
  };
}

/** OpenClaw's Ultra guidance (`ultra-orchestration.ts`): delegation only where the request offers `sessions_spawn`. */
export function ultraSection(delegates: boolean): string {
  return [
    delegates ? "## Proactive Sub-Agent Orchestration" : "## Ultra Execution",
    "Ultra active for this session. Plan the work, carry it through, and verify the result before replying.",
    "Decide what you can: make easy or reversible choices yourself and list them in your reply. When a choice needs facts, find them instead of asking. Ask only before actions that are hard to undo or reach other people, or when the operator's instructions say to ask.",
    ...delegates ? [
      "Use `sessions_spawn` when independent work improves speed or quality.",
      "- Parallelize independent investigation, implementation and verification.",
      "- Keep simple or tightly coupled work local.",
      "- Give each subagent a bounded objective; synthesize the results before replying.",
    ] : [],
  ].join("\n");
}

export class DurablePrompt {
  readonly #agentDir: string;
  readonly #readSettings: () => Promise<PromptSettings>;
  /** Context files and skills load once per directory (and a bot's own skill folders), like a PI session. */
  #loaders = new Map<string, Promise<DefaultResourceLoader>>();
  #built = new WeakMap<PromptInput, Promise<Record<string, string>>>();
  /** The prompt of each conversation's latest request, as PI's `ctx.getSystemPrompt()` reports it. */
  #last = new Map<ConversationId, string>();
  /** A conversation's extension additions; the Durable host answers for live sessions. */
  extras: (conversationId: ConversationId) => PromptExtras | undefined = () => undefined;
  /** The skills of a bot's chat; undefined for every other conversation, which lists every skill of its directory. The
   * Durable host answers. */
  botSkillsFor: (conversationId: ConversationId) => Promise<BotSkills | undefined> = async () => undefined;
  /** What the bots' tools add to HUI's active-tool section; the Durable host sets it with its bots. */
  botContributions: Readonly<Record<string, Contribution>> = {};
  /** A bot's own skill folders, which only its chat loads; none for every other conversation. The Durable host answers. */
  skillDirsFor: (conversationId: ConversationId) => Promise<readonly string[]> = async () => [];
  /** Whether the conversation's session is on Ultra. The Durable host answers. */
  ultraFor: (conversationId: ConversationId) => boolean = () => false;
  readonly extension;

  constructor(agentDir: string, readSettings: () => Promise<PromptSettings>) {
    this.#agentDir = agentDir;
    this.#readSettings = readSettings;
    this.extension = defineExtension({
      name: "hui-prompt",
      sections: SECTION_KEYS.map((key) => section(key, async (input) => (await this.#build(input))[key], { tag: false })),
    });
  }

  /** PI resources for one working directory, honoring HUI's skill controls; `skillDirs` adds a bot's own skills, after
   * its directory's (a skill of the directory wins a shared name, as PI's own skills win over HUI's bundled ones). */
  loader(cwd: string, skillDirs: readonly string[] = []): Promise<DefaultResourceLoader> {
    const key = [cwd, ...skillDirs].join("\0");
    let loading = this.#loaders.get(key);
    if (!loading) {
      loading = this.#load(cwd, skillDirs);
      loading.catch(() => this.#loaders.delete(key));
      this.#loaders.set(key, loading);
    }
    return loading;
  }

  async #load(cwd: string, skillDirs: readonly string[]): Promise<DefaultResourceLoader> {
    const settings = await this.#readSettings();
    const disabled = settings.disabledSkills;
    // Bundled opt-out controls only the fallback; other skills are filtered by path.
    const disabledPaths = new Set(disabled.filter((entry) => !isBundledSkillPreference(entry)).map((entry) => entry.path));
    const loader = new DefaultResourceLoader({
      cwd, agentDir: this.#agentDir,
      // A disabled package contributes no skills or prompts either, as for the PI worker.
      settingsManager: createPolicySettingsManager({ cwd, agentDir: this.#agentDir, disabledIds: new Set(settings.disabledPlugins.map((plugin) => plugin.id)) }),
      additionalSkillPaths: [...skillDirs, ...enabledBundledSkillPaths(disabled)],
      noExtensions: true, noThemes: true,
      systemPromptOverride: (base) => base ?? HUI_DEFAULT_PROMPT,
      skillsOverride: (base) => ({ ...base, skills: base.skills.filter((skill) => !disabledPaths.has(skill.filePath)) }),
    });
    await loader.reload();
    return loader;
  }

  /** Re-read context files, skills and prompt templates for later requests. */
  reload(cwd?: string): void {
    if (!cwd) this.#loaders.clear();
    else for (const key of [...this.#loaders.keys()]) if (key === cwd || key.startsWith(`${cwd}\0`)) this.#loaders.delete(key);
  }

  #build(input: PromptInput): Promise<Record<string, string>> {
    let built = this.#built.get(input);
    if (!built) {
      built = this.#sections(input);
      this.#built.set(input, built);
    }
    return built;
  }

  /** The prompt a request with these tools would carry, for inspection. */
  async render(cwd: string, selectedTools: readonly string[], conversationId?: ConversationId): Promise<string> {
    return joined(await this.#sectionsFor(cwd, [...selectedTools], conversationId));
  }

  /** The prompt the conversation's latest request carried; empty before its first. */
  lastPrompt(conversationId: ConversationId): string {
    return this.#last.get(conversationId) ?? "";
  }

  async #sections(input: PromptInput): Promise<Record<string, string>> {
    const sections = await this.#sectionsFor(input.env?.cwd ?? input.agent.cwd ?? this.#agentDir, input.agent.tools.map((tool) => tool.name), input.conversationId);
    this.#last.set(input.conversationId, joined(sections));
    return sections;
  }

  /** PI's builder input for a request offering these tools. A bot's chat (`bot` given) lists only the skills the operator
   * left on: in PI's own section while it has read or bash, otherwise in one of HUI's that loads them with `load_skill`,
   * which such a chat is offered. */
  async options(cwd: string, selectedTools: readonly string[], extra: Record<string, Contribution> = {}, bot?: BotSkills, skillDirs: readonly string[] = [], ultra = false): Promise<BuildSystemPromptOptions> {
    const loader = await this.loader(cwd, skillDirs);
    const skills = bot ? bot.skills(loader.getSkills().skills) : loader.getSkills().skills;
    const own = bot?.section(skills, selectedTools);
    const contributions = { ...PI_TOOL_CONTRIBUTIONS, ...extra, ...this.botContributions, ...HUI_TOOL_CONTRIBUTIONS };
    const toolSnippets: Record<string, string> = {};
    const toolGuidelines: Record<string, string[]> = {};
    for (const name of selectedTools) {
      const contribution = contributions[name];
      if (!contribution) continue;
      if (contribution.snippet) toolSnippets[name] = contribution.snippet;
      toolGuidelines[name] = [...contribution.guidelines];
    }
    const custom = loader.getSystemPrompt();
    const append = loader.getAppendSystemPrompt().join("\n\n");
    return {
      ...(custom ? { customPrompt: custom } : {}),
      selectedTools: [...selectedTools], toolSnippets, toolGuidelines,
      ...(append ? { appendSystemPrompt: append } : {}),
      sections: {
        ...huiToolSections(selectedTools, contributions), ...(own ? { skills: own } : {}),
        ...(ultra ? { hui_ultra: ultraSection(selectedTools.includes("sessions_spawn")) } : {}),
      },
      cwd,
      contextFiles: loader.getAgentsFiles().agentsFiles,
      skills: own ? [] : skills,
    };
  }

  async #sectionsFor(cwd: string, selectedTools: string[], conversationId?: ConversationId): Promise<Record<string, string>> {
    const extras = conversationId === undefined ? undefined : this.extras(conversationId);
    const run = extras?.run;
    // A prompt an extension forced replaces the whole prompt for its run, as in PI.
    if (run?.forced !== undefined) return { preamble: run.forced };
    const bot = conversationId === undefined ? undefined : await this.botSkillsFor(conversationId);
    const skillDirs = conversationId === undefined ? [] : await this.skillDirsFor(conversationId);
    const ultra = conversationId !== undefined && this.ultraFor(conversationId);
    const base = await this.options(cwd, selectedTools, extras?.contributions, bot, skillDirs, ultra);
    const sections = buildSystemPromptSections(run?.options ? {
      ...run.options,
      // The run keeps the sections its extensions edited; the tool loadout stays the request's own, and so do a bot's
      // skills.
      selectedTools: base.selectedTools!,
      toolSnippets: { ...base.toolSnippets, ...run.options.toolSnippets },
      toolGuidelines: { ...base.toolGuidelines, ...run.options.toolGuidelines },
      sections: { ...run.options.sections, ...base.sections },
      ...(bot ? { skills: base.skills ?? [] } : {}),
    } : base);
    const added = Object.entries(sections).filter(([key]) => !KNOWN_SECTIONS.has(key)).map(([, text]) => text);
    return added.length ? { ...sections, extension_sections: added.join("\n\n") } : sections;
  }
}

const joined = (sections: Record<string, string>) => SECTION_KEYS.flatMap((key) => sections[key] ? [sections[key]] : []).join("\n\n");
