/** OpenClaw retains three session views per pane in stable render slots. An
 * unsaved queue edit pins its view until committed/cancelled, even above the cap. */
export class SessionViewCache {
  private readonly lru = new Map<string, number>();
  private readonly slots: Array<string | undefined> = [];

  removeMissing(validIds: ReadonlySet<string>) {
    for (const [id, slot] of this.lru) if (!validIds.has(id)) {
      this.lru.delete(id);
      this.slots[slot] = undefined;
    }
  }

  retain(current: string, protectedIds: ReadonlySet<string> = new Set()): string[] {
    let slot = this.lru.get(current);
    if (slot === undefined) {
      slot = this.slots.findIndex((id) => id === undefined);
      if (slot < 0 && this.lru.size >= 3) {
        const oldest = [...this.lru].find(([id]) => !protectedIds.has(id));
        if (oldest) {
          this.lru.delete(oldest[0]);
          slot = oldest[1];
        }
      }
      if (slot < 0) slot = this.slots.length;
      this.slots[slot] = current;
    }
    this.lru.delete(current);
    this.lru.set(current, slot);
    for (const [id, index] of this.lru) {
      if (this.lru.size <= 3) break;
      if (id === current || protectedIds.has(id)) continue;
      this.lru.delete(id);
      this.slots[index] = undefined;
    }
    while (this.slots.length > 3 && this.slots.at(-1) === undefined) this.slots.pop();
    return this.slots.filter((id): id is string => id !== undefined);
  }
}
