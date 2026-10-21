/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */
import type { GptLiveVoice } from "./bots.ts";

export type CallDelegationRequest = { "id": string; "request": string; };

export type CallDelegationResult = { "status": ("answered") | ("handed-off") | ("failed") | ("timeout") | ("limit"); "speak": string; "task"?: string; };

export type CallEnded = { "ended": boolean; };

export type CallHeartbeat = { "ok": true; };

export type CallLine = { "role": ("user") | ("assistant"); "text": string; };

export type CallLinesKept = { "kept": number; };

export type CallLinesRequest = { "lines": Array<{ "role": ("user") | ("assistant"); "text": string; "at"?: number; }>; };

export type CallRecord = { "call": string; "bot"?: string; "startedAt": number; "endedAt": number; "summary"?: string; "summaryUnavailable"?: true; "lines": Array<CallRecordLine>; };

export type CallRecordLine = { "role": ("user") | ("assistant") | ("helper") | ("handoff"); "text": string; "at": number; "request"?: string; };

export type CallStartRequest = { "sdp": string; };

export type CallStarted = { "callId": string; "answer": string; "model": string; "voice": GptLiveVoice; "account": { "name": string; }; "instructionsBytes": number; "memoryBytes": number; };

export type CallTaskResult = { "status": ("answered") | ("failed") | ("needs-input") | ("timeout"); "speak": string; };

export type CallsStatus = { "model": string; "voices": Array<GptLiveVoice>; "chatgpt": { "signedIn": boolean; "account"?: { "name": string; "email"?: string; }; "waitingUntil"?: number; }; "active": number; "limit": number; };
