import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseRunLog,
  parseDoneMarker,
  keepAwakeFrom,
  parseFailedLogName,
  parseCrontab,
  describeCron,
  isTaskBriefFile,
} = await jiti.import("./async-status.ts");

test("isTaskBriefFile accepts kebab-case briefs and rejects the rest", () => {
  assert.equal(isTaskBriefFile("workmachine-kb-reshare.md"), true);
  assert.equal(isTaskBriefFile("simple.md"), true);
  assert.equal(isTaskBriefFile(".done-simple"), false);
  assert.equal(isTaskBriefFile("run-simple.log"), false);
  assert.equal(isTaskBriefFile("Upper-Case.md"), false);
  assert.equal(isTaskBriefFile("crontab.backup-20260816"), false);
});

test("parseRunLog splits segments, captures exit codes, and trims tails", () => {
  const content = [
    "=== 2026-08-15T10:00:00+08:00 run ===",
    "first run line 1",
    "line 2",
    "=== exit=0 ===",
    "",
    "=== 2026-08-15T17:40:25+08:00 run ===",
    "second run body",
    "",
    "=== exit=1 ===",
  ].join("\n");

  const segments = parseRunLog(content);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].startedAt, "2026-08-15T10:00:00+08:00");
  assert.equal(segments[0].exitCode, 0);
  assert.deepEqual(segments[0].tail, ["first run line 1", "line 2"]);
  assert.equal(segments[1].exitCode, 1);
  // Trailing blank before the exit marker must be trimmed.
  assert.deepEqual(segments[1].tail, ["second run body"]);
});

test("parseRunLog keeps unterminated segments with null exit code", () => {
  const segments = parseRunLog("=== 2026-08-16T09:00:00+08:00 run ===\nstill going\n");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].exitCode, null);
  assert.deepEqual(segments[0].tail, ["still going"]);
});

test("parseRunLog returns empty for content without segment headers", () => {
  assert.deepEqual(parseRunLog("no-brief: missing\n"), []);
  assert.deepEqual(parseRunLog(""), []);
});

test("parseDoneMarker extracts timestamp and summary", () => {
  const parsed = parseDoneMarker("2026-08-16T09:00:00+08:00 验证通过:kb share 已重新共享到工作机\n");
  assert.equal(parsed.timestamp, "2026-08-16T09:00:00+08:00");
  assert.equal(parsed.summary, "验证通过:kb share 已重新共享到工作机");
});

test("parseDoneMarker handles empty and timestamp-only markers", () => {
  assert.deepEqual(parseDoneMarker(""), { timestamp: null, summary: null });
  assert.deepEqual(parseDoneMarker("   \n"), { timestamp: null, summary: null });
  assert.deepEqual(parseDoneMarker("2026-08-16T09:00:00+08:00"), {
    timestamp: "2026-08-16T09:00:00+08:00",
    summary: null,
  });
});

test("keepAwakeFrom maps existence and content onto modes", () => {
  assert.deepEqual(keepAwakeFrom(false, ""), { exists: false, mode: "off", until: null });
  assert.deepEqual(keepAwakeFrom(true, ""), { exists: true, mode: "always", until: null });
  assert.deepEqual(keepAwakeFrom(true, "\n"), { exists: true, mode: "always", until: null });
  assert.deepEqual(keepAwakeFrom(true, "2026-08-20"), { exists: true, mode: "until", until: "2026-08-20" });
});

test("parseFailedLogName extracts task name and date", () => {
  assert.deepEqual(parseFailedLogName("failed-workmachine-kb-reshare-20260815.log"), {
    taskName: "workmachine-kb-reshare",
    date: "20260815",
  });
  assert.equal(parseFailedLogName("run-workmachine-kb-reshare.log"), null);
  assert.equal(parseFailedLogName("failed-task.log"), null);
});

test("parseCrontab finds async-task entries with comments and task names", () => {
  const crontab = [
    "# Hermes 每周备份",
    "30 6 * * 0 /home/xxc/.hermes/scripts/hermes-weekly-backup.sh",
    "*/10 * * * * /home/xxc/.config/steward/sync.sh # xkb 双向 git 同步",
    "",
    "# 贾维斯异步任务:修复 pi 备份→公司工作机链路(周一重试窗口)",
    "10 9,11,14 * * 1 /home/xxc/bin/async-task.sh workmachine-kb-reshare",
    "50 23 * * * /home/xxc/bin/night-shutdown-guard.sh",
  ].join("\n");

  const entries = parseCrontab(crontab);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].taskName, "workmachine-kb-reshare");
  assert.equal(entries[0].expression, "10 9,11,14 * * 1");
  assert.equal(entries[0].command, "/home/xxc/bin/async-task.sh workmachine-kb-reshare");
  assert.match(entries[0].comment ?? "", /贾维斯异步任务/);
});

test("parseCrontab keeps bare async-task.sh lines with null task name", () => {
  const entries = parseCrontab("5 8 * * * /home/xxc/bin/async-task.sh\n");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].taskName, null);
  assert.equal(entries[0].expression, "5 8 * * *");
});

test("describeCron expands numeric fields and flags exotic syntax", () => {
  const descriptor = describeCron("10 9,11,14 * * 1");
  assert.ok(descriptor);
  assert.deepEqual(descriptor.minutes, [10]);
  assert.deepEqual(descriptor.hours, [9, 11, 14]);
  assert.equal(descriptor.dayOfWeek, "1");
  assert.equal(descriptor.month, "*");

  assert.deepEqual(describeCron("*/15 * * * *")?.minutes, [0, 15, 30, 45]);
  assert.deepEqual(describeCron("0 9-11 * * *")?.hours, [9, 10, 11]);
  assert.equal(describeCron("0 9 * * mon"), null);
  assert.equal(describeCron("not a cron"), null);
});
