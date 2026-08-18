import { NextRequest, NextResponse } from "next/server";
import { collectAsyncStatus } from "@/lib/async-status";
import type { ScheduleSpec } from "@/lib/async-schedule";
import {
  MutationError,
  clearFailedLogs,
  deleteTask,
  runTaskNow,
  saveModelOverride,
  saveTaskBrief,
  saveTaskSchedule,
  setDoneMarker,
} from "@/lib/async-mutations";

export const dynamic = "force-dynamic";

// GET /api/async-tasks → read-only async task status snapshot
export async function GET() {
  try {
    const status = await collectAsyncStatus();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/**
 * POST /api/async-tasks → mutate one task. Actions:
 *   save-brief    { name, content }
 *   set-done      { name, done, summary? }
 *   save-schedule { name, spec: ScheduleSpec | null }
 *   save-model    { name, model: string | null }
 *   run-now       { name }
 *   clear-failed  { name }
 *   delete        { name }
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = body.action;
  const name = typeof body.name === "string" ? body.name : "";
  if (typeof action !== "string" || typeof name !== "string") {
    return NextResponse.json({ error: "action and name required" }, { status: 400 });
  }
  try {
    switch (action) {
      case "save-brief":
        await saveTaskBrief(name, String(body.content ?? ""));
        break;
      case "set-done":
        await setDoneMarker(name, body.done === true, typeof body.summary === "string" ? body.summary : undefined);
        break;
      case "save-schedule":
        await saveTaskSchedule(name, (body.spec ?? null) as ScheduleSpec | null);
        break;
      case "save-model":
        await saveModelOverride(name, typeof body.model === "string" ? body.model : null);
        break;
      case "run-now":
        await runTaskNow(name);
        break;
      case "clear-failed":
        await clearFailedLogs(name);
        break;
      case "delete":
        await deleteTask(name);
        break;
      default:
        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof MutationError ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
