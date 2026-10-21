/** Public bot payloads (HUI-18) and the routes that exchange them; the bot registry's stored records are not ones. */
import { Type, type Static } from "typebox";

export const VoiceLanguage = Type.Enum([
  "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi",
  "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml",
  "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs",
  "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am",
  "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln",
  "ha", "ba", "jw", "su", "yue"
] as const, { $id: "VoiceLanguage" });
export type VoiceLanguage = Static<typeof VoiceLanguage>;

export const GptLiveVoice = Type.Enum(["cove", "arbor", "breeze", "ember", "juniper", "maple", "sol", "spruce", "vale"] as const, { $id: "GptLiveVoice" });
export type GptLiveVoice = Static<typeof GptLiveVoice>;

export const BotVoice = Type.Object({ language: Type.Optional(VoiceLanguage), live: Type.Optional(GptLiveVoice) }, { $id: "BotVoice" });
export type BotVoice = Static<typeof BotVoice>;

export const BotTagging = Type.Enum(["anyone", "mention", "nobody"] as const, { $id: "BotTagging" });
export type BotTagging = Static<typeof BotTagging>;

const StoredTagging = Type.Enum(["mention", "nobody"] as const);

export const BotFaceShape = Type.Enum([
  "blob", "round", "triangle", "heart", "cookie", "star", "flower", "cloud", "drop", "ghost", "pill", "block", "hexagon",
] as const, { $id: "BotFaceShape" });
export type BotFaceShape = Static<typeof BotFaceShape>;

export const BotFaceEars = Type.Enum(["cat", "bear", "bunny", "antenna", "sprout", "horns"] as const, { $id: "BotFaceEars" });
export type BotFaceEars = Static<typeof BotFaceEars>;

export const BotAvatar = Type.Object({
  emoji: Type.Optional(Type.String()), color: Type.Optional(Type.String()), shape: Type.Optional(BotFaceShape), ears: Type.Optional(BotFaceEars),
}, { $id: "BotAvatar" });
export type BotAvatar = Static<typeof BotAvatar>;

export const BotSkillRef = Type.Object({ name: Type.String(), path: Type.String() }, { $id: "BotSkillRef" });
export type BotSkillRef = Static<typeof BotSkillRef>;

export const BotSkillSelector = Type.Union([Type.String(), BotSkillRef], { $id: "BotSkillSelector" });
export type BotSkillSelector = Static<typeof BotSkillSelector>;

export const BotSessionStatus = Type.Enum(["idle", "running", "waiting", "starting", "error", "reconnecting", "disconnected"] as const, { $id: "BotSessionStatus" });
export type BotSessionStatus = Static<typeof BotSessionStatus>;

export const BotMemoryUsage = Type.Object({
  calls: Type.Number(), input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), cost: Type.Number(),
}, { $id: "BotMemoryUsage" });
export type BotMemoryUsage = Static<typeof BotMemoryUsage>;

export const BotMemoryStatus = Type.Object({
  messages: Type.Number(),
  built: Type.Number(),
  pending: Type.Number(),
  viewBytes: Type.Number(),
  viewLines: Type.Number(),
  waiting: Type.Optional(Type.Boolean()),
  failing: Type.Optional(Type.Object({ node: Type.String(), error: Type.String(), since: Type.String() })),
  usage: BotMemoryUsage,
}, { $id: "BotMemoryStatus" });
export type BotMemoryStatus = Static<typeof BotMemoryStatus>;

export const BotLastMessage = Type.Object({
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), text: Type.String(), at: Type.String(),
}, { $id: "BotLastMessage" });
export type BotLastMessage = Static<typeof BotLastMessage>;

export const BotView = Type.Object({
  id: Type.String(),
  handle: Type.String(),
  name: Type.String(),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  tagging: Type.Optional(StoredTagging),
  cwd: Type.String(),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  memoryModel: Type.Optional(Type.String()),
  memoryThinking: Type.Optional(Type.String()),
  avatar: Type.Optional(BotAvatar),
  voice: Type.Optional(BotVoice),
  hidden: Type.Optional(Type.Boolean()),
  archived: Type.Optional(Type.Boolean()),
  disabledTools: Type.Optional(Type.Array(Type.String())),
  disabledSkills: Type.Optional(Type.Array(BotSkillRef)),
  sessionId: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  worker: Type.Optional(Type.Object({ id: Type.String(), name: Type.String() })),
  status: BotSessionStatus,
  soul: Type.Boolean(),
  lastMessage: Type.Optional(BotLastMessage),
  unread: Type.Boolean(),
  memory: Type.Optional(BotMemoryStatus),
  routines: Type.Number(),
}, { $id: "BotView" });
export type BotView = Static<typeof BotView>;

const BotInputFields = {
  handle: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  tagging: Type.Optional(BotTagging),
  cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  memoryModel: Type.Optional(Type.String()),
  memoryThinking: Type.Optional(Type.String()),
  hidden: Type.Optional(Type.Boolean()),
  disabledTools: Type.Optional(Type.Array(Type.String())),
  disabledSkills: Type.Optional(Type.Array(BotSkillSelector)),
};

export const BotInput = Type.Object({
  name: Type.Optional(Type.String()),
  ...BotInputFields,
  soul: Type.Optional(Type.String()),
  worker: Type.Optional(Type.String()),
  avatar: Type.Optional(BotAvatar),
  voice: Type.Optional(BotVoice),
}, { $id: "BotInput" });
export type BotInput = Static<typeof BotInput>;

export const BotAvatarPatch = Type.Object({
  emoji: Type.Optional(Type.String()),
  color: Type.Optional(Type.String()),
  shape: Type.Optional(Type.Union([BotFaceShape, Type.Literal("")])),
  ears: Type.Optional(Type.Union([BotFaceEars, Type.Literal("")])),
}, { $id: "BotAvatarPatch" });
export type BotAvatarPatch = Static<typeof BotAvatarPatch>;

export const BotVoicePatch = Type.Object({
  language: Type.Optional(Type.Union([VoiceLanguage, Type.Literal("")])), live: Type.Optional(Type.Union([GptLiveVoice, Type.Literal("")])),
}, { $id: "BotVoicePatch" });
export type BotVoicePatch = Static<typeof BotVoicePatch>;

export const BotPatch = Type.Object({
  name: Type.Optional(Type.String()),
  ...BotInputFields,
  avatar: Type.Optional(Type.Union([BotAvatarPatch, Type.Null()])),
  voice: Type.Optional(Type.Union([BotVoicePatch, Type.Null()])),
}, { $id: "BotPatch" });
export type BotPatch = Static<typeof BotPatch>;

export const BotSoul = Type.Object({ soul: Type.Union([Type.String(), Type.Null()]) }, { $id: "BotSoul" });
export type BotSoul = Static<typeof BotSoul>;

export const BotSoulRequest = Type.Object({ soul: Type.String() }, { $id: "BotSoulRequest" });
export type BotSoulRequest = Static<typeof BotSoulRequest>;

export const BotQuestion = Type.Object({
  id: Type.String(),
  method: Type.Enum(["select", "confirm", "input", "editor", "secret", "questionnaire"] as const),
  title: Type.String(),
  message: Type.Optional(Type.String()),
  options: Type.Optional(Type.Immutable(Type.Array(Type.String()))),
  placeholder: Type.Optional(Type.String()),
  prefill: Type.Optional(Type.String()),
}, { $id: "BotQuestion" });
export type BotQuestion = Static<typeof BotQuestion>;

export const BotDelivery = Type.Object({ status: Type.Enum(["sent", "queued"] as const) }, { $id: "BotDelivery" });
export type BotDelivery = Static<typeof BotDelivery>;

export const BotReply = Type.Object({
  status: Type.Enum(["answered", "failed", "needs-input", "timeout"] as const),
  reply: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  questions: Type.Optional(Type.Array(BotQuestion)),
}, { $id: "BotReply" });
export type BotReply = Static<typeof BotReply>;

export const BotMessageResult = Type.Union([BotDelivery, BotReply], { $id: "BotMessageResult" });
export type BotMessageResult = Static<typeof BotMessageResult>;

export const BotMessageRequest = Type.Object({
  text: Type.Optional(Type.String()),
  attachments: Type.Optional(Type.Array(Type.Unknown())),
  wait: Type.Optional(Type.Boolean()),
  timeoutSeconds: Type.Optional(Type.Number()),
}, { $id: "BotMessageRequest" });
export type BotMessageRequest = Static<typeof BotMessageRequest>;

export const BotsUpdate = Type.Object({
  revision: Type.Number(), ids: Type.Optional(Type.Array(Type.String())), upserts: Type.Array(BotView),
}, { $id: "BotsUpdate" });
export type BotsUpdate = Static<typeof BotsUpdate>;

export const BotsStreamFrame = Type.Object({ event: Type.Literal("bots"), data: BotsUpdate }, { $id: "BotsStreamFrame" });
export type BotsStreamFrame = Static<typeof BotsStreamFrame>;

export const BotToolGroup = Type.Enum(["files", "shell", "hui", "extension", "bots"] as const, { $id: "BotToolGroup" });
export type BotToolGroup = Static<typeof BotToolGroup>;

export const BotCatalogTool = Type.Object({
  name: Type.String(),
  label: Type.String(),
  description: Type.String(),
  group: BotToolGroup,
  source: Type.String(),
  powerful: Type.Boolean(),
  enabled: Type.Boolean(),
}, { $id: "BotCatalogTool" });
export type BotCatalogTool = Static<typeof BotCatalogTool>;

export const BotCatalogSkill = Type.Object({
  name: Type.String(), path: Type.String(), description: Type.String(), source: Type.String(), enabled: Type.Boolean(),
}, { $id: "BotCatalogSkill" });
export type BotCatalogSkill = Static<typeof BotCatalogSkill>;

export const BotAccessRequest = Type.Object({
  id: Type.String(), sessionId: Type.String(), title: Type.String(), message: Type.String(),
}, { $id: "BotAccessRequest" });
export type BotAccessRequest = Static<typeof BotAccessRequest>;

export const BotCatalog = Type.Object({
  tools: Type.Array(BotCatalogTool),
  skills: Type.Array(BotCatalogSkill),
  alwaysOn: Type.Array(Type.Object({ name: Type.String(), description: Type.String() })),
  disabledTools: Type.Array(Type.String()),
  disabledSkills: Type.Array(BotSkillRef),
  live: Type.Boolean(),
  request: Type.Optional(BotAccessRequest),
}, { $id: "BotCatalog" });
export type BotCatalog = Static<typeof BotCatalog>;

export const BotsResponse = Type.Object({ bots: Type.Array(BotView) }, { $id: "BotsResponse" });
export type BotsResponse = Static<typeof BotsResponse>;

export const BotResponse = Type.Object({ bot: BotView }, { $id: "BotResponse" });
export type BotResponse = Static<typeof BotResponse>;

export const BotDeleted = Type.Object({ ok: Type.Literal(true), queued: Type.Optional(Type.Literal(true)) }, { $id: "BotDeleted" });
export type BotDeleted = Static<typeof BotDeleted>;

export const BotDeleteResponse = Type.Union([BotResponse, BotDeleted], { $id: "BotDeleteResponse" });
export type BotDeleteResponse = Static<typeof BotDeleteResponse>;

export const BotMemoryResponse = Type.Object({ status: BotMemoryStatus, view: Type.String() }, { $id: "BotMemoryResponse" });
export type BotMemoryResponse = Static<typeof BotMemoryResponse>;

export const BotMemoryZoom = Type.Object({ text: Type.String() }, { $id: "BotMemoryZoom" });
export type BotMemoryZoom = Static<typeof BotMemoryZoom>;

export const BotFactKind = Type.Union([Type.Literal("fact"), Type.Literal("preference"), Type.Literal("decision")], { $id: "BotFactKind" });
export type BotFactKind = Static<typeof BotFactKind>;

export const BotFact = Type.Object({
  id: Type.String(),
  kind: BotFactKind,
  text: Type.String(),
  pinned: Type.Boolean(),
  source: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  revision: Type.Number(),
}, { $id: "BotFact" });
export type BotFact = Static<typeof BotFact>;

export const BotFactInput = Type.Object({
  kind: BotFactKind, text: Type.String(), source: Type.Optional(Type.String()), pinned: Type.Optional(Type.Boolean()),
}, { $id: "BotFactInput" });
export type BotFactInput = Static<typeof BotFactInput>;

export const BotFactPatch = Type.Object({
  kind: Type.Optional(BotFactKind), text: Type.Optional(Type.String()), pinned: Type.Optional(Type.Boolean()), revision: Type.Number(),
}, { $id: "BotFactPatch" });
export type BotFactPatch = Static<typeof BotFactPatch>;

export const BotFactsResponse = Type.Object({ facts: Type.Array(BotFact) }, { $id: "BotFactsResponse" });
export type BotFactsResponse = Static<typeof BotFactsResponse>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/bots/events", response: BotsStreamFrame, events: BotsStreamFrame },
  { method: "GET", path: "/__hui/bots", response: BotsResponse },
  { method: "POST", path: "/__hui/bots", request: BotInput, response: BotResponse },
  { method: "GET", path: "/__hui/bots/:id", response: BotResponse },
  { method: "PATCH", path: "/__hui/bots/:id", request: BotPatch, response: BotResponse },
  { method: "DELETE", path: "/__hui/bots/:id", response: BotDeleteResponse },
  { method: "POST", path: "/__hui/bots/:id/restore", response: BotResponse },
  { method: "POST", path: "/__hui/bots/:id/messages", request: BotMessageRequest, response: BotMessageResult },
  { method: "POST", path: "/__hui/bots/:id/stop", response: BotResponse },
  { method: "GET", path: "/__hui/bots/:id/memory", response: BotMemoryResponse },
  { method: "GET", path: "/__hui/bots/:id/memory/zoom", response: BotMemoryZoom },
  { method: "GET", path: "/__hui/bots/:id/catalog", response: BotCatalog },
  { method: "GET", path: "/__hui/bots/:id/soul", response: BotSoul },
  { method: "PUT", path: "/__hui/bots/:id/soul", request: BotSoulRequest, response: BotSoul },
  { method: "GET", path: "/__hui/bots/:id/facts", response: BotFactsResponse },
  { method: "POST", path: "/__hui/bots/:id/facts", request: BotFactInput, response: BotFactsResponse },
  { method: "PATCH", path: "/__hui/bots/:id/facts/:factId", request: BotFactPatch, response: BotFactsResponse },
  { method: "DELETE", path: "/__hui/bots/:id/facts/:factId", response: BotFactsResponse },
];
