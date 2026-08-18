"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { MarkdownBody } from "./MarkdownBody";
import { describeCron } from "@/lib/cron-describe";
import { buildCronLines, isValidTaskName, normalizeTime, parseScheduleSpec, scheduleSpecProblem } from "@/lib/async-schedule";
import type { ScheduleSpec } from "@/lib/async-schedule";
import type { AsyncStatus, AsyncTaskReport } from "@/lib/async-status";

type ColumnId = "draft" | "scheduled" | "done" | "failed";

interface ScheduleDraft {
  mode: "none" | ScheduleSpec["mode"];
  times: string[];
  weekdays: number[];
  dayOfMonth: number;
  autoClear: boolean;
}

const DEFAULT_MODEL = "glm-5.3";

function buttonStyle(disabled?: boolean, danger?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: "none",
    border: `1px solid ${danger ? "#ef4444" : "var(--border)"}`,
    borderRadius: 6,
    color: danger ? "#ef4444" : "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    opacity: disabled ? 0.5 : 1,
    whiteSpace: "nowrap",
  };
}

function chipStyle(color: string): React.CSSProperties {
  return { fontSize: 10, padding: "1px 7px", borderRadius: 999, border: `1px solid ${color}`, color, lineHeight: "16px", whiteSpace: "nowrap" };
}

function formatClock(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/**
 * Column assignment:
 *   failed (missing brief / last exit>0) > rolling (cron + autoClear: never terminal,
 *   the done marker only closes the current round) > done > scheduled > draft.
 */
function taskColumn(task: AsyncTaskReport): ColumnId {
  if (!task.briefExists) return "failed";
  if ((task.lastRun?.exitCode ?? 0) > 0) return "failed";
  if (task.cron && task.autoClear) return "scheduled";
  if (task.doneMarker.exists) return "done";
  if (task.cron) return "scheduled";
  return "draft";
}

/** True for rolling tasks: scheduled and auto-clearing the done marker each round. */
function isRollingTask(task: AsyncTaskReport): boolean {
  return Boolean(task.cron) && task.autoClear;
}

const WEEKDAY_KEYS = ["asyncTasks.weekday.0", "asyncTasks.weekday.1", "asyncTasks.weekday.2", "asyncTasks.weekday.3", "asyncTasks.weekday.4", "asyncTasks.weekday.5", "asyncTasks.weekday.6"];

/** Humanized schedule text: "每周一/四 19:30" style; falls back to raw expression. */
function scheduleText(task: AsyncTaskReport, t: ReturnType<typeof useI18n>["t"]): string {
  if (!task.cron) return t("asyncTasks.scheduleNone");
  const weekdays = (dow: string) =>
    dow
      .split(",")
      .map((token) => {
        const numeric = /^(\d)$/.exec(token.trim());
        if (!numeric) return token;
        let index = Number.parseInt(numeric[1], 10);
        if (index === 7) index = 0;
        return index >= 0 && index <= 6 ? t(WEEKDAY_KEYS[index]) : token;
      })
      .join(", ");
  const descriptor = describeCron(task.cron.expression);
  if (!descriptor) return task.cron.expression;
  const times = descriptor.hours.map((hour) => formatClock(hour, descriptor.minutes[0] ?? 0)).join(", ");
  const everyDay = descriptor.dayOfMonth === "*" && descriptor.month === "*";
  if (everyDay && descriptor.dayOfWeek === "*") return t("asyncTasks.cronDaily", { times });
  if (everyDay && descriptor.dayOfWeek !== "*") return t("asyncTasks.cronWeekly", { weekdays: weekdays(descriptor.dayOfWeek), times });
  return task.cron.expression;
}

function specFromDraft(draft: ScheduleDraft): ScheduleSpec | null {
  if (draft.mode === "none") return null;
  return { mode: draft.mode, times: draft.times, weekdays: draft.weekdays, dayOfMonth: draft.dayOfMonth, autoClear: draft.autoClear };
}

function draftFromTask(task: AsyncTaskReport): ScheduleDraft {
  const spec = parseScheduleSpec(task.cron?.expression ?? null, task.autoClear);
  if (spec) return { ...spec, mode: spec.mode };
  return { mode: "none", times: ["09:00"], weekdays: [1], dayOfMonth: 1, autoClear: task.autoClear };
}

/* ---------------------------------- Card ---------------------------------- */

function TaskCard({
  task,
  t,
  onOpen,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  task: AsyncTaskReport;
  t: ReturnType<typeof useI18n>["t"];
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const failed = taskColumn(task) === "failed";
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        gap: 5,
        cursor: "pointer",
        opacity: dragging ? 0.4 : 1,
        transition: "opacity 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--text)", fontWeight: 600, wordBreak: "break-all" }}>{task.name}</span>
        {failed ? <span style={chipStyle("#ef4444")}>{t("asyncTasks.lastExitFail")}</span> : null}
        {task.doneMarker.exists ? (
          isRollingTask(task) ? (
            <span style={chipStyle("#22c55e")}>{t("asyncTasks.rollingLastDone", { time: task.doneMarker.timestamp ? formatTime(task.doneMarker.timestamp) : "" })}</span>
          ) : (
            <span style={chipStyle("#22c55e")}>{t("asyncTasks.statusDone")}</span>
          )
        ) : null}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "normal" }}>
        {scheduleText(task, t)}
        {task.autoClear ? ` · ${t("asyncTasks.autoClearShort")}` : ""}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
        {task.lastRun
          ? `${t("asyncTasks.lastRun")} ${formatTime(task.lastRun.startedAt)}${task.lastRun.exitCode !== null ? ` · ${t("asyncTasks.exitCode", { code: task.lastRun.exitCode })}` : ""}`
          : t("asyncTasks.lastRunNone")}
      </div>
      {(task.failedLogs.length > 0 || !task.briefExists || task.modelOverride) && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {!task.briefExists ? <span style={chipStyle("#ef4444")}>{t("asyncTasks.briefMissing")}</span> : null}
          {task.failedLogs.length > 0 ? <span style={chipStyle("#d97706")}>{t("asyncTasks.histFailed", { count: task.failedLogs.length })}</span> : null}
          {task.modelOverride ? <span style={chipStyle("var(--text-dim)")}>{task.modelOverride}</span> : null}
        </div>
      )}
    </div>
  );
}

/* ---------------------------- Schedule editor ----------------------------- */

function ScheduleEditor({
  draft,
  onChange,
  previewLines,
  t,
}: {
  draft: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  previewLines: string[];
  t: ReturnType<typeof useI18n>["t"];
}) {
  const [timeInput, setTimeInput] = useState("");
  const modes: Array<{ id: ScheduleDraft["mode"]; label: string }> = [
    { id: "none", label: t("asyncTasks.scheduleNone") },
    { id: "daily", label: t("asyncTasks.scheduleDaily") },
    { id: "weekly", label: t("asyncTasks.scheduleWeekly") },
    { id: "monthly", label: t("asyncTasks.scheduleMonthly") },
  ];
  const addTime = () => {
    const normalized = normalizeTime(timeInput);
    if (!normalized) return;
    if (!draft.times.includes(normalized)) onChange({ ...draft, times: [...draft.times, normalized] });
    setTimeInput("");
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {modes.map((mode) => (
          <button
            key={mode.id}
            onClick={() => onChange({ ...draft, mode: mode.id })}
            style={{
              ...buttonStyle(false),
              borderColor: draft.mode === mode.id ? "var(--accent)" : "var(--border)",
              color: draft.mode === mode.id ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            {mode.label}
          </button>
        ))}
      </div>

      {draft.mode !== "none" ? (
        <>
          {draft.mode === "weekly" ? (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {[1, 2, 3, 4, 5, 6, 0].map((day) => {
                const active = draft.weekdays.includes(day);
                return (
                  <button
                    key={day}
                    onClick={() => onChange({ ...draft, weekdays: active ? draft.weekdays.filter((d) => d !== day) : [...draft.weekdays, day].sort((a, b) => a - b) })}
                    style={{
                      ...buttonStyle(false),
                      padding: "3px 8px",
                      borderColor: active ? "var(--accent)" : "var(--border)",
                      color: active ? "var(--accent)" : "var(--text-muted)",
                    }}
                  >
                    {t(WEEKDAY_KEYS[day])}
                  </button>
                );
              })}
            </div>
          ) : null}
          {draft.mode === "monthly" ? (
            <label style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
              {t("asyncTasks.dayOfMonth")}
              <input
                type="number"
                min={1}
                max={31}
                value={draft.dayOfMonth}
                onChange={(e) => onChange({ ...draft, dayOfMonth: Number.parseInt(e.target.value, 10) || 1 })}
                style={{ width: 64, padding: "3px 6px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 12 }}
              />
            </label>
          ) : null}

          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            {draft.times.map((time) => (
              <span key={time} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, padding: "2px 4px 2px 8px", border: "1px solid var(--border)", borderRadius: 999, fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                {time}
                <button onClick={() => onChange({ ...draft, times: draft.times.filter((item) => item !== time) })} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", padding: "0 4px", fontSize: 12, lineHeight: 1 }}>
                  ×
                </button>
              </span>
            ))}
            <input
              value={timeInput}
              onChange={(e) => setTimeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTime();
                }
              }}
              placeholder={t("asyncTasks.timePlaceholder")}
              style={{ width: 72, padding: "3px 6px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 999, color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }}
            />
            <button onClick={addTime} style={buttonStyle(false)}>{t("asyncTasks.addTime")}</button>
          </div>

          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={draft.autoClear} onChange={(e) => onChange({ ...draft, autoClear: e.target.checked })} />
            {t("asyncTasks.autoClear")}
          </label>

          {previewLines.length ? (
            <div style={{ padding: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>{t("asyncTasks.cronPreview")}</div>
              <pre style={{ margin: 0, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {previewLines.join("\n")}
              </pre>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------ Detail drawer ------------------------------ */

function DetailDrawer({
  task,
  data,
  t,
  busy,
  onAction,
  onClose,
}: {
  task: AsyncTaskReport;
  data: AsyncStatus;
  t: ReturnType<typeof useI18n>["t"];
  busy: boolean;
  onAction: (action: string, payload?: Record<string, unknown>, successText?: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const [brief, setBrief] = useState(task.briefContent ?? "");
  const [briefPreview, setBriefPreview] = useState(false);
  const [model, setModel] = useState(task.modelOverride ?? "");
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFromTask(task));
  const [runOpen, setRunOpen] = useState(false);
  const [briefDirty, setBriefDirty] = useState(false);
  const rawSchedule = Boolean(task.cron) && parseScheduleSpec(task.cron?.expression ?? null, task.autoClear) === null;

  useEffect(() => {
    setBrief(task.briefContent ?? "");
    setModel(task.modelOverride ?? "");
    setDraft(draftFromTask(task));
    setBriefDirty(false);
  }, [task]);

  const spec = specFromDraft(draft);
  const problem = spec ? scheduleSpecProblem(spec) : null;
  const previewLines = spec
    ? buildCronLines({ name: task.name, spec, wrapperPath: data.wrapperPath, tasksDir: data.dir })
    : [];

  const saveSchedule = async () => {
    if (spec && scheduleSpecProblem(spec)) return;
    await onAction("save-schedule", { name: task.name, spec });
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: isMobile ? "100%" : 500,
        maxWidth: "100%",
        background: "var(--bg)",
        borderLeft: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        zIndex: 5,
        boxShadow: "-8px 0 24px rgba(0,0,0,0.12)",
      }}
    >
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1, wordBreak: "break-all" }}>{task.name}</span>
        <button onClick={onClose} style={buttonStyle(false)}>{t("i18n.close")}</button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Status + quick actions */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {task.doneMarker.exists ? (
            <>
              <span style={{ fontSize: 11, color: "#22c55e", alignSelf: "center" }}>
                {t("asyncTasks.markedDoneAt")} {task.doneMarker.timestamp ? formatTime(task.doneMarker.timestamp) : ""}
                {task.doneMarker.summary ? ` — ${task.doneMarker.summary}` : ""}
              </span>
              <button onClick={() => void onAction("set-done", { name: task.name, done: false })} disabled={busy} style={buttonStyle(busy)}>
                {t("asyncTasks.resetPending")}
              </button>
            </>
          ) : (
            <button onClick={() => void onAction("set-done", { name: task.name, done: true })} disabled={busy} style={buttonStyle(busy)}>
              {t("asyncTasks.markDone")}
            </button>
          )}
          <button
            onClick={async () => {
              if (task.doneMarker.exists && !window.confirm(t("asyncTasks.runDoneConfirm"))) return;
              if (task.doneMarker.exists) {
                const cleared = await onAction("set-done", { name: task.name, done: false });
                if (!cleared) return;
              }
              await onAction("run-now", { name: task.name }, t("asyncTasks.runStarted"));
            }}
            disabled={busy || !task.briefExists}
            style={buttonStyle(busy || !task.briefExists)}
          >
            ▶ {t("asyncTasks.runNow")}
          </button>
        </div>
        {isRollingTask(task) ? <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("asyncTasks.rollingNote")}</div> : null}

        {/* Schedule */}
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("asyncTasks.scheduleSection")}</div>
          {rawSchedule ? (
            <div style={{ fontSize: 11, color: "#d97706" }}>
              {t("asyncTasks.scheduleRaw")} <code style={{ fontFamily: "var(--font-mono)" }}>{task.cron?.expression}</code>
            </div>
          ) : null}
          <ScheduleEditor draft={draft} onChange={setDraft} previewLines={previewLines} t={t} />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => void saveSchedule()} disabled={busy || Boolean(problem) || draft.mode === "none"} style={buttonStyle(busy || Boolean(problem) || draft.mode === "none")}>
              {t("asyncTasks.saveSchedule")}
            </button>
            {task.cron ? (
              <button onClick={() => void onAction("save-schedule", { name: task.name, spec: null })} disabled={busy} style={buttonStyle(busy)}>
                {t("asyncTasks.removeSchedule")}
              </button>
            ) : null}
          </div>
        </section>

        {/* Brief */}
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("asyncTasks.briefSection")}</div>
          {!task.briefExists ? <div style={{ fontSize: 11, color: "#ef4444" }}>{t("asyncTasks.briefMissing")}</div> : null}
          {briefPreview ? (
            <div style={{ padding: "8px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, maxHeight: 320, overflow: "auto" }}>
              <MarkdownBody>{brief}</MarkdownBody>
            </div>
          ) : (
            <textarea
              value={brief}
              onChange={(e) => {
                setBrief(e.target.value);
                setBriefDirty(true);
              }}
              placeholder={t("asyncTasks.briefPlaceholder")}
              spellCheck={false}
              style={{ width: "100%", minHeight: 200, padding: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", resize: "vertical", boxSizing: "border-box" }}
            />
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => void onAction("save-brief", { name: task.name, content: brief })}
              disabled={busy || !briefDirty}
              style={buttonStyle(busy || !briefDirty)}
            >
              {t("asyncTasks.saveBrief")}
            </button>
            <button onClick={() => setBriefPreview((open) => !open)} style={buttonStyle(false)}>
              {briefPreview ? t("asyncTasks.hideBrief") : t("asyncTasks.showBrief")}
            </button>
          </div>
        </section>

        {/* Model override */}
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("asyncTasks.modelSection")}</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("asyncTasks.modelPlaceholder", { model: DEFAULT_MODEL })}
              spellCheck={false}
              style={{ flex: 1, padding: "6px 8px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }}
            />
            <button onClick={() => void onAction("save-model", { name: task.name, model })} disabled={busy} style={buttonStyle(busy)}>
              {t("asyncTasks.save")}
            </button>
          </div>
        </section>

        {/* Run log */}
        {task.lastRun && task.lastRun.tail.length ? (
          <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
              {t("asyncTasks.runSection")} — {formatTime(task.lastRun.startedAt)}
              {task.lastRun.exitCode !== null ? ` · ${t("asyncTasks.exitCode", { code: task.lastRun.exitCode })}` : ""}
            </div>
            <button onClick={() => setRunOpen((open) => !open)} style={{ ...buttonStyle(false), alignSelf: "flex-start" }}>
              {runOpen ? t("asyncTasks.hideRunLog") : t("asyncTasks.showRunLog")}
            </button>
            {runOpen ? (
              <pre style={{ margin: 0, padding: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)", maxHeight: 260, overflow: "auto" }}>
                {task.lastRun.tail.join("\n")}
              </pre>
            ) : null}
          </section>
        ) : null}

        {/* Failed logs */}
        {task.failedLogs.length ? (
          <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("asyncTasks.failedLogs")}</div>
            <div style={{ fontSize: 11, color: "#d97706", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
              {task.failedLogs.map((log) => log.file).join(", ")}
            </div>
            <button onClick={() => void onAction("clear-failed", { name: task.name })} disabled={busy} style={buttonStyle(busy)}>
              {t("asyncTasks.clearFailed")}
            </button>
          </section>
        ) : null}

        {/* Danger zone */}
        <section style={{ marginTop: "auto", paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={() => {
              if (!window.confirm(t("asyncTasks.deleteConfirm"))) return;
              void onAction("delete", { name: task.name }).then((ok) => {
                if (ok) onClose();
              });
            }}
            disabled={busy}
            style={buttonStyle(busy, true)}
          >
            {t("asyncTasks.deleteTask")}
          </button>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------ Create drawer ------------------------------ */

function CreateDrawer({
  data,
  t,
  busy,
  onAction,
  onClose,
}: {
  data: AsyncStatus;
  t: ReturnType<typeof useI18n>["t"];
  busy: boolean;
  onAction: (action: string, payload?: Record<string, unknown>, successText?: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState<ScheduleDraft>({ mode: "none", times: ["09:00"], weekdays: [1], dayOfMonth: 1, autoClear: true });

  const nameValid = isValidTaskName(name);
  const spec = specFromDraft(draft);
  const problem = spec ? scheduleSpecProblem(spec) : null;
  const previewLines = spec && nameValid ? buildCronLines({ name, spec, wrapperPath: data.wrapperPath, tasksDir: data.dir }) : [];

  const create = async () => {
    if (!nameValid || problem) return;
    const ok = await onAction("save-brief", { name, content: brief });
    if (!ok) return;
    if (spec) {
      const okSchedule = await onAction("save-schedule", { name, spec });
      if (!okSchedule) return;
    }
    if (model.trim()) {
      const okModel = await onAction("save-model", { name, model });
      if (!okModel) return;
    }
    onClose();
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: isMobile ? "100%" : 500,
        maxWidth: "100%",
        background: "var(--bg)",
        borderLeft: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        zIndex: 5,
        boxShadow: "-8px 0 24px rgba(0,0,0,0.12)",
      }}
    >
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1 }}>{t("asyncTasks.newTask")}</span>
        <button onClick={onClose} style={buttonStyle(false)}>{t("i18n.close")}</button>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 16 }}>
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("asyncTasks.taskName")}</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder={t("asyncTasks.taskNamePlaceholder")}
            spellCheck={false}
            style={{ width: "100%", padding: "6px 8px", background: "var(--bg-panel)", border: `1px solid ${name && !nameValid ? "#ef4444" : "var(--border)"}`, borderRadius: 6, color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
          />
          {name && !nameValid ? <div style={{ fontSize: 11, color: "#ef4444" }}>{t("asyncTasks.invalidName")}</div> : null}
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("asyncTasks.scheduleSection")}</div>
          <ScheduleEditor draft={draft} onChange={setDraft} previewLines={previewLines} t={t} />
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("asyncTasks.briefSection")}</div>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder={t("asyncTasks.briefPlaceholder")}
            spellCheck={false}
            style={{ width: "100%", minHeight: 240, padding: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", resize: "vertical", boxSizing: "border-box" }}
          />
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("asyncTasks.modelSection")}</div>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t("asyncTasks.modelPlaceholder", { model: DEFAULT_MODEL })}
            spellCheck={false}
            style={{ width: "100%", padding: "6px 8px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
          />
        </section>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <button onClick={() => void create()} disabled={busy || !nameValid || Boolean(problem)} style={buttonStyle(busy || !nameValid || Boolean(problem))}>
            {t("asyncTasks.createTask")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Board ---------------------------------- */

export function AsyncTasksPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [data, setData] = useState<AsyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragName, setDragName] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<ColumnId | null>(null);
  const [nightOpen, setNightOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((text: string, bad?: boolean) => {
    setToast({ text, bad });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/async-tasks");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as AsyncStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const mutate = useCallback(
    async (action: string, payload: Record<string, unknown> = {}, successText?: string) => {
      setBusy(true);
      try {
        const res = await fetch("/api/async-tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...payload }),
        });
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        await load(true);
        showToast(successText ?? t("asyncTasks.actionDone"));
        return true;
      } catch (err) {
        showToast(`${t("asyncTasks.actionFailed")}: ${err instanceof Error ? err.message : String(err)}`, true);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, showToast, t],
  );

  const columns = useMemo(
    () =>
      [
        { id: "draft" as ColumnId, color: "var(--text-dim)" },
        { id: "scheduled" as ColumnId, color: "#3b82f6" },
        { id: "done" as ColumnId, color: "#22c55e" },
        { id: "failed" as ColumnId, color: "#ef4444" },
      ].map((col) => ({ ...col, label: t(`asyncTasks.col.${col.id}`) })),
    [t],
  );

  const byColumn = useMemo(() => {
    const map: Record<ColumnId, AsyncTaskReport[]> = { draft: [], scheduled: [], done: [], failed: [] };
    for (const task of data?.tasks ?? []) map[taskColumn(task)].push(task);
    return map;
  }, [data]);

  const selectedTask = useMemo(() => data?.tasks.find((task) => task.name === selected) ?? null, [data, selected]);

  const onDropColumn = async (column: ColumnId, name: string) => {
    setDropCol(null);
    setDragName(null);
    if (column === "failed") return;
    const task = data?.tasks.find((item) => item.name === name);
    if (!task) return;
    if (isRollingTask(task)) {
      if (column === "done") {
        if (!window.confirm(t("asyncTasks.rollingRetireConfirm"))) return;
        const removed = await mutate("save-schedule", { name, spec: null });
        if (!removed) return;
        await mutate("set-done", { name, done: true });
      } else if (column === "draft") {
        if (!window.confirm(t("asyncTasks.rollingToDraftConfirm"))) return;
        const removed = await mutate("save-schedule", { name, spec: null });
        if (!removed) return;
        await mutate("set-done", { name, done: false });
      } else {
        showToast(t("asyncTasks.rollingStayScheduled"));
      }
      return;
    }
    if (column === "done") {
      if (!task.doneMarker.exists) await mutate("set-done", { name, done: true });
    } else if (column === "scheduled") {
      if (task.doneMarker.exists) await mutate("set-done", { name, done: false });
    } else if (column === "draft") {
      if (task.cron) await mutate("save-schedule", { name, spec: null });
    }
  };

  const draggable = (column: ColumnId) => column !== "failed";

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: isMobile ? 8 : 14 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          if (selected || creating) {
            setSelected(null);
            setCreating(false);
          } else onClose();
        }
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          maxWidth: 1400,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Header */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("asyncTasks.title")}</span>
            {data ? <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("asyncTasks.taskCount", { count: data.tasks.length })}</span> : null}
            {busy ? <span style={{ fontSize: 11, color: "var(--accent)" }}>…</span> : null}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setCreating(true)} disabled={busy || !data} style={buttonStyle(busy || !data)}>＋ {t("asyncTasks.newTask")}</button>
            <button onClick={() => void load()} disabled={loading} style={buttonStyle(loading)}>{t("i18n.refresh")}</button>
            <button onClick={onClose} style={buttonStyle(false)}>{t("i18n.close")}</button>
          </div>
        </div>

        {error ? <div style={{ padding: "6px 16px", color: "#ef4444", fontSize: 12 }}>{t("asyncTasks.loadError")} — {error}</div> : null}
        {data && !data.cronAvailable ? (
          <div style={{ padding: "6px 16px", color: "#d97706", fontSize: 12 }}>{t("asyncTasks.crontabUnavailable", { error: data.cronError ?? "" })}</div>
        ) : null}

        {/* Kanban */}
        <div style={{ flex: 1, overflow: "auto", padding: "12px 14px" }}>
          {loading && !data ? (
            <div style={{ color: "var(--text-dim)", fontSize: 13 }}>…</div>
          ) : data && data.tasks.length === 0 ? (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--text-dim)", fontSize: 13 }}>
              <div>{t("asyncTasks.empty", { dir: data.dir })}</div>
              <button onClick={() => setCreating(true)} style={buttonStyle(false)}>＋ {t("asyncTasks.newTask")}</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", minWidth: isMobile ? 4 * 248 : 0 }}>
              {columns.map((col) => {
                const tasks = byColumn[col.id];
                const isDropTarget = dropCol === col.id;
                return (
                  <div
                    key={col.id}
                    onDragOver={(e) => {
                      if (!dragName || !draggable(col.id)) return;
                      e.preventDefault();
                      if (dropCol !== col.id) setDropCol(col.id);
                    }}
                    onDragLeave={() => setDropCol((current) => (current === col.id ? null : current))}
                    onDrop={(e) => {
                      e.preventDefault();
                      const name = e.dataTransfer.getData("text/plain") || dragName;
                      if (name) void onDropColumn(col.id, name);
                    }}
                    style={{
                      flex: "1 1 0",
                      minWidth: 236,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      borderRadius: 8,
                      outline: isDropTarget ? "2px dashed var(--accent)" : "none",
                      outlineOffset: 2,
                      background: isDropTarget ? "var(--bg-hover)" : "transparent",
                      paddingBottom: 8,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 2px" }}>
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: col.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{col.label}</span>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{tasks.length}</span>
                    </div>
                    {tasks.map((task) => (
                      <TaskCard
                        key={task.name}
                        task={task}
                        t={t}
                        dragging={dragName === task.name}
                        onOpen={() => setSelected(task.name)}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", task.name);
                          e.dataTransfer.effectAllowed = "move";
                          setDragName(task.name);
                        }}
                        onDragEnd={() => {
                          setDragName(null);
                          setDropCol(null);
                        }}
                      />
                    ))}
                    {tasks.length === 0 ? (
                      <div style={{ border: "1px dashed var(--border)", borderRadius: 8, padding: "10px 8px", fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>—</div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "6px 16px", borderTop: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("asyncTasks.dragHint")}</div>
          {data ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-dim)" }}>
              <span style={{ color: data.keepAwake.mode === "off" ? "var(--text-dim)" : "#22c55e" }}>
                {t("asyncTasks.nightGuardShort")}:{" "}
                {data.keepAwake.mode === "off" ? t("asyncTasks.keepAwakeOff") : data.keepAwake.mode === "always" ? t("asyncTasks.keepAwakeAlways") : t("asyncTasks.keepAwakeUntil", { date: data.keepAwake.until ?? "" })}
              </span>
              <button onClick={() => setNightOpen((open) => !open)} style={{ ...buttonStyle(false), padding: "2px 8px" }}>
                {nightOpen ? t("asyncTasks.nightLogHide") : t("asyncTasks.nightLogShow")}
              </button>
            </div>
          ) : null}
        </div>
        {data && nightOpen ? (
          <div style={{ maxHeight: 180, overflow: "auto", padding: "8px 16px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>{t("asyncTasks.nightLogTitle")}</div>
            {data.nightLogExists && data.nightLogTail.length ? (
              <pre style={{ margin: 0, padding: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)" }}>
                {data.nightLogTail.join("\n")}
              </pre>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("asyncTasks.nightLogMissing")}</div>
            )}
          </div>
        ) : null}

        {/* Drawers + toast */}
        {selectedTask && data ? (
          <DetailDrawer task={selectedTask} data={data} t={t} busy={busy} onAction={mutate} onClose={() => setSelected(null)} />
        ) : null}
        {creating && data ? <CreateDrawer data={data} t={t} busy={busy} onAction={mutate} onClose={() => setCreating(false)} /> : null}
        {toast ? (
          <div
            style={{
              position: "absolute",
              bottom: 44,
              left: "50%",
              transform: "translateX(-50%)",
              padding: "6px 14px",
              borderRadius: 999,
              background: toast.bad ? "#ef4444" : "var(--bg-panel)",
              border: "1px solid var(--border)",
              color: toast.bad ? "#fff" : "var(--text)",
              fontSize: 12,
              zIndex: 20,
              maxWidth: "80%",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {toast.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}
