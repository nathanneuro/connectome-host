import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingCache, withEmbeddingCache } from '../src/modules/embedding-cache.js';
import type { RetrievalModels } from '../src/modules/retrieval-models.js';

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'embedding-cache-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const vec = (...xs: number[]) => Float32Array.from(xs);

describe('EmbeddingCache', () => {
  test('vectors survive a reopen; unknown texts miss', withDir((dir) => {
    const path = join(dir, 'model.f32');
    const cache = new EmbeddingCache(path);
    cache.put('alpha', vec(1, 0, 0));
    cache.put('beta', vec(0, 0.6, 0.8));
    cache.close();

    const reopened = new EmbeddingCache(path);
    expect(reopened.size).toBe(2);
    expect(reopened.get('beta')).toEqual(vec(0, 0.6, 0.8));
    expect(reopened.get('gamma')).toBeUndefined();
    reopened.close();
  }));

  test('a partial trailing record from a crash is dropped on open', withDir((dir) => {
    const path = join(dir, 'model.f32');
    const cache = new EmbeddingCache(path);
    cache.put('alpha', vec(1, 0));
    cache.close();
    const intact = statSync(path).size;
    appendFileSync(path, Buffer.alloc(17));

    const reopened = new EmbeddingCache(path);
    expect(statSync(path).size).toBe(intact);
    expect(reopened.get('alpha')).toEqual(vec(1, 0));
    reopened.put('beta', vec(0, 1));
    reopened.close();
    expect(new EmbeddingCache(path).get('beta')).toEqual(vec(0, 1));
  }));

  test('a vector of another dimension is refused', withDir((dir) => {
    const cache = new EmbeddingCache(join(dir, 'model.f32'));
    cache.put('alpha', vec(1, 0));
    expect(() => cache.put('beta', vec(1, 0, 0))).toThrow('3-dim vector, file holds 2');
    cache.close();
  }));
});

describe('withEmbeddingCache', () => {
  test('embeds only documents the cache lacks, and never caches queries', withDir(async (dir) => {
    const embedded: Array<{ texts: string[]; kind: string }> = [];
    const models: RetrievalModels = {
      embeddingModel: 'fake',
      rerankerModel: 'fake',
      embed: async (texts, kind) => {
        embedded.push({ texts, kind });
        return texts.map(t => vec(t.length, 1));
      },
      rerank: async (_q, docs) => docs.map(() => 0),
      dispose: async () => {},
    };
    const path = join(dir, 'model.f32');
    const first = withEmbeddingCache(models, new EmbeddingCache(path));
    expect(await first.embed(['aa', 'bbb', 'aa'], 'document')).toEqual([vec(2, 1), vec(3, 1), vec(2, 1)]);
    await first.dispose();

    const second = withEmbeddingCache(models, new EmbeddingCache(path));
    expect(await second.embed(['bbb', 'cccc'], 'document')).toEqual([vec(3, 1), vec(4, 1)]);
    await second.embed(['q'], 'query');
    await second.embed(['q'], 'query');
    await second.dispose();

    expect(embedded).toEqual([
      { texts: ['aa', 'bbb'], kind: 'document' },
      { texts: ['cccc'], kind: 'document' },
      { texts: ['q'], kind: 'query' },
      { texts: ['q'], kind: 'query' },
    ]);
  }));
});
