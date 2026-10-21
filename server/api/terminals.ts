/** Public terminal views, HTTP operations and WebSocket JSON control messages; output bytes stay outside JSON. */
import { Type, type Static } from "typebox";

export const TerminalView = Type.Object({
  id: Type.String(), ownerSessionId: Type.String(), title: Type.String(), cwd: Type.String(), cols: Type.Number(), rows: Type.Number(),
  status: Type.Union([Type.Literal("running"), Type.Literal("exited")]), exitCode: Type.Optional(Type.Number()), createdAt: Type.String(),
}, { $id: "TerminalView" });
export type TerminalView = Static<typeof TerminalView>;

export const TerminalSnapshot = Type.Object({ terminal: TerminalView, data: Type.String(), sequence: Type.Number(), truncated: Type.Boolean() }, { $id: "TerminalSnapshot" });
export type TerminalSnapshot = Static<typeof TerminalSnapshot>;

export const TerminalSnapshotFrame = Type.Object({
  type: Type.Literal("snapshot"), terminal: TerminalView, sequence: Type.Number(), truncated: Type.Boolean(), replayBytes: Type.Number(),
}, { $id: "TerminalSnapshotFrame" });
export type TerminalSnapshotFrame = Static<typeof TerminalSnapshotFrame>;

export const TerminalControlFrame = Type.Union([
  TerminalSnapshotFrame,
  Type.Object({ type: Type.Literal("state"), terminal: TerminalView }),
  Type.Object({ type: Type.Literal("error"), error: Type.String() }),
], { $id: "TerminalControlFrame" });
export type TerminalControlFrame = Static<typeof TerminalControlFrame>;

export const TerminalInput = Type.Union([
  Type.Object({ action: Type.Literal("input"), data: Type.String() }),
  Type.Object({ action: Type.Literal("resize"), cols: Type.Number(), rows: Type.Number() }),
], { $id: "TerminalInput" });
export type TerminalInput = Static<typeof TerminalInput>;

export const TerminalCreateRequest = Type.Object({ cols: Type.Optional(Type.Number()), rows: Type.Optional(Type.Number()), title: Type.Optional(Type.String()) }, { $id: "TerminalCreateRequest" });
export const TerminalOperationRequest = Type.Union([
  TerminalInput, Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("close")]) }),
], { $id: "TerminalOperationRequest" });
export const TerminalsResponse = Type.Object({ terminals: Type.Array(TerminalView) }, { $id: "TerminalsResponse" });
export const TerminalResponse = Type.Object({ terminal: TerminalView }, { $id: "TerminalResponse" });
export const TerminalOperationResponse = Type.Union([
  TerminalsResponse,
  Type.Object({ terminal: TerminalView, data: Type.String(), sequence: Type.Number(), truncated: Type.Boolean(), format: Type.String() }),
  Type.Object({ accepted: Type.Literal(true), terminal: TerminalView }),
  TerminalResponse,
  Type.Object({ closed: Type.Literal(true) }),
], { $id: "TerminalOperationResponse" });
export type TerminalOperationResponse = Static<typeof TerminalOperationResponse>;
export const TerminalConnectResponse = Type.Object({ url: Type.String() }, { $id: "TerminalConnectResponse" });
export const TerminalError = Type.Object({ error: Type.String() }, { $id: "TerminalError" });

export const routeSchemas = [
  { method: "GET", path: "/__hui/sessions/:owner/terminals", response: TerminalsResponse },
  { method: "POST", path: "/__hui/sessions/:owner/terminals", request: TerminalCreateRequest, response: TerminalResponse },
  { method: "GET", path: "/__hui/sessions/:owner/terminals/:id", response: TerminalSnapshot },
  { method: "POST", path: "/__hui/sessions/:owner/terminals/:id", request: TerminalOperationRequest, response: TerminalOperationResponse },
  { method: "POST", path: "/__hui/sessions/:owner/terminals/:id/connect", response: TerminalConnectResponse, events: TerminalControlFrame },
];
