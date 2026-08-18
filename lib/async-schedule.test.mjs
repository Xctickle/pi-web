import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const schedule = await jiti.import("./async-schedule.ts");
const mutations = await jiti.import("./async-mutations.ts");

const { buildCronLines, parseScheduleSpec, isValidTaskName, normalizeTime, scheduleSpecProblem } = schedule;
const { removeTaskFromCrontab } = mutations;

const WRAPPER = "/home/user/bin/async-task.sh";
const DIR = "/home/user/.pi/async-tasks";

test("isValidTaskName accepts kebab-case and rejects the rest", () => {
  assert.equal(isValidTaskName("idea-sweep"), true);
  assert.equal(isValidTaskName("a"), true);
  assert.equal(isValidTaskName("2nd-task"), true);
  assert.equal(isValidTaskName(""), false);
  assert.equal(isValidTaskName("-lead"), false);
  assert.equal(isValidTaskName("Upper"), false);
  assert.equal(isValidTaskName("has space"), false);
  assert.equal(isValidTaskName("../escape"), false);
});

test("normalizeTime normalizes and validates HH:MM", () => {
  assert.equal(normalizeTime("9:5"), "09:05");
  assert.equal(normalizeTime("23:59"), "23:59");
  assert.equal(normalizeTime("24:00"), null);
  assert.equal(normalizeTime("12:60"), null);
  assert.equal(normalizeTime("abc"), null);
});

test("scheduleSpecProblem flags empty times and bad weekdays", () => {
  assert.equal(scheduleSpecProblem({ mode: "daily", times: [], weekdays: [], dayOfMonth: 1, autoClear: false }), "time");
  assert.equal(scheduleSpecProblem({ mode: "daily", times: ["09:00"], weekdays: [], dayOfMonth: 1, autoClear: false }), null);
  assert.equal(scheduleSpecProblem({ mode: "weekly", times: ["09:00"], weekdays: [], dayOfMonth: 1, autoClear: false }), "weekday");
  assert.equal(scheduleSpecProblem({ mode: "monthly", times: ["09:00"], weekdays: [], dayOfMonth: 0, autoClear: false }), "time");
});

test("buildCronLines renders daily, weekly, monthly with optional auto-clear", () => {
  const daily = buildCronLines({ name: "idea-sweep", spec: { mode: "daily", times: ["19:10", "07:05"], weekdays: [], dayOfMonth: 1, autoClear: false }, wrapperPath: WRAPPER, tasksDir: DIR });
  assert.deepEqual(daily, [
    "5 7 * * * /home/user/bin/async-task.sh idea-sweep",
    "10 19 * * * /home/user/bin/async-task.sh idea-sweep",
  ]);

  const weekly = buildCronLines({ name: "radar", spec: { mode: "weekly", times: ["19:30"], weekdays: [4, 1], dayOfMonth: 1, autoClear: true }, wrapperPath: WRAPPER, tasksDir: DIR });
  assert.deepEqual(weekly, [
    "25 19 * * 1,4 rm -f /home/user/.pi/async-tasks/.done-radar",
    "30 19 * * 1,4 /home/user/bin/async-task.sh radar",
  ]);

  const monthly = buildCronLines({ name: "maint", spec: { mode: "monthly", times: ["19:20"], weekdays: [], dayOfMonth: 1, autoClear: false }, wrapperPath: WRAPPER, tasksDir: DIR });
  assert.deepEqual(monthly, ["20 19 1 * * /home/user/bin/async-task.sh maint"]);
});

test("buildCronLines clamps auto-clear at midnight boundary", () => {
  const lines = buildCronLines({ name: "early", spec: { mode: "daily", times: ["00:03"], weekdays: [], dayOfMonth: 1, autoClear: true }, wrapperPath: WRAPPER, tasksDir: DIR });
  assert.deepEqual(lines, [
    "0 0 * * * rm -f /home/user/.pi/async-tasks/.done-early",
    "3 0 * * * /home/user/bin/async-task.sh early",
  ]);
});

test("parseScheduleSpec round-trips structured expressions", () => {
  assert.deepEqual(parseScheduleSpec("30 19 * * 1,4", true), { mode: "weekly", times: ["19:30"], weekdays: [1, 4], dayOfMonth: 1, autoClear: true });
  assert.deepEqual(parseScheduleSpec("10 9,11,14 * * *", false), { mode: "daily", times: ["09:10", "11:10", "14:10"], weekdays: [1], dayOfMonth: 1, autoClear: false });
  assert.deepEqual(parseScheduleSpec("20 19 1 * *", false), { mode: "monthly", times: ["19:20"], weekdays: [1], dayOfMonth: 1, autoClear: false });
  assert.deepEqual(parseScheduleSpec("0 19 * * 7", false)?.weekdays, [0]);
  assert.equal(parseScheduleSpec("*/10 * * * *", false), null);
  assert.equal(parseScheduleSpec("0 19 * 2 *", false), null);
  assert.equal(parseScheduleSpec(null, false), null);
});

const SAMPLE_CRONTAB = [
  "30 6 * * 0 /home/user/.hermes/scripts/weekly.sh",
  "",
  "# 修复 pi 备份链路(周一重试窗口)",
  "10 9,11,14 * * 1 /home/user/bin/async-task.sh workmachine-kb-reshare",
  "",
  "# self-capture-sweep: 每日扫描",
  "50 18 * * * rm -f /home/user/.pi/async-tasks/.done-self-capture-sweep",
  "0 19 * * * /home/user/bin/async-task.sh self-capture-sweep",
  "",
  "# idea-sweep: 每日 19:10",
  "55 18 * * * rm -f /home/user/.pi/async-tasks/.done-idea-sweep",
  "10 19 * * * /home/user/bin/async-task.sh idea-sweep",
  "",
].join("\n");

test("removeTaskFromCrontab strips the block, keeps its comment, leaves others intact", () => {
  const { text, comment } = removeTaskFromCrontab(SAMPLE_CRONTAB, "idea-sweep");
  assert.equal(comment, "idea-sweep: 每日 19:10");
  assert.ok(!text.includes("idea-sweep"));
  assert.ok(text.includes("async-task.sh self-capture-sweep"));
  assert.ok(text.includes("async-task.sh workmachine-kb-reshare"));
  assert.ok(text.includes("weekly.sh"));
});

test("removeTaskFromCrontab handles tasks without a clear line or comment", () => {
  const { text, comment } = removeTaskFromCrontab(SAMPLE_CRONTAB, "workmachine-kb-reshare");
  assert.ok(comment && comment.includes("修复 pi 备份链路"));
  assert.ok(!text.includes("workmachine-kb-reshare"));
  // A comment block that does not mention the task name must survive removal
  // of the following command line — here the night-guard style is not present,
  // so verify with a foreign comment directly above an unrelated entry.
  const foreign = "# unrelated note\n0 8 * * * /usr/bin/other\n";
  const kept = removeTaskFromCrontab(`${foreign}10 9 * * 1 ${WRAPPER} t1`, "t1");
  assert.ok(kept.text.includes("# unrelated note"));
});

test("removeTaskFromCrontab is a no-op for unknown tasks", () => {
  const { text, comment } = removeTaskFromCrontab(SAMPLE_CRONTAB, "ghost-task");
  assert.equal(text, SAMPLE_CRONTAB);
  assert.equal(comment, null);
});
