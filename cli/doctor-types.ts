/** The shapes of a `hui doctor` check, its result and the items it reports. */
export type DoctorItem = {
  /** What the item is about, such as a session ID. */
  id: string;
  label: string;
  /** `issue`: `--fix` changes it. `blocked`: the operator acts first. `fixed`, `failed`: what `--fix` did. */
  status: "issue" | "blocked" | "fixed" | "failed";
  detail?: string;
};

export type DoctorResult = {
  id: string;
  title: string;
  /** `ok`: nothing to change. `fixed`: `--fix` changed everything it found. `issue`: something remains. */
  status: "ok" | "issue" | "fixed";
  summary: string;
  items: DoctorItem[];
  notes: string[];
};

export type DoctorCheck = {
  id: string;
  title: string;
  /** Reads state only. */
  inspect(): Promise<DoctorResult>;
  /** Changes what `inspect` reported as `issue`. Runs with the gateway stopped, under the lifecycle lock. */
  fix?(): Promise<DoctorResult>;
};
