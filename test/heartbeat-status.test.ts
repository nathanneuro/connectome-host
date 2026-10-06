import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatHeartbeatSegment, heartbeatStatusPath, HeartbeatStatusReader } from '../src/heartbeat-status.js';

const NOW = Date.parse('2026-10-06T22:10:00Z'); // 15:10 PDT
const LA = 'America/Los_Angeles';

describe('formatHeartbeatSegment', () => {
  test('awake while a session is open, with the minutes left', () => {
    expect(formatHeartbeatSegment(
      { paused: false, nextFireAt: '2026-10-07T02:00:00Z', sessionEndsAt: '2026-10-06T22:30:00Z', timeZone: LA }, NOW,
    )).toBe('awake · 20m left');
  });

  test('asleep with the next wake on the agent clock', () => {
    expect(formatHeartbeatSegment(
      { paused: false, nextFireAt: '2026-10-07T02:00:00Z', sessionEndsAt: null, timeZone: LA }, NOW,
    )).toBe('asleep · wakes 19:00');
    expect(formatHeartbeatSegment(
      { paused: false, nextFireAt: '2026-10-07T02:00:00Z', sessionEndsAt: '2026-10-06T22:00:00Z', timeZone: LA }, NOW,
    )).toBe('asleep · wakes 19:00');
  });

  test('paused, and no schedule at all', () => {
    expect(formatHeartbeatSegment({ paused: true, nextFireAt: null }, NOW)).toBe('asleep · paused');
    expect(formatHeartbeatSegment({ paused: false, nextFireAt: null }, NOW)).toBe('asleep');
  });
});

describe('heartbeatStatusPath', () => {
  test('finds the status file in whichever server sets it', () => {
    expect(heartbeatStatusPath({ site: { env: {} }, heartbeat: { env: { HEARTBEAT_STATUS_FILE: '/x/status.json' } } }))
      .toBe('/x/status.json');
    expect(heartbeatStatusPath({ site: {} })).toBeNull();
    expect(heartbeatStatusPath(undefined)).toBeNull();
  });
});

describe('HeartbeatStatusReader', () => {
  test('no segment before the file exists; surfaces an unreadable file instead of hiding it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-status-'));
    try {
      const path = join(dir, 'status.json');
      const reader = new HeartbeatStatusReader(path);
      expect(reader.segment(NOW)).toBeNull();
      writeFileSync(path, JSON.stringify({ paused: false, nextFireAt: '2026-10-07T02:00:00Z', timeZone: LA }));
      expect(reader.segment(NOW)).toBe('asleep · wakes 19:00');
      writeFileSync(path, '{ not json');
      expect(reader.segment(NOW)).toMatch(/^heartbeat status unreadable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
