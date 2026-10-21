/** The prompt HUI sends to resume a run that the gateway lost mid-turn. PI
 * stores it as an ordinary user message, so transcript readers use
 * `interruptedRunOriginal` to recover the operator's actual request from it. */
const PREFIX = "The previous run was interrupted while handling this request:\n\n";
const SUFFIX = "\n\nReview the latest transcript and workspace state, finish the unfinished task, and avoid repeating work that is already complete.";
export const INTERRUPTED_RUN_PROMPT = "Continue from where the previous run was interrupted. Review the latest transcript and workspace state, finish the unfinished task, and avoid repeating work that is already complete.";

export function interruptedRunPrompt(original?: string): string {
  const request = original?.trim();
  return request ? `${PREFIX}${request}${SUFFIX}` : INTERRUPTED_RUN_PROMPT;
}

/** The request wrapped by `interruptedRunPrompt`: a string (possibly empty)
 * for a recovery prompt, undefined for any other message. */
export function interruptedRunOriginal(text: string): string | undefined {
  if (text.trim() === INTERRUPTED_RUN_PROMPT) return "";
  if (!text.startsWith(PREFIX) || !text.endsWith(SUFFIX)) return undefined;
  return text.slice(PREFIX.length, text.length - SUFFIX.length).trim();
}
