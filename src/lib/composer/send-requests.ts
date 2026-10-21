/**
 * The request id each composer send carries. A send that failed keeps its id with its payload: sending the same text
 * and attachments to the same session again reuses it, so the gateway can recognise a send it had already taken (the
 * browser stopped waiting first) and answer with that one's outcome instead of running it twice. Anything else, or any
 * send after one that went through, gets a new id. Browser memory only.
 */
import type { Attachment } from "../../api/sessions.ts";

type Payload = { text: string; attachments: readonly Attachment[] };
type Failed = Payload & { requestId: string; row?: string };

/** The same text and the same attachments, in order, with the same contents. */
function samePayload(left: Payload, right: Payload): boolean {
  return left.text === right.text
    && left.attachments.length === right.attachments.length
    && left.attachments.every((item, index) => {
      const other = right.attachments[index]!;
      return item.kind === other.kind && item.name === other.name && item.mimeType === other.mimeType && item.dataBase64 === other.dataBase64;
    });
}

export class SendRequests {
  readonly #failed = new Map<string, Failed>();
  readonly #newId: () => string;

  constructor(newId: () => string = () => crypto.randomUUID()) {
    this.#newId = newId;
  }

  /** The id for this send, and the transcript row a failed first attempt left when this resends it. */
  take(sessionId: string, text: string, attachments: readonly Attachment[]): { requestId: string; earlierRow?: string } {
    const failed = this.#failed.get(sessionId);
    this.#failed.delete(sessionId);
    if (failed && samePayload(failed, { text, attachments })) {
      return { requestId: failed.requestId, ...(failed.row ? { earlierRow: failed.row } : {}) };
    }
    return { requestId: this.#newId() };
  }

  /** A send that failed: its resend may reuse the id. `row` is the failed message the transcript shows for it. */
  failed(sessionId: string, requestId: string, text: string, attachments: readonly Attachment[], row?: string): void {
    this.#failed.set(sessionId, { requestId, text, attachments: [...attachments], ...(row ? { row } : {}) });
  }
}
