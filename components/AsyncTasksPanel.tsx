"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { MarkdownBody } from "./MarkdownBody";
import { describeCron } from "@/lib/cron-describe";
import type { AsyncStatus, AsyncTaskReport } from "@/lib/async-status";

function buttonStyle(disabled?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    opacity: disabled ? 0.5 : 1,
  };
}

function formatClock(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** Humanized cron text from a descriptor; falls back to the raw expression. */
function describeSchedule(
  cron: NonNullable<AsyncTaskReport["cron"]>,
  weekdays: (dow: string) => string,
  daily: (times: string) => string,
  weekly: (weekdays_: string, times: string) => string,
): string {
  const descriptor = describeCron(cron.expression);
  if (!descriptor) return cron.expression;
  const times = descriptor.hours.map((hour) => formatClock(hour, descriptor.minutes[0] ?? 0)).join(", ");
  const everyDay = descriptor.dayOfMonth === "*" && descriptor.month === "*";
  if (everyDay && descriptor.dayOfWeek === "*") return daily(times);
  if (everyDay && descriptor.dayOfWeek !== "*") return weekly(weekdays(descriptor.dayOfWeek), times);
  return cron.expression;
}

const WEEKDAY_KEYS = ["asyncTasks.weekday.0", "asyncTasks.weekday.1", "asyncTasks.weekday.2", "asyncTasks.weekday.3", "asyncTasks.weekday.4", "asyncTasks.weekday.5", "asyncTasks.weekday.6"];

function TaskCard({ task, t }: { task: AsyncTaskReport; t: ReturnType<typeof useI18n>["t"] }) {
  const [briefOpen, setBriefOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
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

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{task.name}</span>
        <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 999, border: "1px solid var(--border)", color: task.doneMarker.exists ? "#22c55e" : "var(--text-dim)" }}>
          {task.doneMarker.exists ? t("asyncTasks.statusDone") : t("asyncTasks.statusPending")}
        </span>
        {!task.briefExists && <span style={{ fontSize: 11, color: "#ef4444" }}>{t("asyncTasks.briefMissing")}</span>}
      </div>

      {task.cron ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          <span style={{ color: "var(--text-dim)" }}>{t("asyncTasks.cronSchedule")}: </span>
          <span style={{ fontFamily: "var(--font-mono)" }}>{task.cron.expression}</span>
          <span> · {describeSchedule(task.cron, weekdays, (times) => t("asyncTasks.cronDaily", { times }), (days, times) => t("asyncTasks.cronWeekly", { weekdays: days, times }))}</span>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("asyncTasks.noCron")}</div>
      )}

      {task.doneMarker.exists && task.doneMarker.timestamp ? (
        <div style={{ fontSize: 12, color: "#22c55e" }}>
          {t("asyncTasks.doneAt")} {formatTime(task.doneMarker.timestamp)}
          {task.doneMarker.summary ? ` — ${task.doneMarker.summary}` : ""}
        </div>
      ) : null}

      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        <span style={{ color: "var(--text-dim)" }}>{t("asyncTasks.lastRun")}: </span>
        {task.lastRun ? (
          <>
            {formatTime(task.lastRun.startedAt)}
            {task.lastRun.exitCode !== null ? ` · ${t("asyncTasks.exitCode", { code: task.lastRun.exitCode })}` : ""}
          </>
        ) : (
          t("asyncTasks.lastRunNone")
        )}
      </div>

      {task.lastRun && task.lastRun.tail.length ? (
        <div>
          <button onClick={() => setRunOpen((open) => !open)} style={{ ...buttonStyle(false), padding: "2px 8px", marginBottom: runOpen ? 4 : 0 }}>
            {runOpen ? t("asyncTasks.hideRunLog") : t("asyncTasks.showRunLog")}
          </button>
          {runOpen ? (
            <pre style={{ margin: 0, padding: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)", maxHeight: 260, overflow: "auto" }}>
              {task.lastRun.tail.join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}

      {task.failedLogs.length ? (
        <div style={{ fontSize: 12, color: "#d97706" }}>
          <span style={{ color: "var(--text-dim)" }}>{t("asyncTasks.failedLogs")}: </span>
          {task.failedLogs.map((log) => log.file).join(", ")}
        </div>
      ) : null}

      {task.briefContent !== null ? (
        <div>
          <button onClick={() => setBriefOpen((open) => !open)} style={{ ...buttonStyle(false), padding: "2px 8px" }}>
            {briefOpen ? t("asyncTasks.hideBrief") : t("asyncTasks.showBrief")}
          </button>
          {briefOpen ? (
            <div style={{ marginTop: 6, padding: "8px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, maxHeight: 360, overflow: "auto" }}>
              <MarkdownBody>{task.briefContent}</MarkdownBody>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AsyncTasksPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [data, setData] = useState<AsyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
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

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 860,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "78vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      >
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("asyncTasks.title")}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => void load()} disabled={loading} style={buttonStyle(loading)}>{t("i18n.refresh")}</button>
            <button onClick={onClose} style={buttonStyle(false)}>{t("i18n.close")}</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {error ? <div style={{ color: "#ef4444", fontSize: 13 }}>{t("asyncTasks.loadError")} — {error}</div> : null}
          {!error && !loading && data && data.tasks.length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 13 }}>{t("asyncTasks.empty", { dir: data.dir })}</div>
          ) : null}
          {data && !data.cronAvailable ? (
            <div style={{ color: "#d97706", fontSize: 12 }}>{t("asyncTasks.crontabUnavailable", { error: data.cronError ?? "" })}</div>
          ) : null}
          {data ? data.tasks.map((task) => <TaskCard key={task.name} task={task} t={t} />) : null}

          {data ? (
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("asyncTasks.nightGuard")}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {data.keepAwake.mode === "off" ? t("asyncTasks.keepAwakeOff")
                  : data.keepAwake.mode === "always" ? t("asyncTasks.keepAwakeAlways")
                  : t("asyncTasks.keepAwakeUntil", { date: data.keepAwake.until ?? "" })}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("asyncTasks.nightLogTitle")}</div>
              {data.nightLogExists && data.nightLogTail.length ? (
                <pre style={{ margin: 0, padding: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)", maxHeight: 200, overflow: "auto" }}>
                  {data.nightLogTail.join("\n")}
                </pre>
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("asyncTasks.nightLogMissing")}</div>
              )}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 16px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden" }}>
            {data ? t("asyncTasks.taskCount", { count: data.tasks.length }) : ""}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("asyncTasks.readOnlyNote")}</div>
        </div>
      </div>
    </div>
  );
}
