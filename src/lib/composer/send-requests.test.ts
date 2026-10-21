import assert from "node:assert/strict";
import { test } from "vitest";
import { SendRequests } from "./send-requests.ts";
import type { Attachment } from "../../api/sessions.ts";

const image: Attachment = { kind: "image", name: "shot.png", mimeType: "image/png", dataBase64: "AAAA" };

test("a resend of a failed payload reuses its id and names the row it left", () => {
  let next = 0;
  const requests = new SendRequests(() => `id-${++next}`);
  const first = requests.take("s1", "Plan it", [image]);
  assert.deepEqual(first, { requestId: "id-1" });
  requests.failed("s1", first.requestId, "Plan it", [image], "local-row-1");
  assert.deepEqual(requests.take("s1", "Plan it", [{ ...image }]), { requestId: "id-1", earlierRow: "local-row-1" }, "same contents, another object");
  assert.deepEqual(requests.take("s1", "Plan it", [image]), { requestId: "id-2" }, "once resent, the id is used up");
});

test("another text, other attachments or another session get a new id", () => {
  let next = 0;
  const requests = new SendRequests(() => `id-${++next}`);
  requests.failed("s1", "kept", "Plan it", [image]);
  assert.equal(requests.take("s1", "Plan it carefully", [image]).requestId, "id-1");
  requests.failed("s1", "kept", "Plan it", [image]);
  assert.equal(requests.take("s1", "Plan it", [{ ...image, dataBase64: "BBBB" }]).requestId, "id-2");
  requests.failed("s1", "kept", "Plan it", [image]);
  assert.equal(requests.take("s1", "Plan it", []).requestId, "id-3");
  requests.failed("s1", "kept", "Plan it", [image]);
  assert.equal(requests.take("s2", "Plan it", [image]).requestId, "id-4");
  assert.equal(requests.take("s1", "Plan it", [image]).requestId, "kept", "s1's failed send is still there");
});
