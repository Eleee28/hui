/** Public session watcher state, bounded log tails and control responses. */
import { Type, type Static } from "typebox";

export const WatcherState = Type.Union([
  Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("stopped"), Type.Literal("dead"),
], { $id: "WatcherState" });
export type WatcherState = Static<typeof WatcherState>;

export const Watcher = Type.Object({
  id: Type.String(), purpose: Type.String(), target: Type.String(), outcome: Type.String(), command: Type.String(),
  logPath: Type.String(), state: WatcherState, pid: Type.Union([Type.Number(), Type.Null()]), exitCode: Type.Optional(Type.Number()),
  startedAt: Type.String(), endedAt: Type.Optional(Type.String()), lastLine: Type.String(), keepRunning: Type.Optional(Type.Literal(true)),
}, { $id: "Watcher" });
export type Watcher = Static<typeof Watcher>;

export const WatcherLog = Type.Object({
  id: Type.String(), lines: Type.Array(Type.String()), truncated: Type.Boolean(),
}, { $id: "WatcherLog" });
export type WatcherLog = Static<typeof WatcherLog>;

export const WatchersResponse = Type.Object({ watchers: Type.Array(Watcher) }, { $id: "WatchersResponse" });
export type WatchersResponse = Static<typeof WatchersResponse>;

export const WatcherError = Type.Object({ error: Type.String() }, { $id: "WatcherError" });
export type WatcherError = Static<typeof WatcherError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/sessions/:id/watchers/:wid/log", response: WatcherLog },
  { method: "POST", path: "/__hui/sessions/:id/watchers/:wid/stop", response: WatchersResponse },
  { method: "POST", path: "/__hui/sessions/:id/watchers/:wid/restart", response: WatchersResponse },
  { method: "DELETE", path: "/__hui/sessions/:id/watchers/:wid", response: WatchersResponse },
];
