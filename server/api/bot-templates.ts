/** Public bot import and export payloads (HUI-18) and the JSON routes that exchange them; the export's zip is not one. */
import { Type, type Static } from "typebox";
import { AutomationSchedule } from "./automation.ts";
import { BotFaceEars, BotFaceShape, BotView, BotVoice } from "./bots.ts";
import { BotTriggerDelivery, BotTriggerFilter } from "./bot-triggers.ts";

const StoredTagging = Type.Enum(["mention", "nobody"] as const);
const TemplateAvatar = Type.Object({ shape: Type.Optional(BotFaceShape), ears: Type.Optional(BotFaceEars), color: Type.Optional(Type.String()) });

export const BotTemplateFormat = Type.Enum(["grok", "openclaw", "claude-code", "letta", "character-card", "crewai", "hui", "text"] as const, { $id: "BotTemplateFormat" });
export type BotTemplateFormat = Static<typeof BotTemplateFormat>;

export const BotTemplateSkillFile = Type.Object({ path: Type.String(), text: Type.String() }, { $id: "BotTemplateSkillFile" });
export type BotTemplateSkillFile = Static<typeof BotTemplateSkillFile>;

const BotTemplateSkillFields = {
  name: Type.String(), description: Type.String(), content: Type.String(), files: Type.Optional(Type.Array(BotTemplateSkillFile)),
};

export const BotTemplateSkill = Type.Object(BotTemplateSkillFields, { $id: "BotTemplateSkill" });
export type BotTemplateSkill = Static<typeof BotTemplateSkill>;

export const BotTemplateRoutine = Type.Object({
  name: Type.String(),
  prompt: Type.String(),
  schedule: Type.Optional(Type.String()),
  automation: Type.Optional(AutomationSchedule),
  description: Type.Optional(Type.String()),
}, { $id: "BotTemplateRoutine" });
export type BotTemplateRoutine = Static<typeof BotTemplateRoutine>;

export const BotTemplateMemory = Type.Object({ name: Type.Optional(Type.String()), text: Type.String() }, { $id: "BotTemplateMemory" });
export type BotTemplateMemory = Static<typeof BotTemplateMemory>;

const BotTemplateIntegrationFields = { name: Type.String(), description: Type.Optional(Type.String()) };

export const BotTemplateIntegration = Type.Object(BotTemplateIntegrationFields, { $id: "BotTemplateIntegration" });
export type BotTemplateIntegration = Static<typeof BotTemplateIntegration>;

export const BotOpenPoint = Type.Object({
  kind: Type.Enum(["ask", "confirm"] as const),
  where: Type.String(),
  question: Type.String(),
  excerpt: Type.Optional(Type.String()),
  operator: Type.Optional(Type.Literal(true)),
}, { $id: "BotOpenPoint" });
export type BotOpenPoint = Static<typeof BotOpenPoint>;

export const BotTemplateTrigger = Type.Object({
  name: Type.String(),
  filter: BotTriggerFilter,
  prompt: Type.Optional(Type.String()),
  delivery: Type.Optional(BotTriggerDelivery),
  cooldownSeconds: Type.Number(),
}, { $id: "BotTemplateTrigger" });
export type BotTemplateTrigger = Static<typeof BotTemplateTrigger>;

export const BotTemplate = Type.Object({
  format: BotTemplateFormat,
  origin: Type.Optional(Type.String()),
  author: Type.Optional(Type.String()),
  name: Type.String(),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  emoji: Type.Optional(Type.String()),
  avatar: Type.Optional(TemplateAvatar),
  soul: Type.String(),
  opener: Type.Optional(Type.String()),
  memories: Type.Array(BotTemplateMemory),
  skills: Type.Array(BotTemplateSkill),
  routines: Type.Array(BotTemplateRoutine),
  integrations: Type.Array(BotTemplateIntegration),
  model: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
  hui: Type.Optional(Type.Object({
    handle: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    memoryModel: Type.Optional(Type.String()),
    memoryThinking: Type.Optional(Type.String()),
    voice: Type.Optional(BotVoice),
    tagging: Type.Optional(StoredTagging),
    disabledTools: Type.Optional(Type.Array(Type.String())),
    disabledSkills: Type.Optional(Type.Array(Type.String())),
  })),
  open: Type.Optional(Type.Array(BotOpenPoint)),
  needs: Type.Optional(Type.Array(Type.String())),
  triggers: Type.Optional(Type.Array(BotTemplateTrigger)),
  dropped: Type.Array(Type.String()),
  notes: Type.Array(Type.String()),
}, { $id: "BotTemplate" });
export type BotTemplate = Static<typeof BotTemplate>;

export const BotImportSource = Type.Union([
  Type.Object({ kind: Type.Literal("file"), name: Type.String(), data: Type.String() }),
  Type.Object({ kind: Type.Literal("files"), files: Type.Array(Type.Object({ path: Type.String(), data: Type.String() })) }),
  Type.Object({ kind: Type.Literal("url"), url: Type.String() }),
  Type.Object({ kind: Type.Literal("text"), text: Type.String() }),
], { $id: "BotImportSource" });
export type BotImportSource = Static<typeof BotImportSource>;

export const BotImportRoutine = Type.Object({
  name: Type.String(), prompt: Type.String(), schedule: AutomationSchedule, scheduleText: Type.Optional(Type.String()), guessed: Type.Boolean(),
}, { $id: "BotImportRoutine" });
export type BotImportRoutine = Static<typeof BotImportRoutine>;

export const BotImportPreview = Type.Object({
  template: BotTemplate,
  candidates: Type.Optional(Type.Array(Type.Object({ key: Type.String(), name: Type.String(), title: Type.Optional(Type.String()) }))),
  pick: Type.Optional(Type.String()),
  bot: Type.Object({
    name: Type.String(),
    handle: Type.String(),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    emoji: Type.Optional(Type.String()),
    avatar: Type.Optional(TemplateAvatar),
    worker: Type.Optional(Type.Object({ id: Type.String(), name: Type.String() })),
  }),
  soul: Type.String(),
  opener: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  utilityModel: Type.Optional(Type.String()),
  memories: Type.Object({ included: Type.Number(), total: Type.Number() }),
  skills: Type.Array(Type.Object({ ...BotTemplateSkillFields, original: Type.String() })),
  routines: Type.Array(BotImportRoutine),
  integrations: Type.Array(Type.Object({ ...BotTemplateIntegrationFields, tool: Type.Optional(Type.Object({ name: Type.String(), label: Type.String() })) })),
  disabledTools: Type.Array(Type.String()),
  disabledSkills: Type.Array(Type.String()),
  open: Type.Array(BotOpenPoint),
  needs: Type.Array(Type.String()),
  triggers: Type.Array(BotTemplateTrigger),
  dropped: Type.Array(Type.String()),
  notes: Type.Array(Type.String()),
}, { $id: "BotImportPreview" });
export type BotImportPreview = Static<typeof BotImportPreview>;

export const BotImportPreviewRequest = Type.Object({
  source: BotImportSource, pick: Type.Optional(Type.String()), worker: Type.Optional(Type.String()),
}, { $id: "BotImportPreviewRequest" });
export type BotImportPreviewRequest = Static<typeof BotImportPreviewRequest>;

export const BotImportRequest = Type.Object({ template: BotTemplate, worker: Type.Optional(Type.String()) }, { $id: "BotImportRequest" });
export type BotImportRequest = Static<typeof BotImportRequest>;

export const BotImportResult = Type.Object({
  bot: BotView, skills: Type.Array(Type.String()), routines: Type.Number(), opener: Type.Boolean(), warnings: Type.Array(Type.String()),
}, { $id: "BotImportResult" });
export type BotImportResult = Static<typeof BotImportResult>;

export const BotExportGroup = Type.Enum(["keep", "remove", "ask", "confirm"] as const, { $id: "BotExportGroup" });
export type BotExportGroup = Static<typeof BotExportGroup>;

export const BotExportAddition = Type.Object({
  quote: Type.String(), group: Type.Enum(["remove", "ask", "confirm"] as const), becomes: Type.Optional(Type.String()),
}, { $id: "BotExportAddition" });
export type BotExportAddition = Static<typeof BotExportAddition>;

export const BotExportSchedule = Type.Union([
  Type.Object({ kind: Type.Literal("every"), everyMs: Type.Number() }),
  Type.Object({ kind: Type.Literal("cron"), expression: Type.String() }),
], { $id: "BotExportSchedule" });
export type BotExportSchedule = Static<typeof BotExportSchedule>;

export const BotExportField = Type.Object({ key: Type.String(), text: Type.String() }, { $id: "BotExportField" });
export type BotExportField = Static<typeof BotExportField>;

export const BotExportPart = Type.Object({
  id: Type.String(),
  label: Type.String(),
  kind: Type.Enum(["text", "script"] as const),
  fields: Type.Array(BotExportField),
  read: Type.Boolean(),
  unread: Type.Optional(Type.String()),
}, { $id: "BotExportPart" });
export type BotExportPart = Static<typeof BotExportPart>;

export const BotExportChange = Type.Object({
  id: Type.String(),
  part: Type.String(),
  quote: Type.String(),
  group: BotExportGroup,
  reason: Type.String(),
  replacement: Type.String(),
  label: Type.String(),
  question: Type.String(),
}, { $id: "BotExportChange" });
export type BotExportChange = Static<typeof BotExportChange>;

export const BotExportFileChange = Type.Object({
  id: Type.String(), part: Type.String(), group: Type.Enum(["keep", "remove", "confirm"] as const), reasons: Type.Array(Type.String()), question: Type.String(),
}, { $id: "BotExportFileChange" });
export type BotExportFileChange = Static<typeof BotExportFileChange>;

export const BotExportCleanup = Type.Object({
  part: Type.String(), field: Type.String(), kind: Type.String(), sample: Type.String(), count: Type.Number(),
}, { $id: "BotExportCleanup" });
export type BotExportCleanup = Static<typeof BotExportCleanup>;

export const BotExportAvatar = Type.Object({
  emoji: Type.Optional(Type.String()), shape: Type.Optional(BotFaceShape), ears: Type.Optional(BotFaceEars), color: Type.Optional(Type.String()),
}, { $id: "BotExportAvatar" });
export type BotExportAvatar = Static<typeof BotExportAvatar>;

export const BotExportMeta = Type.Object({
  avatar: Type.Optional(BotExportAvatar),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  memoryModel: Type.Optional(Type.String()),
  memoryThinking: Type.Optional(Type.String()),
  voice: Type.Optional(BotVoice),
  tagging: Type.Optional(StoredTagging),
  routines: Type.Array(Type.Object({ schedule: BotExportSchedule })),
  triggers: Type.Array(Type.Object({ filter: BotTriggerFilter, delivery: Type.Optional(BotTriggerDelivery), cooldownSeconds: Type.Number() })),
  disabledTools: Type.Array(Type.String()),
  disabledSkills: Type.Array(Type.String()),
  skills: Type.Array(Type.String()),
}, { $id: "BotExportMeta" });
export type BotExportMeta = Static<typeof BotExportMeta>;

export const BotExportReview = Type.Object({
  id: Type.String(),
  botId: Type.String(),
  name: Type.String(),
  model: Type.Optional(Type.String()),
  warning: Type.Optional(Type.String()),
  parts: Type.Array(BotExportPart),
  cleanup: Type.Array(BotExportCleanup),
  changes: Type.Array(BotExportChange),
  files: Type.Array(BotExportFileChange),
  needs: Type.Array(Type.Object({ id: Type.String(), text: Type.String() })),
  leftOut: Type.Array(Type.String()),
  meta: BotExportMeta,
}, { $id: "BotExportReview" });
export type BotExportReview = Static<typeof BotExportReview>;

export const routeSchemas = [
  { method: "POST", path: "/__hui/bots/import/preview", request: BotImportPreviewRequest, response: BotImportPreview },
  { method: "POST", path: "/__hui/bots/import", request: BotImportRequest, response: BotImportResult },
  { method: "POST", path: "/__hui/bots/:id/export/review", response: BotExportReview },
];
