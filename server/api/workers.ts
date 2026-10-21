/** Public remote-worker views and management requests, separate from the host protocol. */
import { Type, type Static } from "typebox";

export const WorkerState = Type.Union([
  Type.Literal("disconnected"), Type.Literal("connecting"), Type.Literal("connected"), Type.Literal("error"),
], { $id: "WorkerState" });
export type WorkerState = Static<typeof WorkerState>;

export const WorkerView = Type.Object({
  id: Type.String(), name: Type.String(), command: Type.String(), extraPaths: Type.Array(Type.String()), state: WorkerState,
  phase: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
  host: Type.Optional(Type.Object({ hostname: Type.String(), platform: Type.String(), arch: Type.String(), node: Type.String(), home: Type.String(), release: Type.String() })),
  sync: Type.Optional(Type.Object({ at: Type.String(), files: Type.Number(), uploaded: Type.Number(), deleted: Type.Number(), installed: Type.Array(Type.String()), skipped: Type.Array(Type.String()), errors: Type.Array(Type.String()) })),
}, { $id: "WorkerView" });
export type WorkerView = Static<typeof WorkerView>;

export const WorkerInput = Type.Object({ name: Type.String(), command: Type.String(), extraPaths: Type.Optional(Type.Array(Type.String())) }, { $id: "WorkerInput" });
export type WorkerInput = Static<typeof WorkerInput>;
export const WorkerPatch = Type.Partial(WorkerInput, { $id: "WorkerPatch" });
export const WorkersResponse = Type.Object({ workers: Type.Array(WorkerView) }, { $id: "WorkersResponse" });
export const WorkerResponse = Type.Object({ worker: WorkerView }, { $id: "WorkerResponse" });
export const WorkerActionResponse = Type.Object({ ok: Type.Literal(true) }, { $id: "WorkerActionResponse" });
export const WorkerError = Type.Object({ error: Type.String() }, { $id: "WorkerError" });

export const routeSchemas = [
  { method: "GET", path: "/__hui/workers", response: WorkersResponse },
  { method: "POST", path: "/__hui/workers", request: WorkerInput, response: WorkerResponse },
  { method: "PATCH", path: "/__hui/workers/:id", request: WorkerPatch, response: WorkerResponse },
  { method: "DELETE", path: "/__hui/workers/:id", response: WorkerActionResponse },
  { method: "POST", path: "/__hui/workers/:id/connect", response: WorkerActionResponse },
  { method: "POST", path: "/__hui/workers/:id/sync", response: WorkerActionResponse },
  { method: "POST", path: "/__hui/workers/:id/disconnect", response: WorkerActionResponse },
];
