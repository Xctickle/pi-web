import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseArchiveTimestamp,
  parseBackupFilename,
  expectedSidecarName,
  extractScriptSummary,
} = await jiti.import("./backup-status.ts");

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
