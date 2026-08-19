import { promises as fs } from "fs";
import os from "os";
import path from "path";

/**
 * Remote replica status via the local syncthing REST API (server only).
 *
 * Reads the GUI apikey + address from ~/.local/state/syncthing/config.xml,
 * resolves the folder backing ~/kb by its path, and asks each *remote* device
 * (folder members minus this machine) for its sync completion. The apikey is
 * used only for these server-side requests and never appears in any response,
 * error message or log line produced here. Any failure — config missing,
 * no apikey, folder not found, REST unreachable — degrades to `null`, which
 * the panel renders as a neutral "syncthing unreachable" note.
 */

export interface RemoteReplicaDevice {
  id: string;
  name: string;
  /** Sync completion percentage for the kb folder; null when syncthing could not answer. */
  completion: number | null;
}

export interface RemoteReplicas {
  folderId: string;
  devices: RemoteReplicaDevice[];
}

export const SYNCTHING_CONFIG = path.join(os.homedir(), ".local", "state", "syncthing", "config.xml");

const KB_FOLDER_PATH = path.join(os.homedir(), "kb");
const DEFAULT_GUI_ADDRESS = "127.0.0.1:8384";
const REST_TIMEOUT_MS = 2500;

/** First `<tag ...>` opening tag match in the config text. */
function firstOpenTag(config: string, tag: string): string | null {
  return new RegExp(`<${tag}\\b[^>]*>`).exec(config)?.[0] ?? null;
}

/** Attribute value of an opening tag, tolerating attribute order changes. */
function tagAttribute(openTag: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(openTag)?.[1] ?? null;
}

/** Resolve a syncthing folder path (`~`-relative or absolute) for comparison. */
function expandFolderPath(folderPath: string): string {
  if (folderPath === "~") return os.homedir();
  if (folderPath.startsWith("~/")) return path.join(os.homedir(), folderPath.slice(2));
  return path.resolve(folderPath);
}

/** Find the syncthing folder id whose path is `targetDir` (null when absent). */
function findFolderId(config: string, targetDir: string): string | null {
  const target = expandFolderPath(targetDir);
  for (const match of config.matchAll(/<folder\b[^>]*>/g)) {
    const openTag = match[0];
    const id = tagAttribute(openTag, "id");
    const folderPath = tagAttribute(openTag, "path");
    if (id && folderPath && expandFolderPath(folderPath) === target) return id;
  }
  return null;
}

/** Device ids referenced as members of the given folder element. */
function folderDeviceIds(config: string, folderId: string): string[] {
  const folderRegex = new RegExp(`<folder\\b[^>]*\\bid="${folderId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</folder>`);
  const block = folderRegex.exec(config)?.[1];
  if (!block) return [];
  const ids: string[] = [];
  for (const match of block.matchAll(/<device\b[^>]*>/g)) {
    const id = tagAttribute(match[0], "id");
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Base URL of the syncthing REST API from the <gui> address (+tls flag). */
function guiBaseUrl(guiBlock: string, guiOpenTag: string): string {
  const raw = /<address>([^<]+)<\/address>/.exec(guiBlock)?.[1]?.trim() ?? DEFAULT_GUI_ADDRESS;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw.replace(/\/+$/, "");
  const scheme = tagAttribute(guiOpenTag, "tls") === "true" ? "https" : "http";
  const host = raw.startsWith(":") ? `127.0.0.1${raw}` : raw;
  return `${scheme}://${host}`;
}

async function restJson<T>(url: string, apiKey: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "X-API-Key": apiKey },
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Completion percentage for one device on one folder; null when unavailable. */
async function deviceCompletion(base: string, apiKey: string, folderId: string, deviceId: string): Promise<number | null> {
  try {
    const json = await restJson<{ completion?: number }>(
      `${base}/rest/db/completion?folder=${encodeURIComponent(folderId)}&device=${encodeURIComponent(deviceId)}`,
      apiKey,
    );
    return typeof json.completion === "number" ? json.completion : null;
  } catch {
    return null;
  }
}

/**
 * Collect remote replica completion for the ~/kb syncthing folder.
 * Returns null whenever syncthing (or its config) is unavailable — remote
 * replica status is best-effort and never fails the backups panel.
 */
export async function collectRemoteReplicas(): Promise<RemoteReplicas | null> {
  let config: string;
  try {
    config = await fs.readFile(SYNCTHING_CONFIG, "utf8");
  } catch {
    return null;
  }

  const guiOpenTag = firstOpenTag(config, "gui");
  const guiBlock = /<gui\b[^>]*>([\s\S]*?)<\/gui>/.exec(config)?.[1] ?? null;
  if (!guiOpenTag || guiBlock === null) return null;
  const apiKey = /<apikey>([^<]+)<\/apikey>/.exec(guiBlock)?.[1]?.trim();
  if (!apiKey) return null;

  const folderId = findFolderId(config, KB_FOLDER_PATH);
  if (!folderId) return null;

  const base = guiBaseUrl(guiBlock, guiOpenTag);
  try {
    const status = await restJson<{ myID?: string }>(`${base}/rest/system/status`, apiKey);
    const devices = await restJson<Array<{ deviceID?: string; name?: string }>>(`${base}/rest/config/devices`, apiKey);
    const nameById = new Map<string, string>();
    for (const device of devices) {
      if (device.deviceID) nameById.set(device.deviceID, device.name?.trim() || device.deviceID.slice(0, 7));
    }

    const replicas: RemoteReplicaDevice[] = [];
    for (const deviceId of folderDeviceIds(config, folderId)) {
      if (deviceId === status.myID) continue; // skip this machine itself
      replicas.push({
        id: deviceId,
        name: nameById.get(deviceId) ?? deviceId.slice(0, 7),
        completion: await deviceCompletion(base, apiKey, folderId, deviceId),
      });
    }
    return { folderId, devices: replicas };
  } catch {
    return null;
  }
}
