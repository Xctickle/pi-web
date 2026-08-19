import { createReadStream } from "fs";
import { promises as fs } from "fs";
import path from "path";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { collectBackupStatus } from "@/lib/backup-status";
import {
  BackupMutationError,
  getLatestVerify,
  isBackupRunning,
  resolveArchivePath,
  runBackup,
  verifyLatestArchive,
} from "@/lib/backup-mutations";
import { collectRemoteReplicas } from "@/lib/backup-remote";

export const dynamic = "force-dynamic";

// GET /api/backups                → status snapshot (+ latestVerify, remote, backupRunning)
// GET /api/backups?download=<f>   → stream one on-disk archive as attachment
//   (download rides the same route file because the change whitelist does not
//   allow a new app/api/backups/download/route.ts)
export async function GET(request: NextRequest) {
  const download = request.nextUrl.searchParams.get("download");
  if (download !== null) return downloadArchive(download);
  try {
    const [status, remote, backupRunning] = await Promise.all([
      collectBackupStatus(),
      collectRemoteReplicas(), // null on any syncthing failure — never throws
      isBackupRunning(),
    ]);
    return NextResponse.json({ ...status, latestVerify: getLatestVerify(), remote, backupRunning });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

async function downloadArchive(name: string): Promise<NextResponse> {
  const fullPath = resolveArchivePath(name);
  if (!fullPath) return NextResponse.json({ error: "invalid archive name" }, { status: 400 });
  let size = 0;
  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) throw new Error("not a regular file");
    size = stat.size;
  } catch {
    return NextResponse.json({ error: "archive not found" }, { status: 404 });
  }
  const body = Readable.toWeb(createReadStream(fullPath)) as ReadableStream<Uint8Array>;
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${path.basename(fullPath)}"`,
    },
  });
}

/**
 * POST /api/backups → trigger a server-side action. Actions:
 *   run-backup     spawn ~/bin/pi-backup.sh detached (guarded by pgrep)
 *   verify-latest  sha256sum -c the newest archive's sidecar, result cached
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = body.action;
  if (typeof action !== "string") {
    return NextResponse.json({ error: "action required" }, { status: 400 });
  }
  try {
    switch (action) {
      case "run-backup":
        await runBackup();
        return NextResponse.json({ ok: true, running: await isBackupRunning() });
      case "verify-latest": {
        const verify = await verifyLatestArchive();
        return NextResponse.json({ ok: true, verify });
      }
      default:
        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof BackupMutationError ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
