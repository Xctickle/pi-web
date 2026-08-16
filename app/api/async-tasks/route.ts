import { NextResponse } from "next/server";
import { collectAsyncStatus } from "@/lib/async-status";

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
