/** Public macOS sleep-prevention payloads and the routes that exchange them. */
import { Type, type Static } from "typebox";

export const PowerState = Type.Object({
  state: Type.Union([Type.Literal("off"), Type.Literal("pending"), Type.Literal("active"), Type.Literal("error")]),
  detail: Type.String(),
}, { $id: "PowerState" });
export type PowerState = Static<typeof PowerState>;

export const PowerStatus = Type.Object({
  keepAwake: PowerState,
  lidAwake: PowerState,
  lidOn: Type.Boolean(),
}, { $id: "PowerStatus" });
export type PowerStatus = Static<typeof PowerStatus>;

export const PowerResponse = Type.Object({
  power: Type.Union([PowerStatus, Type.Null()]),
}, { $id: "PowerResponse" });
export type PowerResponse = Static<typeof PowerResponse>;

export const PowerRequest = Type.Object({ lidAwake: Type.Boolean() }, { $id: "PowerRequest" });
export type PowerRequest = Static<typeof PowerRequest>;

export const PowerError = Type.Object({ error: Type.String() }, { $id: "PowerError" });
export type PowerError = Static<typeof PowerError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/power", response: PowerResponse },
  { method: "PUT", path: "/__hui/power", request: PowerRequest, response: PowerResponse },
];
