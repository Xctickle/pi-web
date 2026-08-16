"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { BackupStatus } from "@/lib/backup-status";

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

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

export function BackupsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [data, setData] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/backups");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as BackupStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ageText = (hours: number): string => {
    if (hours < 1) return t("backups.agoMinutes", { minutes: Math.max(1, Math.round(hours * 60)) });
    if (hours < 48) return t("backups.agoHours", { hours: Math.round(hours) });
    return t("backups.agoDays", { days: Math.round(hours / 24) });
  };

  const rpoOverdue = data !== null && data.latestAgeHours !== null && data.latestAgeHours > data.rpoTargetHours;

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
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("backups.title")}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => void load()} disabled={loading} style={buttonStyle(loading)}>{t("i18n.refresh")}</button>
            <button onClick={onClose} style={buttonStyle(false)}>{t("i18n.close")}</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {error ? <div style={{ color: "#ef4444", fontSize: 13 }}>{t("backups.loadError")} — {error}</div> : null}

          {data && !data.dirExists ? (
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", color: "#d97706", fontSize: 13 }}>
              {t("backups.dirMissing", { dir: data.dir })}
            </div>
          ) : null}

          {data && data.dirExists ? (
            <div
              style={{
                border: `1px solid ${rpoOverdue ? "rgba(217,119,6,0.5)" : "rgba(34,197,94,0.4)"}`,
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 13,
                color: rpoOverdue ? "#d97706" : "#22c55e",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {data.latest ? (
                <>
                  <div>
                    <span style={{ color: "var(--text-dim)" }}>{t("backups.latestBackup")}: </span>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{data.latest.file}</span>
                  </div>
                  <div>
                    {data.latestAgeHours !== null
                      ? rpoOverdue
                        ? t("backups.rpoOverdue", { age: ageText(data.latestAgeHours), target: data.rpoTargetHours })
                        : t("backups.rpoOk", { age: ageText(data.latestAgeHours) })
                      : ""}
                  </div>
                </>
              ) : (
                t("backups.rpoNone")
              )}
            </div>
          ) : null}

          {data && data.archives.length ? (
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                {t("backups.archivesCount", { count: data.archives.length, size: formatBytes(data.totalSizeBytes) })}
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
                      background: index === 0 ? "var(--bg-hover)" : "transparent",
                    }}
                  >
                    {index === 0 ? (
                      <span style={{ fontSize: 10, padding: "0 6px", borderRadius: 999, border: "1px solid rgba(34,197,94,0.5)", color: "#22c55e" }}>{t("backups.latestChip")}</span>
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
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("backups.sidecarNote")}</div>
            </div>
          ) : null}

          {data ? (
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("backups.scriptTitle")}</div>
              {data.scriptExists ? (
                data.scriptSummary ? (
                  <pre style={{ margin: 0, padding: 8, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)", maxHeight: 200, overflow: "auto" }}>
                    {data.scriptSummary}
                  </pre>
                ) : null
              ) : (
                <div style={{ fontSize: 12, color: "#d97706" }}>{t("backups.scriptMissing", { path: data.scriptPath })}</div>
              )}
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("backups.remoteV2")}</div>
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 16px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden" }}>{data ? data.dir : ""}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("backups.readOnlyNote")}</div>
        </div>
      </div>
    </div>
  );
}
