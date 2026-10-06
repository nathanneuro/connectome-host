import { describe, expect, test } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  INITIAL_STABILITY_DAYS,
  LessonsModule,
  rankScore,
  retrievability,
  type Lesson,
} from '../src/modules/lessons-module.js';
import { LexicalIndex, lexicalSimilarity } from '../src/modules/lesson-search.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAY = 86_400_000;

/** In-memory stand-in for a module's chronicle state: one snapshot plus append-only logs. */
class FakeStore {
  state: unknown = null;
  logs = new Map<string, unknown[]>();

  context(): ModuleContext {
    return {
      getState: () => this.state,
      setState: (s: unknown) => { this.state = s; },
      registerLogState: (name: string) => { if (!this.logs.has(name)) this.logs.set(name, []); },
      appendToLog: (name: string, item: unknown) => { this.logs.get(name)!.push(structuredClone(item)); },
      getLog: (name: string) => structuredClone(this.logs.get(name) ?? []),
      getLogLength: (name: string) => this.logs.get(name)?.length ?? 0,
    } as unknown as ModuleContext;
  }
}

async function started(store = new FakeStore(), globalPath?: string): Promise<LessonsModule> {
  const mod = new LessonsModule(globalPath ? { globalPath } : undefined);
  await mod.start(store.context());
  return mod;
}

async function create(mod: LessonsModule, input: Record<string, unknown>) {
  return mod.handleToolCall({ id: 'c', name: 'create', input } as never);
}

function lesson(overrides: Partial<Lesson>): Lesson {
  return {
    id: 'x',
    content: 'content',
    confidence: 0.8,
    tags: [],
    evidence: [],
    created: 0,
    updated: 0,
    deprecated: false,
    ...overrides,
  };
}

describe('lexicalSimilarity', () => {
  test('ignores case, punctuation, and stopwords', () => {
    expect(lexicalSimilarity('The auth service uses JWT.', 'auth SERVICE uses jwt')).toBe(1);
  });

  test('is zero for texts with no shared content words', () => {
    expect(lexicalSimilarity('deploys run on Fridays', 'Alice owns the billing pipeline')).toBe(0);
  });
});

describe('LessonsModule near-duplicate gate', () => {
  test('refuses a restatement of a live lesson and names the match', async () => {
    const mod = await started();
    const first = await create(mod, { content: 'Alice owns the billing pipeline deploys', tags: ['people'] });
    const id = (first.data as { id: string }).id;

    const dup = await create(mod, { content: 'Alice owns billing pipeline deploys now', tags: ['people'] });

    expect(dup.success).toBe(false);
    expect(dup.error).toContain(`[${id}]`);
    expect(mod.getLessons()).toHaveLength(1);
  });

  test('creates distinct lessons without complaint', async () => {
    const mod = await started();
    await create(mod, { content: 'Alice owns the billing pipeline', tags: [] });
    const other = await create(mod, { content: 'Deploys are frozen on Fridays', tags: [] });

    expect(other.success).toBe(true);
    expect(mod.getLessons()).toHaveLength(2);
  });

  test('force creates despite a near-duplicate', async () => {
    const mod = await started();
    await create(mod, { content: 'Alice owns the billing pipeline', tags: [] });
    const forced = await create(mod, { content: 'Alice owns the billing pipeline', tags: [], force: true });

    expect(forced.success).toBe(true);
    expect(mod.getLessons()).toHaveLength(2);
  });

  test('deprecated lessons do not block creation', async () => {
    const mod = await started();
    const first = await create(mod, { content: 'Alice owns the billing pipeline', tags: [] });
    await mod.handleToolCall({
      id: 'd', name: 'deprecate', input: { id: (first.data as { id: string }).id, reason: 'wrong' },
    } as never);

    expect((await create(mod, { content: 'Alice owns the billing pipeline', tags: [] })).success).toBe(true);
  });

  test('supersedes deprecates and links the replaced lesson', async () => {
    const mod = await started();
    const first = await create(mod, { content: 'Alice owns the billing pipeline', tags: [] });
    const oldId = (first.data as { id: string }).id;

    const next = await create(mod, {
      content: 'Bob owns the billing pipeline since March', tags: [], supersedes: [oldId],
    });
    const newId = (next.data as { id: string }).id;

    expect(next.success).toBe(true);
    const old = mod.getLessons().find(l => l.id === oldId)!;
    expect(old.deprecated).toBe(true);
    expect(old.supersededBy).toBe(newId);
    expect(old.deprecationReason).toBe(`Superseded by ${newId}`);
  });

  test('supersedes rejects unknown IDs without creating anything', async () => {
    const mod = await started();
    const result = await create(mod, { content: 'anything at all', tags: [], supersedes: ['nope'] });

    expect(result.success).toBe(false);
    expect(mod.getLessons()).toHaveLength(0);
  });
});

describe('usage strength', () => {
  test('retrievability is 0.9 after one stability period and decays from creation when never retrieved', () => {
    const l = lesson({ created: 0 });
    expect(retrievability(l, 0)).toBe(1);
    expect(retrievability(l, INITIAL_STABILITY_DAYS * DAY)).toBeCloseTo(0.9, 10);
  });

  test('disuse can at most halve the rank; confidence stays dominant', () => {
    const ancient = lesson({ confidence: 0.9, created: 0 });
    const fresh = lesson({ confidence: 0.4, created: 10_000 * DAY });
    const now = 10_000 * DAY;

    expect(rankScore(ancient, now)).toBeGreaterThan(0.45);
    expect(rankScore(ancient, now)).toBeGreaterThan(rankScore(fresh, now));
  });

  test('spaced retrievals strengthen far more than massed ones', async () => {
    const massed = await started();
    const spaced = await started();
    await create(massed, { content: 'massed lesson', tags: [] });
    await create(spaced, { content: 'spaced lesson', tags: [] });
    const m = massed.getLessons()[0];
    const s = spaced.getLessons()[0];
    const t0 = m.created;
    s.created = t0;

    for (let i = 1; i <= 5; i++) massed.recordRetrieval([m.id], t0 + i * 60_000);
    for (let i = 1; i <= 5; i++) spaced.recordRetrieval([s.id], t0 + i * 30 * DAY);

    expect(m.retrievalCount).toBe(5);
    expect(s.retrievalCount).toBe(5);
    expect(m.stability!).toBeLessThan(INITIAL_STABILITY_DAYS * 1.1);
    expect(s.stability!).toBeGreaterThan(m.stability! * 10);
  });

  test('recordRetrieval leaves `updated` alone and fails loudly on unknown IDs', async () => {
    const mod = await started();
    await create(mod, { content: 'some lesson', tags: [] });
    const l = mod.getLessons()[0];
    const updated = l.updated;

    mod.recordRetrieval([l.id], updated + DAY);

    expect(l.updated).toBe(updated);
    expect(() => mod.recordRetrieval(['missing'])).toThrow('lesson not found: missing');
  });
});

describe('nothing is lost', () => {
  test('update keeps prior wording in revision history', async () => {
    const mod = await started();
    await create(mod, { content: 'Alice owns billing', tags: [] });
    const l = mod.getLessons()[0];

    await mod.handleToolCall({ id: 'u', name: 'update', input: { id: l.id, content: 'Bob owns billing' } } as never);
    await mod.handleToolCall({ id: 'u', name: 'update', input: { id: l.id, confidence: 0.9 } } as never);

    expect(l.content).toBe('Bob owns billing');
    expect(l.previousContents!.map(p => p.content)).toEqual(['Alice owns billing']);
  });

  test('query searches superseded lessons only when asked', async () => {
    const mod = await started();
    const first = await create(mod, { content: 'Alice owns the billing pipeline', tags: [] });
    const oldId = (first.data as { id: string }).id;
    await create(mod, { content: 'Bob runs payments now', tags: [], supersedes: [oldId] });

    const live = await mod.handleToolCall({ id: 'q', name: 'query', input: { text: 'alice' } } as never);
    const archive = await mod.handleToolCall({
      id: 'q', name: 'query', input: { text: 'alice', includeDeprecated: true },
    } as never);

    expect(live.data).toMatchObject({ total: 0, shown: 0, searched: 1 });
    expect((archive.data as { lessons: Array<{ id: string; supersededBy?: string }> }).lessons)
      .toMatchObject([{ id: oldId, supersededBy: expect.any(String) }]);
  });
});

describe('query and list report what they searched', () => {
  test('shown of total among searched, so no match reads differently from no data', async () => {
    const mod = await started();
    for (const content of ['Deploys freeze on Fridays', 'Deploy keys rotate monthly', 'Billing runs nightly']) {
      await create(mod, { content, tags: ['ops'] });
    }

    const query = await mod.handleToolCall({ id: 'q', name: 'query', input: { text: 'deploy', limit: 1 } } as never);
    expect(query.data).toMatchObject({ total: 2, shown: 1, searched: 3 });
    const none = await mod.handleToolCall({ id: 'q', name: 'query', input: { text: 'kubernetes' } } as never);
    expect(none.data).toMatchObject({ total: 0, shown: 0, searched: 3 });
    const list = await mod.handleToolCall({ id: 'l', name: 'list', input: { limit: 2 } } as never);
    expect(list.data).toMatchObject({ total: 3, shown: 2, searched: 3 });
  });

  test('a tag no lesson carries is reported with the tags that exist', async () => {
    const mod = await started();
    await create(mod, { content: 'Deploys freeze on Fridays', tags: ['ops', 'Process'] });
    await create(mod, { content: 'Alice owns billing', tags: ['people', 'ops'] });

    const query = await mod.handleToolCall({ id: 'q', name: 'query', input: { tags: ['opps', 'process'] } } as never);
    expect(query.data).toMatchObject({ total: 1, unknownTags: ['opps'], knownTags: ['ops', 'people', 'process'] });
    const known = await mod.handleToolCall({ id: 'l', name: 'list', input: { tags: ['OPS'] } } as never);
    expect(known.data).not.toHaveProperty('unknownTags');
    expect(known.data).toMatchObject({ total: 2 });
  });
});

describe('LexicalIndex', () => {
  const docs = [
    lesson({ id: 'a', content: 'OAuth tokens expire after one hour' }),
    lesson({ id: 'b', content: 'Deploys are frozen on Fridays' }),
    lesson({ id: 'c', content: 'tokens tokens everywhere, and the OAuth docs are thin', tags: ['docs'] }),
  ];
  const index = new LexicalIndex();
  index.sync(docs);

  test('matches whole words only; lessons sharing no term are absent', () => {
    const scores = index.scores('expire');
    expect(scores.get('a')).toBeGreaterThan(0);
    expect(scores.has('b')).toBe(false);
    expect(index.scores('pire').size).toBe(0);
  });

  test('rare terms outweigh common ones', () => {
    const scores = index.scores('oauth expire');
    expect(scores.get('a')!).toBeGreaterThan(scores.get('c')!);
  });

  test('stopword-only queries match nothing', () => {
    expect(index.scores('the and of').size).toBe(0);
  });

  test('tags are searchable', () => {
    expect(index.scores('docs').get('c')).toBeGreaterThan(0);
  });

  test('an incrementally synced index scores exactly like a fresh one', () => {
    const live = new LexicalIndex();
    live.sync(docs);
    const edited = [
      lesson({ id: 'a', content: 'OAuth tokens now expire after ten minutes' }),
      docs[2]!,
      lesson({ id: 'd', content: 'Fridays are for retros, not deploys' }),
    ];
    live.sync(edited);
    const fresh = new LexicalIndex();
    fresh.sync(edited);
    for (const query of ['oauth expire', 'deploys fridays', 'tokens docs', 'frozen']) {
      expect([...live.scores(query)].sort()).toEqual([...fresh.scores(query)].sort());
    }
    expect(live.scores('frozen').size).toBe(0);
  });
});


describe('append-only storage', () => {
  test('a restart replays the logs into exactly the lessons and usage it left', async () => {
    const store = new FakeStore();
    const mod = await started(store);
    const a = (await create(mod, { content: 'OAuth tokens expire after one hour', tags: ['auth'] })).data as { id: string };
    const b = (await create(mod, { content: 'Deploys freeze on Fridays', tags: ['ops'] })).data as { id: string };
    await mod.handleToolCall({ id: 'u', name: 'update', input: { id: a.id, content: 'OAuth tokens expire after ten minutes' } } as never);
    await mod.handleToolCall({ id: 'b', name: 'boost', input: { id: a.id } } as never);
    await mod.handleToolCall({ id: 'd', name: 'deprecate', input: { id: b.id, reason: 'policy ended' } } as never);
    const t0 = mod.getLessons()[0]!.created;
    mod.recordRetrieval([a.id], t0 + DAY);
    mod.recordRetrieval([a.id], t0 + 30 * DAY);

    const restarted = await started(store);
    expect(restarted.getLessons()).toEqual(mod.getLessons());
    expect(restarted.getLessons()[0]).toMatchObject({ retrievalCount: 2, lastRetrieved: t0 + 30 * DAY });
    expect(store.state).toBeNull();
  });

  test('a retrieval appends one event naming its lessons, whatever the library size', async () => {
    const store = new FakeStore();
    const mod = await started(store);
    for (let i = 0; i < 50; i++) await create(mod, { content: `distinct lesson number ${i} about topic${i}`, tags: [], force: true });
    const versions = store.logs.get('versions')!.length;

    mod.recordRetrieval([mod.getLessons()[7]!.id, mod.getLessons()[9]!.id], 1_000);

    expect(store.logs.get('versions')!.length).toBe(versions);
    expect(store.logs.get('retrievals')).toEqual([{ at: 1_000, ids: [mod.getLessons()[7]!.id, mod.getLessons()[9]!.id] }]);
  });

  test('a pre-log snapshot migrates once, keeps its usage, and is left untouched', async () => {
    const store = new FakeStore();
    const old = [
      lesson({ id: 'a', content: 'used', created: 1, updated: 1, retrievalCount: 3, lastRetrieved: 50, stability: 12 }),
      lesson({ id: 'b', content: 'never used', created: 2, updated: 2, previousContents: [{ content: 'older', replacedAt: 2 }] }),
    ];
    store.state = { lessons: structuredClone(old), externalIdMap: {} };

    const mod = await started(store);
    expect(mod.getLessons()).toEqual(old);
    expect(store.state).toEqual({ lessons: old, externalIdMap: {} });
    expect(store.logs.get('versions')).toHaveLength(2);
    expect(store.logs.get('retrievals')).toHaveLength(1);

    await started(store);
    expect(store.logs.get('versions')).toHaveLength(2);
  });

  test('the global file holds content only, is not rewritten by retrievals, and never imports usage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lessons-global-'));
    try {
      const globalPath = join(dir, 'lessons.json');
      const mod = await started(new FakeStore(), globalPath);
      const { id } = (await create(mod, { content: 'Deploys freeze on Fridays', tags: [] })).data as { id: string };
      const written = readFileSync(globalPath, 'utf-8');
      mod.recordRetrieval([id], Date.now());
      expect(readFileSync(globalPath, 'utf-8')).toBe(written);
      expect(written).not.toContain('retrievalCount');

      writeFileSync(globalPath, JSON.stringify({
        lessons: [lesson({ id: 'shared', content: 'from another agent', updated: 5, retrievalCount: 99, lastRetrieved: 5 })],
      }));
      const store = new FakeStore();
      const other = await started(store, globalPath);
      expect(other.getLessons()).toEqual([lesson({ id: 'shared', content: 'from another agent', updated: 5 })]);
      rmSync(globalPath);
      expect((await started(store)).getLessons().map(l => l.id)).toEqual(['shared']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
