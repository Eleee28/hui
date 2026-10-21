/** Public bot trigger payloads (HUI-18) and the routes that exchange them; the stored record with its token hash is not one. */
import { Type, type Static } from "typebox";

export const BotTriggerSource = Type.Literal("listener", { $id: "BotTriggerSource" });
export type BotTriggerSource = Static<typeof BotTriggerSource>;

export const TriggerMatch = Type.Object({
  field: Type.String(), op: Type.Union([Type.Literal("equals"), Type.Literal("contains")]), value: Type.String(),
}, { $id: "TriggerMatch" });
export type TriggerMatch = Static<typeof TriggerMatch>;

export const BotTriggerFilter = Type.Object({
  match: Type.Optional(TriggerMatch),
  prLinks: Type.Optional(Type.Literal(true)),
  bots: Type.Optional(Type.Literal(true)),
  external: Type.Optional(Type.Literal(true)),
}, { $id: "BotTriggerFilter" });
export type BotTriggerFilter = Static<typeof BotTriggerFilter>;

export const BotTriggerDelivery = Type.Union([Type.Literal("followUp"), Type.Literal("steer")]);

export const BotTrigger = Type.Object({
  id: Type.String(),
  botId: Type.String(),
  name: Type.String(),
  source: BotTriggerSource,
  filter: BotTriggerFilter,
  prompt: Type.Optional(Type.String()),
  delivery: Type.Optional(BotTriggerDelivery),
  enabled: Type.Boolean(),
  cooldownSeconds: Type.Number(),
  createdBy: Type.Union([Type.Literal("operator"), Type.Literal("bot")]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  lastFiredAt: Type.Optional(Type.String()),
  tokenHint: Type.Optional(Type.String()),
  pending: Type.Optional(Type.Object({ events: Type.Number(), until: Type.String() })),
  watch: Type.Optional(Type.Object({ polledAt: Type.Optional(Type.String()), error: Type.Optional(Type.String()) })),
}, { $id: "BotTrigger" });
export type BotTrigger = Static<typeof BotTrigger>;

export const BotTriggerRunStatus = Type.Union([
  Type.Literal("fired"), Type.Literal("coalesced"), Type.Literal("skipped"), Type.Literal("failed"),
], { $id: "BotTriggerRunStatus" });
export type BotTriggerRunStatus = Static<typeof BotTriggerRunStatus>;

export const BotTriggerRun = Type.Object({
  id: Type.String(),
  triggerId: Type.String(),
  triggerName: Type.String(),
  at: Type.String(),
  status: BotTriggerRunStatus,
  events: Type.Number(),
  summary: Type.String(),
  reason: Type.Optional(Type.String()),
  test: Type.Optional(Type.Literal(true)),
  catchUp: Type.Optional(Type.Literal(true)),
}, { $id: "BotTriggerRun" });
export type BotTriggerRun = Static<typeof BotTriggerRun>;

export const BotTriggersList = Type.Object({
  triggers: Type.Array(BotTrigger),
  runs: Type.Array(BotTriggerRun),
  deliveries: Type.Object({ lastHour: Type.Number(), perHour: Type.Number() }),
}, { $id: "BotTriggersList" });
export type BotTriggersList = Static<typeof BotTriggersList>;

export const BotTriggerCreated = Type.Object({
  trigger: BotTrigger, hook: Type.Object({ token: Type.String(), path: Type.String() }),
}, { $id: "BotTriggerCreated" });
export type BotTriggerCreated = Static<typeof BotTriggerCreated>;

export const BotTriggerInput = Type.Object({
  name: Type.String(),
  source: BotTriggerSource,
  filter: BotTriggerFilter,
  prompt: Type.Optional(Type.String()),
  delivery: Type.Optional(BotTriggerDelivery),
  enabled: Type.Optional(Type.Boolean()),
  cooldownSeconds: Type.Optional(Type.Number()),
}, { $id: "BotTriggerInput" });
export type BotTriggerInput = Static<typeof BotTriggerInput>;

export const BotTriggerPatch = Type.Object({
  name: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  delivery: Type.Optional(BotTriggerDelivery),
  enabled: Type.Optional(Type.Boolean()),
  cooldownSeconds: Type.Optional(Type.Number()),
  filter: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { $id: "BotTriggerPatch" });
export type BotTriggerPatch = Static<typeof BotTriggerPatch>;

export const BotTriggerResponse = Type.Object({ trigger: BotTrigger }, { $id: "BotTriggerResponse" });
export type BotTriggerResponse = Static<typeof BotTriggerResponse>;

export const BotTriggerRunResponse = Type.Object({ run: BotTriggerRun }, { $id: "BotTriggerRunResponse" });
export type BotTriggerRunResponse = Static<typeof BotTriggerRunResponse>;

export const BotTriggerDeleted = Type.Object({ ok: Type.Literal(true) }, { $id: "BotTriggerDeleted" });
export type BotTriggerDeleted = Static<typeof BotTriggerDeleted>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/bots/:id/triggers", response: BotTriggersList },
  { method: "POST", path: "/__hui/bots/:id/triggers", request: BotTriggerInput, response: BotTriggerCreated },
  { method: "PATCH", path: "/__hui/bots/:id/triggers/:trigger", request: BotTriggerPatch, response: BotTriggerResponse },
  { method: "DELETE", path: "/__hui/bots/:id/triggers/:trigger", response: BotTriggerDeleted },
  { method: "POST", path: "/__hui/bots/:id/triggers/:trigger/test", response: BotTriggerRunResponse },
  { method: "POST", path: "/__hui/bots/:id/triggers/:trigger/token", response: BotTriggerCreated },
];
