/**
 * Which file references in the chat are real: the client side of `POST /__hui/sessions/:id/files/resolve`. Every
 * `<hui-file-ref>` a render connects asks here; asks made in the same task share one batched request per
 * conversation, and answers are cached per conversation, so re-rendering a message (a streamed token, the 3 s poll)
 * reads them synchronously and a link never flickers. Missing answers are forgotten when that conversation's agent
 * turn ends, since the agent may have created the file. A conversation whose files the gateway cannot show (remote
 * worker, missing directory) answers `null` for every path. The gateway owns the disk and the path rules; this owns
 * only batching and caching.
 *
 * It also names the event a file reference dispatches when clicked, which the app shell turns into a Files view.
 */
import { MAX_RESOLVE_PATHS } from "../../api/files.ts";
import type { FileLocation, FilesResolve } from "../../api/schema/files.ts";

/** Dispatched (bubbling, composed) by a clicked file reference; `hui-app.ts` opens it in the Work pane. */
export const OPEN_FILE_EVENT = "hui-open-file";

export type OpenFileDetail = {
  sessionId: string;
  /** Relative to the conversation's working directory, as the gateway resolved it. */
  path: string;
  kind: FileLocation["kind"];
  line?: number;
  column?: number;
};

/** Sends one batch. `"unavailable"` means the conversation's files cannot be shown at all. */
export type ResolveTransport = (sessionId: string, paths: string[]) => Promise<FilesResolve | "unavailable">;

/** Answers kept per conversation before its cache starts over. */
const CACHE_LIMIT = 2_000;

export type FileLinkResolver = {
  /** The cached answer, or `undefined` when it is not known yet. */
  lookup(sessionId: string, path: string): FileLocation | null | undefined;
  /** The answer, asking the gateway (batched with the other asks of this task) when it is not cached. */
  resolve(sessionId: string, path: string): Promise<FileLocation | null>;
  /** Forgets the conversation's missing answers, so they are asked again. */
  forgetMissing(sessionId: string): void;
};

export function createFileLinkResolver(transport: ResolveTransport, schedule: (flush: () => void) => void = queueMicrotask): FileLinkResolver {
  const answers = new Map<string, Map<string, FileLocation | null>>();
  const unavailable = new Set<string>();
  const queued = new Map<string, Map<string, ((answer: FileLocation | null) => void)[]>>();
  const inFlight = new Map<string, Map<string, Promise<FileLocation | null>>>();

  function remember(sessionId: string, path: string, answer: FileLocation | null) {
    let session = answers.get(sessionId);
    if (!session) answers.set(sessionId, session = new Map());
    if (session.size >= CACHE_LIMIT) session.clear();
    session.set(path, answer);
  }

  async function send(sessionId: string, batch: Map<string, ((answer: FileLocation | null) => void)[]>) {
    const paths = [...batch.keys()];
    for (let start = 0; start < paths.length; start += MAX_RESOLVE_PATHS) {
      const chunk = paths.slice(start, start + MAX_RESOLVE_PATHS);
      let result: FilesResolve | "unavailable" | undefined;
      try {
        result = await transport(sessionId, chunk);
      } catch {
        // A failed request is not an answer: these stay plain now and are asked again by the next render.
        result = undefined;
      }
      if (result === "unavailable") unavailable.add(sessionId);
      chunk.forEach((path, index) => {
        const answer = result === undefined || result === "unavailable" ? null : result.entries[index] ?? null;
        if (result !== undefined && result !== "unavailable") remember(sessionId, path, answer);
        inFlight.get(sessionId)?.delete(path);
        for (const settle of batch.get(path) ?? []) settle(answer);
      });
    }
  }

  function flush() {
    const batches = [...queued];
    queued.clear();
    for (const [sessionId, batch] of batches) void send(sessionId, batch);
  }

  function lookup(sessionId: string, path: string): FileLocation | null | undefined {
    if (unavailable.has(sessionId)) return null;
    return answers.get(sessionId)?.get(path);
  }

  return {
    lookup,
    resolve(sessionId, path) {
      const known = lookup(sessionId, path);
      if (known !== undefined) return Promise.resolve(known);
      const running = inFlight.get(sessionId)?.get(path);
      if (running) return running;
      const promise = new Promise<FileLocation | null>((settle) => {
        if (!queued.size) schedule(flush);
        let batch = queued.get(sessionId);
        if (!batch) queued.set(sessionId, batch = new Map());
        const waiting = batch.get(path) ?? [];
        waiting.push(settle);
        batch.set(path, waiting);
      });
      let session = inFlight.get(sessionId);
      if (!session) inFlight.set(sessionId, session = new Map());
      session.set(path, promise);
      return promise;
    },
    forgetMissing(sessionId) {
      const session = answers.get(sessionId);
      if (!session) return;
      for (const [path, answer] of session) if (answer === null) session.delete(path);
    },
  };
}
