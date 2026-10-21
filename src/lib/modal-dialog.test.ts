import assert from "node:assert/strict";
import { test } from "vitest";
import { closeModal, ensureModal, type ModalDialog } from "./modal-dialog.ts";

function fakeDialog() {
  let showCalls = 0;
  let closeCalls = 0;
  const dialog: ModalDialog = {
    open: false,
    showModal() {
      showCalls += 1;
      dialog.open = true;
    },
    close() {
      closeCalls += 1;
      dialog.open = false;
    },
  };
  return { dialog, showCalls: () => showCalls, closeCalls: () => closeCalls };
}

test("a rendered delete dialog enters the modal top layer once", () => {
  const fake = fakeDialog();
  ensureModal(fake.dialog);
  ensureModal(fake.dialog);
  assert.equal(fake.showCalls(), 1);
  assert.equal(fake.dialog.open, true);
});

test("closing releases modal state before Lit removes the dialog", () => {
  const fake = fakeDialog();
  ensureModal(fake.dialog);
  closeModal(fake.dialog);
  closeModal(fake.dialog);
  assert.equal(fake.closeCalls(), 1);
  assert.equal(fake.dialog.open, false);
});
