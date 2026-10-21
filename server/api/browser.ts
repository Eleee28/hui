/** Public managed-browser status, live-view JSON messages and control payloads. */
import { Type, type Static } from "typebox";

export const BrowserTabView = Type.Object({
  id: Type.String(), ownerSessionId: Type.String(), ownerTitle: Type.String(), title: Type.String(), url: Type.String(),
}, { $id: "BrowserTabView" });
export type BrowserTabView = Static<typeof BrowserTabView>;

export const BrowserExecutableView = Type.Object({
  path: Type.String(), name: Type.String(), source: Type.Union([Type.Literal("configured"), Type.Literal("detected")]),
}, { $id: "BrowserExecutableView" });
export type BrowserExecutableView = Static<typeof BrowserExecutableView>;

export const BrowserState = Type.Union([
  Type.Literal("stopped"), Type.Literal("starting"), Type.Literal("running"), Type.Literal("stopping"),
], { $id: "BrowserState" });
export type BrowserState = Static<typeof BrowserState>;

export const BrowserStatus = Type.Object({
  enabled: Type.Boolean(), headless: Type.Boolean(), executablePath: Type.String(), executable: Type.Union([BrowserExecutableView, Type.Null()]),
  executableError: Type.String(), state: BrowserState, mode: Type.Optional(Type.Union([Type.Literal("headless"), Type.Literal("windowed")])),
  version: Type.Optional(Type.String()), startedAt: Type.Optional(Type.String()), profileDir: Type.String(), lastError: Type.String(), tabs: Type.Array(BrowserTabView),
}, { $id: "BrowserStatus" });
export type BrowserStatus = Static<typeof BrowserStatus>;

export const BrowserViewTab = Type.Object({ id: Type.String(), title: Type.String(), url: Type.String() }, { $id: "BrowserViewTab" });
export type BrowserViewTab = Static<typeof BrowserViewTab>;

export const BrowserViewState = Type.Object({
  running: Type.Boolean(), mode: Type.Optional(Type.Union([Type.Literal("headless"), Type.Literal("windowed")])), tabs: Type.Array(BrowserViewTab),
  current: Type.Union([Type.String(), Type.Null()]), watching: Type.Union([Type.String(), Type.Null()]), following: Type.Boolean(),
}, { $id: "BrowserViewState" });
export type BrowserViewState = Static<typeof BrowserViewState>;

export const BrowserViewAction = Type.Object({
  tabId: Type.String(), text: Type.String(), point: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() })), at: Type.String(),
}, { $id: "BrowserViewAction" });
export type BrowserViewAction = Static<typeof BrowserViewAction>;

export const BrowserViewMessage = Type.Union([
  Type.Object({ type: Type.Literal("state"), ...BrowserViewState.properties }),
  Type.Object({ type: Type.Literal("action"), ...BrowserViewAction.properties }),
], { $id: "BrowserViewMessage" });
export type BrowserViewMessage = Static<typeof BrowserViewMessage>;

export const BrowserViewControl = Type.Object({ action: Type.Literal("select"), tabId: Type.Union([Type.String(), Type.Null()]) }, { $id: "BrowserViewControl" });
export type BrowserViewControl = Static<typeof BrowserViewControl>;

export const BrowserControl = Type.Object({ action: Type.Union([Type.Literal("start"), Type.Literal("stop")]) }, { $id: "BrowserControl" });
export type BrowserControl = Static<typeof BrowserControl>;

export const BrowserViewConnection = Type.Object({ url: Type.String() }, { $id: "BrowserViewConnection" });
export type BrowserViewConnection = Static<typeof BrowserViewConnection>;

export const BrowserPreview = Type.Object({ image: Type.String() }, { $id: "BrowserPreview" });
export type BrowserPreview = Static<typeof BrowserPreview>;

export const BrowserError = Type.Object({ error: Type.String() }, { $id: "BrowserError" });
export type BrowserError = Static<typeof BrowserError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/browser", response: BrowserStatus },
  { method: "POST", path: "/__hui/browser", request: BrowserControl, response: BrowserStatus },
  { method: "GET", path: "/__hui/browser/tabs/:tab/preview", response: BrowserPreview },
  { method: "POST", path: "/__hui/sessions/:id/browser/connect", response: BrowserViewConnection },
  { method: "WS", path: "/__hui/browser-stream", request: BrowserViewControl, response: BrowserViewMessage, events: BrowserViewMessage },
];
