import { NextResponse } from "next/server";
import { collectBackupStatus } from "@/lib/backup-status";

export const dynamic = "force-dynamic";

// GET /api/backups → read-only backup chain status snapshot
export async function GET() {
  try {
    const status = await collectBackupStatus();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
