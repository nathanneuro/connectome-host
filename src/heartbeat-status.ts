/**
 * The agent's sleep/wake state for the TUI status bar, read from heartbeat-mcpl's status
 * file. The path comes from the recipe: whichever MCP server sets HEARTBEAT_STATUS_FILE in
 * its env (heartbeat-mcpl writes the file; nothing else needs configuring).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';

interface McpServerEntry { env?: Record<string, string> }

/** The status file a recipe's heartbeat server writes, if any. */
export function heartbeatStatusPath(mcpServers: Record<string, McpServerEntry> | undefined): string | null {
  for (const server of Object.values(mcpServers ?? {})) {
    const path = server.env?.HEARTBEAT_STATUS_FILE;
    if (path) return path;
  }
  return null;
}

export interface HeartbeatStatus {
  paused: boolean;
  nextFireAt: string | null;
  sessionEndsAt?: string | null;
  timeZone?: string;
}

function clock(iso: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(iso));
}

/** "awake · 24m left", "asleep · wakes 19:00", "asleep · paused". */
export function formatHeartbeatSegment(status: HeartbeatStatus, now: number): string {
  if (status.sessionEndsAt && Date.parse(status.sessionEndsAt) > now) {
    const minutes = Math.ceil((Date.parse(status.sessionEndsAt) - now) / 60_000);
    return `awake · ${minutes}m left`;
  }
  if (status.paused) return 'asleep · paused';
  if (status.nextFireAt) return `asleep · wakes ${clock(status.nextFireAt, status.timeZone)}`;
  return 'asleep';
}

/** Reads the status file, re-reading only when it changed. */
export class HeartbeatStatusReader {
  private mtime = -1;
  private status: HeartbeatStatus | null = null;
  private error: string | null = null;

  constructor(private readonly path: string) {}

  /** The segment to show, or null when the heartbeat has not written its file yet. */
  segment(now = Date.now()): string | null {
    if (!existsSync(this.path)) return null;
    const mtime = statSync(this.path).mtimeMs;
    if (mtime !== this.mtime) {
      this.mtime = mtime;
      try {
        this.status = JSON.parse(readFileSync(this.path, 'utf8')) as HeartbeatStatus;
        this.error = null;
      } catch (e) {
        this.status = null;
        this.error = `heartbeat status unreadable: ${(e as Error).message}`;
      }
    }
    return this.error ?? (this.status ? formatHeartbeatSegment(this.status, now) : null);
  }
}
