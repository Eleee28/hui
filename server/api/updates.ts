/** Public release checks, updater receipts and gateway update requests. */
import { Type, type Static } from "typebox";

export const ReleaseInfo = Type.Object({ version: Type.String(), tag: Type.String(), url: Type.String() }, { $id: "ReleaseInfo" });
export type ReleaseInfo = Static<typeof ReleaseInfo>;

export const UpdateCheck = Type.Object({
  currentVersion: Type.Union([Type.String(), Type.Null()]), latest: Type.Union([ReleaseInfo, Type.Null()]),
  status: Type.Union([Type.Literal("available"), Type.Literal("current"), Type.Literal("unpublished"), Type.Literal("unavailable")]),
  canInstall: Type.Boolean(), message: Type.String(),
}, { $id: "UpdateCheck" });
export type UpdateCheck = Static<typeof UpdateCheck>;

export const UpdateJob = Type.Object({
  id: Type.String(), pid: Type.Number(), status: Type.Union([Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed")]), version: Type.String(), message: Type.String(),
}, { $id: "UpdateJob" });
export type UpdateJob = Static<typeof UpdateJob>;

export const UpdateSnapshot = Type.Object({
  currentVersion: Type.Union([Type.String(), Type.Null()]), check: Type.Union([UpdateCheck, Type.Null()]), job: Type.Union([UpdateJob, Type.Null()]),
}, { $id: "UpdateSnapshot" });
export type UpdateSnapshot = Static<typeof UpdateSnapshot>;

export const UpdateRequest = Type.Object({ version: Type.String() }, { $id: "UpdateRequest" });
export const UpdateError = Type.Object({ error: Type.String() }, { $id: "UpdateError" });

export const routeSchemas = [
  { method: "GET", path: "/__hui/update", response: UpdateSnapshot },
  { method: "POST", path: "/__hui/update", request: UpdateRequest, response: UpdateSnapshot },
  { method: "GET", path: "/__hui/update/check", response: UpdateSnapshot },
  { method: "POST", path: "/__hui/update/check", response: UpdateSnapshot },
];
