import { expectTypeOf, test } from "vitest";
import type * as Api from "./api/terminals.ts";

type LegacyTerminalView = {
  id: string;
  ownerSessionId: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exitCode?: number;
  createdAt: string;
};
type LegacyTerminalSnapshot = { terminal: LegacyTerminalView; data: string; sequence: number; truncated: boolean };

type LegacyTerminalSnapshotFrame = { type: "snapshot"; terminal: LegacyTerminalView; sequence: number; truncated: boolean; replayBytes: number };
type LegacyTerminalControlFrame =
  | LegacyTerminalSnapshotFrame
  | { type: "state"; terminal: LegacyTerminalView }
  | { type: "error"; error: string };
type LegacyTerminalInput = { action: "input"; data: string } | { action: "resize"; cols: number; rows: number };


test("terminals schemas preserve the existing payload types", () => {
  expectTypeOf<LegacyTerminalView>().toMatchTypeOf<Api.TerminalView>();
  expectTypeOf<Api.TerminalView>().toMatchTypeOf<LegacyTerminalView>();
  expectTypeOf<LegacyTerminalSnapshot>().toMatchTypeOf<Api.TerminalSnapshot>();
  expectTypeOf<Api.TerminalSnapshot>().toMatchTypeOf<LegacyTerminalSnapshot>();
  expectTypeOf<LegacyTerminalSnapshotFrame>().toMatchTypeOf<Api.TerminalSnapshotFrame>();
  expectTypeOf<Api.TerminalSnapshotFrame>().toMatchTypeOf<LegacyTerminalSnapshotFrame>();
  expectTypeOf<LegacyTerminalControlFrame>().toMatchTypeOf<Api.TerminalControlFrame>();
  expectTypeOf<Api.TerminalControlFrame>().toMatchTypeOf<LegacyTerminalControlFrame>();
  expectTypeOf<LegacyTerminalInput>().toMatchTypeOf<Api.TerminalInput>();
  expectTypeOf<Api.TerminalInput>().toMatchTypeOf<LegacyTerminalInput>();
});
