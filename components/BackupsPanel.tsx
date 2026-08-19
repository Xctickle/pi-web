"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { BackupStatus } from "@/lib/backup-status";
import type { VerifyInfo } from "@/lib/backup-mutations";
import type { RemoteReplicas } from "@/lib/backup-remote";

type BackupsResponse = BackupStatus & {
  latestVerify: VerifyInfo | null;
  remote: RemoteReplicas | null;
  backupRunning: boolean;
};

/** Trend chart: how many of the newest archives (full history, rotated included) to chart. */
const TREND_LIMIT = 30;
/** An archive larger than this is an anomaly (historical precedent: one 120M package). */
const OVERSIZE_BYTES = 50 * 1024 * 1024;
const RUN_POLL_MS = 5000;

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

function cardStyle(): React.CSSProperties {
  return { border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 };
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function downloadUrl(file: string): string {
  return `/api/backups?download=${encodeURIComponent(file)}`;
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function BackupsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** ISO moment the user triggered a manual run; null when merely observing an existing run. */
  const triggeredAtRef = useRef<string | null>(null);

  const showToast = useCallback((text: string, bad?: boolean) => {
    setToast({ text, bad });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const load = useCallback(async (silent = false): Promise<BackupsResponse | null> => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/backups");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as BackupsResponse;
      setData(json);
      return json;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Adopt an already-running backup (cron or a previous trigger) into the running state.
  useEffect(() => {
    if (data?.backupRunning && !running && triggeredAtRef.current === null) setRunning(true);
  }, [data, running]);

  // While a backup runs, poll every 5s; stop on a new archive or on the process ending.
  const pollRun = useCallback(async () => {
    const json = await load(true);
    if (!json) return;
    const triggeredAt = triggeredAtRef.current;
    if (triggeredAt && json.latest && json.latest.timestamp > triggeredAt) {
      triggeredAtRef.current = null;
      setRunning(false);
      showToast(t("backups.runDone", { file: json.latest.file }));
    } else if (!json.backupRunning) {
      const observedOnly = triggeredAt === null;
      triggeredAtRef.current = null;
      setRunning(false);
      if (!observedOnly) showToast(t("backups.runEndedNoArchive"), true);
    }
  }, [load, showToast, t]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void pollRun(), RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [running, pollRun]);

  const onRunBackup = useCallback(async () => {
    try {
      const res = await fetch("/api/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run-backup" }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
      triggeredAtRef.current = new Date().toISOString();
      setRunning(true);
      showToast(t("backups.runStarted"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already running")) {
        setRunning(true); // adopt the existing run and just wait for it
        showToast(t("backups.runAlready"));
      } else {
        showToast(`${t("backups.actionFailed")}: ${message}`, true);
      }
    }
  }, [showToast, t]);

  const onVerifyLatest = useCallback(async () => {
    setVerifyBusy(true);
    try {
      const res = await fetch("/api/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify-latest" }),
      });
      const json = (await res.json().catch(() => ({}))) as { verify?: VerifyInfo; error?: string };
      if (!res.ok || json.error || !json.verify) throw new Error(json.error ?? `HTTP ${res.status}`);
      const verify = json.verify;
      setData((prev) => (prev ? { ...prev, latestVerify: verify } : prev));
      showToast(verify.ok ? t("backups.verifyOk") : `${t("backups.verifyFailed")}: ${verify.error ?? ""}`, !verify.ok);
    } catch (err) {
      showToast(`${t("backups.actionFailed")}: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setVerifyBusy(false);
    }
  }, [showToast, t]);

  const ageText = (hours: number): string => {
    if (hours < 1) return t("backups.agoMinutes", { minutes: Math.max(1, Math.round(hours * 60)) });
    if (hours < 48) return t("backups.agoHours", { hours: Math.round(hours) });
    return t("backups.agoDays", { days: Math.round(hours / 24) });
  };

  const rpoOverdue = data !== null && data.latestAgeHours !== null && data.latestAgeHours > data.rpoTargetHours;
  const presentCount = data ? data.archives.filter((archive) => !archive.rotated).length : 0;
  const rotatedCount = data ? data.archives.length - presentCount : 0;
  // Newest TREND_LIMIT archives (full history), oldest → newest for charting.
  const trend = data ? data.archives.slice(0, TREND_LIMIT).reverse() : [];
  const trendMax = trend.reduce((max, archive) => Math.max(max, archive.sizeBytes), 0);

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: isMobile ? 8 : 14 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
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
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("backups.title")}</span>
            {running ? <span style={{ fontSize: 11, color: "var(--accent)" }}>{t("backups.runRunning")}</span> : null}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => void onRunBackup()} disabled={running || loading} style={buttonStyle(running || loading)}>{t("backups.runNow")}</button>
            <button onClick={() => void onVerifyLatest()} disabled={verifyBusy || !data || !data.dirExists} style={buttonStyle(verifyBusy || !data || !data.dirExists)}>
              {verifyBusy ? t("backups.verifyBusy") : t("backups.verify")}
            </button>
            <button onClick={() => void load()} disabled={loading} style={buttonStyle(loading)}>{t("i18n.refresh")}</button>
            <button onClick={onClose} style={buttonStyle(false)}>{t("i18n.close")}</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {error ? <div style={{ color: "#ef4444", fontSize: 13 }}>{t("backups.loadError")} — {error}</div> : null}
          {loading && !data ? <div style={{ color: "var(--text-dim)", fontSize: 13 }}>…</div> : null}

          {data && !data.dirExists ? (
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", color: "#d97706", fontSize: 13 }}>
              {t("backups.dirMissing", { dir: data.dir })}
            </div>
          ) : null}

          {data && data.dirExists ? (
            <div style={cardStyle()}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("backups.healthTitle")}</div>
              {data.latest ? (
                <>
                  <div style={{ fontSize: 12 }}>
                    <span style={{ color: "var(--text-dim)" }}>{t("backups.latestBackup")}: </span>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{data.latest.file}</span>
                    <span style={{ color: rpoOverdue ? "#d97706" : "#22c55e", marginLeft: 10 }}>
                      {data.latestAgeHours !== null
                        ? rpoOverdue
                          ? t("backups.rpoOverdue", { age: ageText(data.latestAgeHours), target: data.rpoTargetHours })
                          : t("backups.rpoOk", { age: ageText(data.latestAgeHours) })
                        : ""}
                    </span>
                  </div>
                  {data.latestVerify ? (
                    <div style={{ fontSize: 12, color: data.latestVerify.ok ? "#22c55e" : "#ef4444" }}>
                      {data.latestVerify.ok
                        ? t("backups.verifyAtOk", { at: new Date(data.latestVerify.at).toLocaleString() })
                        : t("backups.verifyAtFail", { at: new Date(data.latestVerify.at).toLocaleString(), error: data.latestVerify.error ?? "" })}
                    </div>
                  ) : null}
                </>
              ) : (
                <div style={{ fontSize: 12, color: "#d97706" }}>{t("backups.rpoNone")}</div>
              )}
              <div style={{ display: "flex", gap: 3 }} aria-label={t("backups.continuityTitle")}>
                {data.continuity.map((bucket) => {
                  const hasBackup = bucket.count > 0;
                  const notYetDue = !hasBackup && bucket.date === data.today;
                  const background = hasBackup ? "#22c55e" : notYetDue ? "var(--bg-hover)" : "#ef4444";
                  const title = hasBackup
                    ? t("backups.heatDay", { date: bucket.date, count: bucket.count, time: bucket.latestTime ?? "" })
                    : t("backups.heatDayEmpty", { date: bucket.date });
                  return (
                    <div
                      key={bucket.date}
                      title={title}
                      style={{ flex: "1 1 0", height: 18, minWidth: 6, borderRadius: 4, background, opacity: hasBackup ? 0.45 + 0.55 * Math.min(1, bucket.count / 3) : 1 }}
                    />
                  );
                })}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("backups.continuityTitle")}</div>
            </div>
          ) : null}

          {data && trend.length ? (
            <div style={cardStyle()}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                {t("backups.trendTitle", { count: trend.length })} <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-dim)" }}>{t("backups.trendOversizeNote")}</span>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 110 }}>
                {trend.map((archive) => {
                  const oversize = archive.sizeBytes > OVERSIZE_BYTES;
                  const height = trendMax > 0 ? Math.max(2, Math.round((archive.sizeBytes / trendMax) * 100)) : 2;
                  return (
                    <div
                      key={archive.file}
                      title={t("backups.trendBar", { file: archive.file, size: formatBytes(archive.sizeBytes), time: new Date(archive.timestamp).toLocaleString() })}
                      style={{ flex: "1 1 0", minWidth: 3, height: `${height}%`, borderRadius: "3px 3px 0 0", background: oversize ? "#ef4444" : "#3b82f6", opacity: archive.rotated ? 0.45 : 1 }}
                    />
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-dim)" }}>
                <span>{shortTime(trend[0].timestamp)}</span>
                <span>{shortTime(trend[trend.length - 1].timestamp)}</span>
              </div>
            </div>
          ) : null}

          {data && data.archives.length ? (
            <div style={cardStyle()}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                {t("backups.archivesCount", { total: data.archives.length, present: presentCount, rotated: rotatedCount, size: formatBytes(data.totalSizeBytes) })}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {data.archives.map((archive, index) => (
                  <div
                    key={archive.file}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                      fontSize: 12,
                      padding: "4px 6px",
                      borderRadius: 6,
                      background: index === 0 && !archive.rotated ? "var(--bg-hover)" : "transparent",
                      opacity: archive.rotated ? 0.55 : 1,
                    }}
                  >
                    {index === 0 && !archive.rotated ? (
                      <span style={{ fontSize: 10, padding: "0 6px", borderRadius: 999, border: "1px solid rgba(34,197,94,0.5)", color: "#22c55e" }}>{t("backups.latestChip")}</span>
                    ) : null}
                    {archive.rotated ? (
                      <span style={{ fontSize: 10, padding: "0 6px", borderRadius: 999, border: "1px solid rgba(217,119,6,0.5)", color: "#d97706" }}>{t("backups.rotatedChip")}</span>
                    ) : null}
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", wordBreak: "break-all" }}>{archive.file}</span>
                    <span style={{ color: "var(--text-muted)" }}>{new Date(archive.timestamp).toLocaleString()}</span>
                    <span style={{ color: "var(--text-dim)" }}>{formatBytes(archive.sizeBytes)}</span>
                    <span
                      title={t("backups.sha256")}
                      style={{ fontSize: 11, color: archive.hasSha256Sidecar ? "#22c55e" : "#ef4444" }}
                    >
                      {archive.hasSha256Sidecar ? t("backups.sha256Ok") : t("backups.sha256Missing")}
                    </span>
                    {!archive.rotated ? (
                      <a href={downloadUrl(archive.file)} title={t("backups.download")} style={{ ...buttonStyle(false), display: "inline-block", padding: "2px 8px", textDecoration: "none" }}>
                        {t("backups.download")}
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("backups.sidecarNote")}</div>
            </div>
          ) : null}

          {data ? (
            <div style={cardStyle()}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("backups.remoteTitle")}</div>
              {data.remote === null ? (
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("backups.remoteUnreachable")}</div>
              ) : (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {data.remote.devices.map((device) => (
                      <div key={device.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                        <span style={{ color: "var(--text)", minWidth: 120 }}>{device.name}</span>
                        <div style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--bg-hover)", overflow: "hidden" }}>
                          {device.completion !== null ? (
                            <div style={{ width: `${Math.max(0, Math.min(100, device.completion))}%`, height: "100%", background: device.completion >= 100 ? "#22c55e" : "#d97706" }} />
                          ) : null}
                        </div>
                        <span style={{ color: device.completion === null ? "var(--text-dim)" : device.completion >= 100 ? "#22c55e" : "#d97706", minWidth: 44, textAlign: "right" }}>
                          {device.completion === null ? t("backups.remoteUnknown") : `${Math.round(device.completion)}%`}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("backups.remoteNote")}</div>
                </>
              )}
            </div>
          ) : null}

          {data ? (
            <div style={cardStyle()}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("backups.scriptTitle")}</div>
                <button onClick={() => setScriptOpen((open) => !open)} style={{ ...buttonStyle(false), padding: "2px 8px" }}>
                  {scriptOpen ? t("backups.scriptHide") : t("backups.scriptShow")}
                </button>
              </div>
              {data.scriptExists ? (
                scriptOpen && data.scriptSummary ? (
                  <pre style={{ margin: 0, padding: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)", maxHeight: 200, overflow: "auto" }}>
                    {data.scriptSummary}
                  </pre>
                ) : null
              ) : (
                <div style={{ fontSize: 12, color: "#d97706" }}>{t("backups.scriptMissing", { path: data.scriptPath })}</div>
              )}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 16px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden" }}>{data ? data.dir : ""}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("backups.footerNote")}</div>
        </div>

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
