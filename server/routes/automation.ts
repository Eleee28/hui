/**
 * `/__hui/automation…`: scheduled tasks, their runs and cancellation over `automation.ts`. `hui.ts` applies the
 * `x-hui` guard before dispatching here.
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { AutomationSnapshot, AutomationCreateResponse, AutomationMutationResponse, AutomationRunResponse, AutomationCancelResponse, AutomationError } from "../api/automation.ts";
export { routeSchemas } from "../api/automation.ts";
import {
  AutomationConflictError,
  AutomationInputError,
  AutomationNotFoundError,
  type AutomationService,
} from "../automation.ts";

export const AUTOMATION_ROUTE = "/__hui/automation";
const AUTOMATION_TASKS_ROUTE = `${AUTOMATION_ROUTE}/tasks`;
const AUTOMATION_TASK_ONE = /^\/__hui\/automation\/tasks\/([^/]+)$/;
const AUTOMATION_TASK_RUN = /^\/__hui\/automation\/tasks\/([^/]+)\/run$/;
const AUTOMATION_RUN_CANCEL = /^\/__hui\/automation\/runs\/([^/]+)\/cancel$/;

function automationErrorStatus(error: unknown): 400 | 404 | 409 | 500 {
  if (error instanceof AutomationNotFoundError) return 404;
  if (error instanceof AutomationConflictError) return 409;
  if (error instanceof AutomationInputError) return 400;
  return 500;
}

export function createAutomationRoutes(deps: { automation: AutomationService }) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { path } = request;
    const { automation } = deps;
    if (path === AUTOMATION_ROUTE && request.method === "GET") {
      try {
        return reply(AutomationSnapshot, await automation.snapshot());
      } catch (error) {
        return reply(AutomationError, {
          error: error instanceof Error ? error.message : "Could not read automation state.",
        }, 500);
      }
    }

    if (path === AUTOMATION_TASKS_ROUTE && request.method === "POST") {
      try {
        const task = await automation.create(await request.json());
        return reply(AutomationCreateResponse, { task, snapshot: await automation.snapshot() }, 201);
      } catch (error) {
        return reply(AutomationError, {
          error: error instanceof Error ? error.message : "Could not create that task.",
        }, automationErrorStatus(error));
      }
    }

    const automationTask = path.match(AUTOMATION_TASK_ONE);
    if (automationTask && (request.method === "PUT" || request.method === "DELETE")) {
      const id = decodeURIComponent(automationTask[1] ?? "");
      try {
        if (request.method === "DELETE") await automation.remove(id);
        else await automation.update(id, await request.json());
        return reply(AutomationMutationResponse, { snapshot: await automation.snapshot() });
      } catch (error) {
        return reply(AutomationError, {
          error: error instanceof Error ? error.message : "Could not update that task.",
        }, automationErrorStatus(error));
      }
    }

    const automationRun = path.match(AUTOMATION_TASK_RUN);
    if (automationRun && request.method === "POST") {
      try {
        const run = await automation.run(decodeURIComponent(automationRun[1] ?? ""));
        return reply(AutomationRunResponse, { run }, 202);
      } catch (error) {
        return reply(AutomationError, {
          error: error instanceof Error ? error.message : "Could not run that task.",
        }, automationErrorStatus(error));
      }
    }

    const automationCancel = path.match(AUTOMATION_RUN_CANCEL);
    if (automationCancel && request.method === "POST") {
      try {
        await automation.cancel(decodeURIComponent(automationCancel[1] ?? ""));
        return reply(AutomationCancelResponse, { ok: true });
      } catch (error) {
        return reply(AutomationError, {
          error: error instanceof Error ? error.message : "Could not cancel that run.",
        }, automationErrorStatus(error));
      }
    }
    return undefined;
  }

  return { handle };
}
