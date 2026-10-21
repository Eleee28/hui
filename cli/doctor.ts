/**
 * `hui doctor` reports state an upgraded HUI needs changed, and `hui doctor --fix` changes it. Every check only reads,
 * so a report is safe while a gateway runs. Fixes run under the lifecycle lock, after the gateway is confirmed
 * stopped, so none starts meanwhile. A breaking change to persisted state ships with a check here (CONTRIBUTING.md).
 */
import { gatewayStatus as currentGatewayStatus, type GatewayStatus } from "./gateway.ts";
import { piSessionsCheck } from "./doctor-pi-sessions.ts";
import { triggersCheck } from "./doctor-triggers.ts";
import { withLifecycleLock } from "./state.ts";
import type { DoctorCheck, DoctorItem, DoctorResult } from "./doctor-types.ts";

export type DoctorReport = { ok: boolean; checks: DoctorResult[] };

export const DOCTOR_CHECKS: readonly DoctorCheck[] = [piSessionsCheck, triggersCheck];

export async function runDoctor(options: {
  fix?: boolean;
  checks?: readonly DoctorCheck[];
  gatewayStatus?: () => Promise<GatewayStatus>;
  lock?: <T>(operation: () => Promise<T>) => Promise<T>;
} = {}): Promise<DoctorReport> {
  const checks = options.checks ?? DOCTOR_CHECKS;
  let results: DoctorResult[] = [];
  for (const check of checks) results.push(await check.inspect());
  const fixable = checks.filter((check, index) => check.fix && results[index]!.items.some((item) => item.status === "issue"));
  if (options.fix && fixable.length) {
    results = await (options.lock ?? withLifecycleLock)(async () => {
      const gateway = await (options.gatewayStatus ?? currentGatewayStatus)();
      if (gateway.status !== "stopped") {
        throw new Error(`Stop the gateway before hui doctor --fix${gateway.status === "unresponsive" ? " (it is not responding)" : ""}: run hui gateway stop, and stop any development gateway too.`);
      }
      const fixed = [...results];
      for (const check of fixable) fixed[checks.indexOf(check)] = await check.fix!();
      return fixed;
    });
  }
  return { ok: results.every((result) => result.status !== "issue"), checks: results };
}

const MARKS: Record<DoctorItem["status"], string> = { issue: "•", blocked: "!", fixed: "✓", failed: "✗" };

export function formatDoctorReport(report: DoctorReport): string {
  return report.checks.flatMap((check) => [
    `${check.status === "issue" ? "✗" : "✓"} ${check.title}: ${check.summary}`,
    ...check.items.map((item) => `    ${MARKS[item.status]} ${item.label}${item.detail ? `: ${item.detail}` : ""}`),
    ...check.notes.map((note) => `  ${note}`),
  ]).join("\n");
}
