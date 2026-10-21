import assert from "node:assert/strict";
import { test } from "vitest";

import {
  compactionBlocks,
  emptySessionPresentation,
  isSelectedSession,
  isCurrentSessionRequest,
  mergeSessionStatuses,
  modelRequestMarkerAfterFailure,
  noteAfterEvent,
  noteAnnouncement,
  shouldRequestModels,
  shouldFlushLaunchPrompt,
  streamingAfterEvent,
  streamingForStatus,
} from "./ui-state.ts";

test("a settled or failed run closes its own recovery warning, not a newer note", () => {
  const retry = "Primary model failed before producing output. Retrying with openai/fallback.";
  const narrating = noteAfterEvent({ note: "", noteLevel: "info", recoveryNotice: "" }, { type: "notice", level: "warning", message: retry, recovery: true });
  assert.deepEqual(noteAfterEvent(narrating, { type: "settled" }), { note: "", noteLevel: "info", recoveryNotice: "" });
  assert.deepEqual(noteAfterEvent(narrating, { type: "error", message: "failed" }), { note: "", noteLevel: "info", recoveryNotice: "" });
  const replaced = { note: "Could not stop that turn.", noteLevel: "error" as const, recoveryNotice: retry };
  assert.deepEqual(noteAfterEvent(replaced, { type: "settled" }), { ...replaced, recoveryNotice: "" });
});

test("a warning that is not a recovery stays after the run settles", () => {
  const refused = noteAfterEvent({ note: "", noteLevel: "info", recoveryNotice: "" }, { type: "notice", level: "warning", message: "Skill “review” is disabled for HUI sessions." });
  assert.deepEqual(noteAfterEvent(refused, { type: "settled" }), refused);
  const confirmation = { note: "Session context cleared.", noteLevel: "info" as const, recoveryNotice: "" };
  assert.deepEqual(noteAfterEvent(confirmation, { type: "settled" }), confirmation);
});

test("only error notes are announced as alerts", () => {
  assert.equal(noteAnnouncement("error"), "alert");
  assert.equal(noteAnnouncement("warning"), "status");
  assert.equal(noteAnnouncement("info"), "status");
});

test("a multiplex snapshot refreshes every session and resets cold rows to idle", () => {
  const groups = [{
    label: "Work",
    sessions: [
      { id: "a", title: "A", group: "Work", cwd: "/tmp", tool: "pi", status: "running" as const, displayCwd: "", stage: "investigation" as const, stageOrigin: "default" as const, createdAt: "now", updatedAt: "now" },
      { id: "b", title: "B", group: "Work", cwd: "/tmp", tool: "pi", status: "error" as const, displayCwd: "", stage: "investigation" as const, stageOrigin: "default" as const, createdAt: "now", updatedAt: "now" },
    ],
  }];

  const merged = mergeSessionStatuses(groups, new Map([["a", "waiting"] as const]));

  assert.deepEqual(merged[0]?.sessions.map(({ id, status }) => ({ id, status })), [
    { id: "a", status: "waiting" },
    { id: "b", status: "idle" },
  ]);
  assert.equal(groups[0]?.sessions[0]?.status, "running", "the registry projection stays immutable");
});

test("model discovery waits for a starting runtime and runs once when idle", () => {
  assert.equal(shouldRequestModels("session-a", "starting", ""), false);
  assert.equal(shouldRequestModels("session-a", "idle", ""), true);
  assert.equal(shouldRequestModels("session-a", "waiting", ""), true);
  assert.equal(shouldRequestModels("session-a", "idle", "session-a"), false);
  assert.equal(shouldRequestModels("session-a", "running", "session-a"), false);
});

test("model discovery is independent for the next selected session", () => {
  assert.equal(shouldRequestModels("session-b", "idle", "session-a"), true);
  assert.equal(shouldRequestModels("session-b", "error", "session-a"), false);
});

test("turn_end stays locked until the authoritative idle status settles the turn", () => {
  const duringTurn = streamingAfterEvent(false, "turn_start");
  assert.equal(duringTurn, true);
  assert.equal(streamingAfterEvent(duringTurn, "turn_end"), true);
  assert.equal(streamingAfterEvent(duringTurn, "settled"), true);
  assert.equal(streamingForStatus("running"), true);
  assert.equal(streamingForStatus("waiting"), true);
  assert.equal(streamingForStatus("idle"), false);
});

test("a New Session prompt waits for an idle runtime and a live stream", () => {
  assert.equal(shouldFlushLaunchPrompt("hello", "starting", "live", false), false);
  assert.equal(shouldFlushLaunchPrompt("hello", "idle", "reconnecting", false), false);
  assert.equal(shouldFlushLaunchPrompt("hello", "idle", "live", true), false);
  assert.equal(shouldFlushLaunchPrompt("", "idle", "live", false), false);
  assert.equal(shouldFlushLaunchPrompt("hello", "idle", "live", false), true);
});

test("late session mutations ignore a switch or deletion during the request", () => {
  for (const operation of ["prompt", "attachment", "abort", "rename", "delete"]) {
    assert.equal(isSelectedSession("session-a", "session-a"), true, operation);
    assert.equal(isSelectedSession("session-a", "session-b"), false, `${operation}: switched`);
    assert.equal(isSelectedSession("session-a", undefined), false, `${operation}: deleted`);
  }
});

test("only the newest open attempt can install state when responses finish out of order", () => {
  const first = 7;
  const retry = 8;
  assert.equal(isCurrentSessionRequest("session-a", "session-a", retry, retry), true);
  assert.equal(isCurrentSessionRequest("session-a", "session-a", first, retry), false);
  assert.equal(isCurrentSessionRequest("session-a", "session-b", retry, retry), false);
});

test("a failed model request releases only the active session gate", () => {
  assert.equal(modelRequestMarkerAfterFailure("session-a", "session-a", "session-a"), "");
  assert.equal(
    modelRequestMarkerAfterFailure("session-b", "session-a", "session-b"),
    "session-b",
  );
  assert.equal(
    modelRequestMarkerAfterFailure("session-a", "session-a", undefined),
    "session-a",
  );
});

test("clearing a session removes transcript, errors, models, and attachments", () => {
  const state = emptySessionPresentation();
  assert.deepEqual(state, {
    transcript: [],
    opening: false,
    streaming: false,
    note: "",
    noteLevel: "info",
    connectionNote: "",
    models: [],
    currentModel: undefined,
    usage: undefined,
    attachments: [],
  });
  assert.notEqual(state.transcript, emptySessionPresentation().transcript);
  assert.notEqual(state.models, emptySessionPresentation().models);
  assert.notEqual(state.attachments, emptySessionPresentation().attachments);
});

test("only a compaction its run waits for replaces the working indicator", () => {
  assert.equal(compactionBlocks({ status: "running", reason: "threshold" }), true, "PI's compaction blocks");
  assert.equal(compactionBlocks({ status: "running", reason: "manual", blocking: false }), false, "Durable compacts beside the run");
  assert.equal(compactionBlocks({ status: "running", reason: "threshold", blocking: false, background: true }), false);
  assert.equal(compactionBlocks({ status: "failed", reason: "manual", message: "Nothing to compact" }), false);
  assert.equal(compactionBlocks(undefined), false);
});
