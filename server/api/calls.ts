/** Public GPT-Live call payloads: the calls status, a call's start, lines, delegations, tasks and its record. */
import { Type, type Static } from "typebox";
import { GptLiveVoice } from "./bots.ts";

export const CallsStatus = Type.Object({
  model: Type.String(),
  voices: Type.Immutable(Type.Array(GptLiveVoice)),
  chatgpt: Type.Object({
    signedIn: Type.Boolean(),
    account: Type.Optional(Type.Object({ name: Type.String(), email: Type.Optional(Type.String()) })),
    waitingUntil: Type.Optional(Type.Number()),
  }),
  active: Type.Number(),
  limit: Type.Number(),
}, { $id: "CallsStatus" });
export type CallsStatus = Static<typeof CallsStatus>;

export const CallStartRequest = Type.Object({ sdp: Type.String() }, { $id: "CallStartRequest" });
export type CallStartRequest = Static<typeof CallStartRequest>;

export const CallStarted = Type.Object({
  callId: Type.String(),
  answer: Type.String(),
  model: Type.String(),
  voice: GptLiveVoice,
  account: Type.Object({ name: Type.String() }),
  instructionsBytes: Type.Number(),
  memoryBytes: Type.Number(),
}, { $id: "CallStarted" });
export type CallStarted = Static<typeof CallStarted>;

export const CallLine = Type.Object({ role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), text: Type.String() }, { $id: "CallLine" });
export type CallLine = Static<typeof CallLine>;

export const CallRecordLine = Type.Object({
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("helper"), Type.Literal("handoff")]),
  text: Type.String(),
  at: Type.Number(),
  request: Type.Optional(Type.String()),
}, { $id: "CallRecordLine" });
export type CallRecordLine = Static<typeof CallRecordLine>;

export const CallRecord = Type.Object({
  call: Type.String(),
  bot: Type.Optional(Type.String()),
  startedAt: Type.Number(),
  endedAt: Type.Number(),
  summary: Type.Optional(Type.String()),
  summaryUnavailable: Type.Optional(Type.Literal(true)),
  lines: Type.Array(CallRecordLine),
}, { $id: "CallRecord" });
export type CallRecord = Static<typeof CallRecord>;

export const CallLinesRequest = Type.Object({
  lines: Type.Array(Type.Object({ role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), text: Type.String(), at: Type.Optional(Type.Number()) })),
}, { $id: "CallLinesRequest" });
export type CallLinesRequest = Static<typeof CallLinesRequest>;

export const CallLinesKept = Type.Object({ kept: Type.Number() }, { $id: "CallLinesKept" });
export type CallLinesKept = Static<typeof CallLinesKept>;

export const CallDelegationRequest = Type.Object({ id: Type.String(), request: Type.String() }, { $id: "CallDelegationRequest" });
export type CallDelegationRequest = Static<typeof CallDelegationRequest>;

export const CallDelegationResult = Type.Object({
  status: Type.Union([Type.Literal("answered"), Type.Literal("handed-off"), Type.Literal("failed"), Type.Literal("timeout"), Type.Literal("limit")]),
  speak: Type.String(),
  task: Type.Optional(Type.String()),
}, { $id: "CallDelegationResult" });
export type CallDelegationResult = Static<typeof CallDelegationResult>;

export const CallTaskResult = Type.Object({
  status: Type.Union([Type.Literal("answered"), Type.Literal("failed"), Type.Literal("needs-input"), Type.Literal("timeout")]),
  speak: Type.String(),
}, { $id: "CallTaskResult" });
export type CallTaskResult = Static<typeof CallTaskResult>;

export const CallHeartbeat = Type.Object({ ok: Type.Literal(true) }, { $id: "CallHeartbeat" });
export type CallHeartbeat = Static<typeof CallHeartbeat>;

export const CallEnded = Type.Object({ ended: Type.Boolean() }, { $id: "CallEnded" });
export type CallEnded = Static<typeof CallEnded>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/calls", response: CallsStatus },
  { method: "POST", path: "/__hui/bots/:id/calls", request: CallStartRequest, response: CallStarted },
  { method: "POST", path: "/__hui/bots/:id/calls/:callId/lines", request: CallLinesRequest, response: CallLinesKept },
  { method: "POST", path: "/__hui/bots/:id/calls/:callId/delegations", request: CallDelegationRequest, response: CallDelegationResult },
  { method: "POST", path: "/__hui/bots/:id/calls/:callId/tasks/:task", response: CallTaskResult },
  { method: "POST", path: "/__hui/bots/:id/calls/:callId/heartbeat", response: CallHeartbeat },
  { method: "DELETE", path: "/__hui/bots/:id/calls/:callId", response: CallEnded },
];
