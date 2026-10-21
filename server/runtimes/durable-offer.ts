/**
 * The tool offer every Durable conversation shares, bots' chats or not: what
 * a tool and skill of a chat's offer look like, where a tool comes from, the
 * live chat a conversation answers through and a skill's instructions as the
 * model reads them. Bot policy over them lives in `bots/durable-access.ts`.
 */
import { readFileSync } from "node:fs";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { BotCatalogSkill, BotCatalogTool } from "../bots-format.ts";
import type { BotTurnOrigin } from "./turn-origins.ts";
import type { QuestionDraft } from "./question-box.ts";
import type { RuntimeQuestionResponse } from "./types.ts";

/** One tool of a bot's chat the operator can turn off, as the catalog and the access section describe it. */
export type OfferedTool = Omit<BotCatalogTool, "enabled">;
export type OfferedSkill = Omit<BotCatalogSkill, "enabled">;

/** Where a tool in a chat's offer comes from. */
export type ToolOrigin =
  | { kind: "coding" | "hui" | "bot" }
  | { kind: "extension"; source: string; label?: string; snippet?: string };

/** The live chat of a bot's conversation, which its own tools ask through. */
export interface BotChat {
  /** The tools the operator can turn off in this chat, as the latest tool offer found them. */
  botOffer(): readonly OfferedTool[];
  /** Skills a session in this chat's directory gets, Settings' choices applied. */
  availableSkills(): Promise<readonly Skill[]>;
  /** Asks the operator in this chat; undefined once dismissed, or when `signal` aborts first. Rejects with
   * `QuestionsClosedError` when the chat closes under the question. */
  ask(question: QuestionDraft, signal?: AbortSignal): Promise<RuntimeQuestionResponse | undefined>;
  /** Offers the conversation its tools again, after its lists changed. */
  applyTools(): Promise<void>;
  /** The message that started the run going now (or the latest one): who started the turn, as `botTurnOrigin` reads
   * it. */
  runInput(): string | undefined;
  /** The newest message the conversation took, read from its store: one that joined the running turn since (a follow-up
   * does, on a worker) is what its model answers then. */
  latestInput(): Promise<string | undefined>;
  /** Who brought each input of the run going now: its first message and every one it took since. */
  runOrigins(): Promise<readonly BotTurnOrigin[]>;
}

/** A skill's instructions as the model reads them, from `/skill:name` or `load_skill`: SKILL.md without its front
 * matter, with the directory its references are relative to. */
export function skillBlock(skill: Pick<Skill, "name" | "filePath" | "baseDir">): string {
  const body = readFileSync(skill.filePath, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "").trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}
