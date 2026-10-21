/**
 * Drag-and-drop payloads and split-ratio arithmetic for session panes: the custom data types for dragged
 * sessions and panes, and the clamped ratio a pointer or arrow key produces.
 */
export const HUI_SESSION_DRAG_TYPE = "application/x-hui-session-id";
export const HUI_PANE_DRAG_TYPE = "application/x-hui-pane-id";
export const MIN_SESSION_PANE_RATIO = 0.15;
export const MAX_SESSION_PANE_RATIO = 0.85;

type SessionDragWriter = Pick<DataTransfer, "setData"> & {
  effectAllowed: DataTransfer["effectAllowed"];
};

type SessionDragReader = Pick<DataTransfer, "getData">;

export function writeSessionDrag(
  transfer: SessionDragWriter,
  session: { id: string; title: string },
) {
  transfer.effectAllowed = "copyMove";
  transfer.setData(HUI_SESSION_DRAG_TYPE, session.id);
  transfer.setData("text/plain", session.title);
}

export function readSessionDragId(transfer: SessionDragReader | null): string {
  return transfer?.getData(HUI_SESSION_DRAG_TYPE).trim() ?? "";
}

export function clampSessionPaneRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_SESSION_PANE_RATIO, Math.max(MIN_SESSION_PANE_RATIO, ratio));
}

export function sessionPaneRatioAt(clientX: number, left: number, width: number): number {
  if (width <= 0) return 0.5;
  return clampSessionPaneRatio((clientX - left) / width);
}

export function sessionPaneRatioForKey(
  ratio: number,
  key: string,
  step = 0.05,
): number | undefined {
  if (key === "Home") return MIN_SESSION_PANE_RATIO;
  if (key === "End") return MAX_SESSION_PANE_RATIO;
  if (key === "ArrowLeft") return clampSessionPaneRatio(ratio - step);
  if (key === "ArrowRight") return clampSessionPaneRatio(ratio + step);
  return undefined;
}
