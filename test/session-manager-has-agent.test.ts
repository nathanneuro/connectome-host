/**
 * hasAgent() backs REQUIRE_EXISTING_AGENT: a data dir holds an agent once it
 * has a session index, or a legacy store that migrateIfNeeded() will adopt.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/session-manager.js';

describe('SessionManager.hasAgent', () => {
  test('a missing or empty data dir holds no agent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'has-agent-'));
    try {
      expect(new SessionManager(join(tmp, 'missing')).hasAgent()).toBe(false);
      expect(new SessionManager(tmp).hasAgent()).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a created session, or a legacy store, is an agent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'has-agent-'));
    try {
      const fresh = join(tmp, 'fresh');
      new SessionManager(fresh).createSession();
      expect(new SessionManager(fresh).hasAgent()).toBe(true);

      const legacy = join(tmp, 'legacy');
      mkdirSync(join(legacy, 'store'), { recursive: true });
      expect(new SessionManager(legacy).hasAgent()).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
