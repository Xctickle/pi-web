import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseArchiveTimestamp,
  parseBackupFilename,
  expectedSidecarName,
  extractScriptSummary,
  parseHumanSize,
  parseIndexLog,
  mergeBackupArchives,
  aggregateBackupDays,
} = await jiti.import("./backup-status.ts");
const { resolveArchivePath } = await jiti.import("./backup-mutations.ts");

test("parseArchiveTimestamp validates and normalizes timestamps", () => {
  assert.equal(parseArchiveTimestamp("20260816T083044Z"), "2026-08-16T08:30:44Z");
  assert.equal(parseArchiveTimestamp("20260230T000000Z"), null); // Feb 30 does not exist
  assert.equal(parseArchiveTimestamp("20260816T083044"), null);
  assert.equal(parseArchiveTimestamp("garbage"), null);
});

test("parseBackupFilename matches archives with dashed hosts and skips other files", () => {
  const parsed = parseBackupFilename("pi-backup-xxc-Standard-PC-Q35-ICH9-2009-20260816T083044Z.tar.gz.gpg");
  assert.ok(parsed);
  assert.equal(parsed.host, "xxc-Standard-PC-Q35-ICH9-2009");
  assert.equal(parsed.timestamp, "2026-08-16T08:30:44Z");

  assert.equal(parseBackupFilename("pi-backup-xxc-Standard-PC-Q35-ICH9-2009-20260816T083044Z.tar.gz.gpg.sha256"), null);
  assert.equal(parseBackupFilename("notes.txt"), null);
  assert.equal(parseBackupFilename("pi-backup-host-2026081T08304Z.tar.gz.gpg"), null);
});

test("expectedSidecarName appends .sha256", () => {
  assert.equal(
    expectedSidecarName("pi-backup-h-20260816T083044Z.tar.gz.gpg"),
    "pi-backup-h-20260816T083044Z.tar.gz.gpg.sha256",
  );
});

test("extractScriptSummary collects leading comments and stops at code", () => {
  const script = [
    "#!/usr/bin/env bash",
    "# 每晚加密备份 ~/.pi/agent 到 ~/kb/pi-backups",
    "# 范围: agent 配置/sessions/skills/extensions + async-infra",
    "",
    "set -euo pipefail",
    "# inline comment after code is not part of the leading block",
    "DEST=\"$HOME/kb/pi-backups\"",
  ].join("\n");

  assert.equal(
    extractScriptSummary(script),
    "每晚加密备份 ~/.pi/agent 到 ~/kb/pi-backups\n范围: agent 配置/sessions/skills/extensions + async-infra",
  );
});

test("extractScriptSummary falls back to inline phase comments without a header", () => {
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "DEST=\"$HOME/kb/pi-backups\"",
    "# ① staging:文本/配置/skills/extensions,排除可重建物",
    "mkdir -p \"$STAGE/agent\"",
    "# ①b 异步任务体系(任务书/标记/日志)+ 自举脚本",
  ].join("\n");

  const summary = extractScriptSummary(script);
  assert.ok(summary);
  assert.match(summary, /① staging/);
  assert.match(summary, /①b 异步任务体系/);
  assert.doesNotMatch(summary, /set -euo/);
});

test("extractScriptSummary returns null without any comments", () => {
  assert.equal(extractScriptSummary("set -euo pipefail\nDEST=1\n"), null);
});

test("extractScriptSummary caps output length", () => {
  const script = Array.from({ length: 30 }, (_, i) => `# line ${i}`).join("\n");
  const summary = extractScriptSummary(script);
  assert.ok(summary);
  assert.equal(summary.split("\n").length, 20);
});

test("parseHumanSize converts du -h style sizes", () => {
  assert.equal(parseHumanSize("12M"), 12 * 1024 ** 2);
  assert.equal(parseHumanSize("3.4M"), 3565158);
  assert.equal(parseHumanSize("500K"), 512000);
  assert.equal(parseHumanSize("1.2G"), 1288490189);
  assert.equal(parseHumanSize("988"), 988);
  assert.equal(parseHumanSize("garbage"), 0);
  assert.equal(parseHumanSize(""), 0);
});

test("parseIndexLog parses valid lines and skips malformed ones", () => {
  const log = [
    "2026-08-15T18:48:12+08:00\t120M\t/home/xxc/kb/pi-backups/pi-backup-xxc-Standard-PC-Q35-ICH9-2009-20260815T104759Z.tar.gz.gpg",
    "2026-08-18T22:00:03+08:00\t12M\t/home/xxc/kb/pi-backups/pi-backup-xxc-Standard-PC-Q35-ICH9-2009-20260818T140001Z.tar.gz.gpg",
    "not-a-date\t5M\t/home/xxc/kb/pi-backups/pi-backup-h-20260816T083044Z.tar.gz.gpg",
    "2026-08-18T22:00:03+08:00\t5M\tnotes.txt",
    "2026-08-18T22:00:03+08:00\t5M",
    "",
  ].join("\n");
  const entries = parseIndexLog(log);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].file, "pi-backup-xxc-Standard-PC-Q35-ICH9-2009-20260815T104759Z.tar.gz.gpg");
  assert.equal(entries[0].timestamp, "2026-08-15T10:47:59Z");
  assert.equal(entries[0].sizeText, "120M");
  assert.equal(entries[0].sizeBytes, 125829120); // historical 120M anomaly parsed
  assert.equal(entries[1].sizeBytes, 12582912);
  assert.equal(entries[1].loggedAt, "2026-08-18T14:00:03.000Z");
});

test("mergeBackupArchives keeps disk truth and flags log-only entries rotated", () => {
  const disk = [
    { file: "pi-backup-h-20260818T140001Z.tar.gz.gpg", host: "h", timestamp: "2026-08-18T14:00:01Z", sizeBytes: 12_582_912, hasSha256Sidecar: true, rotated: false },
  ];
  const log = parseIndexLog(
    [
      "2026-08-15T18:48:12+08:00\t120M\t/home/xxc/kb/pi-backups/pi-backup-h-20260815T104759Z.tar.gz.gpg",
      "2026-08-18T22:00:03+08:00\t12M\t/home/xxc/kb/pi-backups/pi-backup-h-20260818T140001Z.tar.gz.gpg",
    ].join("\n"),
  );
  const merged = mergeBackupArchives(disk, log);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((entry) => entry.file), [
    "pi-backup-h-20260818T140001Z.tar.gz.gpg",
    "pi-backup-h-20260815T104759Z.tar.gz.gpg",
  ]); // newest first
  const present = merged[0];
  assert.equal(present.rotated, false);
  assert.equal(present.sizeBytes, 12_582_912); // disk size wins over log size
  assert.equal(present.hasSha256Sidecar, true);
  const rotatedEntry = merged[1];
  assert.equal(rotatedEntry.rotated, true);
  assert.equal(rotatedEntry.sizeBytes, 125829120);
  assert.equal(rotatedEntry.hasSha256Sidecar, false);
});

test("aggregateBackupDays buckets the last 14 local days with empty gaps", () => {
  const now = new Date(2026, 7, 19, 12, 0, 0); // local 2026-08-19 noon
  const archives = [
    { timestamp: new Date(2026, 7, 17, 8, 5, 0).toISOString() },
    { timestamp: new Date(2026, 7, 17, 23, 50, 0).toISOString() },
    { timestamp: new Date(2026, 7, 16, 22, 0, 0).toISOString() },
  ];
  const buckets = aggregateBackupDays(archives, now, 14);
  assert.equal(buckets.length, 14);
  const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));
  assert.equal(byDate.get("2026-08-19").count, 0); // today: no backup yet
  assert.equal(byDate.get("2026-08-19").latestTime, null);
  assert.equal(byDate.get("2026-08-18").count, 0); // missing day → red in the panel
  assert.equal(byDate.get("2026-08-17").count, 2);
  assert.equal(byDate.get("2026-08-17").latestTime, "23:50"); // newest of the day
  assert.equal(byDate.get("2026-08-16").latestTime, "22:00");
  assert.equal(byDate.get("2026-08-06").count, 0); // oldest bucket in window
  assert.equal(buckets[13].date, "2026-08-19");
});

test("resolveArchivePath accepts only plain archive names inside the backup dir", () => {
  const valid = resolveArchivePath("pi-backup-h-20260816T083044Z.tar.gz.gpg");
  assert.ok(valid);
  assert.ok(valid.endsWith("/kb/pi-backups/pi-backup-h-20260816T083044Z.tar.gz.gpg"));
  assert.equal(resolveArchivePath("../index.log"), null);
  assert.equal(resolveArchivePath(".."), null);
  assert.equal(resolveArchivePath("index.log"), null);
  assert.equal(resolveArchivePath("pi-backup-h-20260816T083044Z.tar.gz.gpg.sha256"), null);
  assert.equal(resolveArchivePath("sub/pi-backup-h-20260816T083044Z.tar.gz.gpg"), null);
  assert.equal(resolveArchivePath(""), null);
});
