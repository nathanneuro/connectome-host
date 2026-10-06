/**
 * Document embeddings on disk, so a restart does not re-embed the whole
 * lesson library before its first retrieval.
 *
 * One append-only file per embedding model: a 4-byte dimension header, then
 * fixed-width records of sha256(text) followed by the unit vector. Fixed
 * width makes position identity: open reads the hashes, a lookup is one
 * positioned read, a store is one append. A crash can leave a partial
 * trailing record; it was never acknowledged and is dropped on open. The
 * file belongs to one agent's data dir, so one process writes it.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RetrievalModels } from './retrieval-models.js';

const HEADER_BYTES = 4;
const HASH_BYTES = 32;

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

export class EmbeddingCache {
  private readonly fd: number;
  private dims: number | null = null;
  /** Hex hash → record index. */
  private readonly index = new Map<string, number>();

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'a+');
    const size = fstatSync(this.fd).size;
    if (size === 0) return;
    const header = Buffer.alloc(HEADER_BYTES);
    readSync(this.fd, header, 0, HEADER_BYTES, 0);
    this.dims = header.readUInt32LE(0);
    const count = Math.floor((size - HEADER_BYTES) / this.recordBytes());
    if (HEADER_BYTES + count * this.recordBytes() !== size) {
      ftruncateSync(this.fd, HEADER_BYTES + count * this.recordBytes());
    }
    const hash = Buffer.alloc(HASH_BYTES);
    for (let i = 0; i < count; i++) {
      readSync(this.fd, hash, 0, HASH_BYTES, this.offset(i));
      this.index.set(hash.toString('hex'), i);
    }
  }

  get size(): number {
    return this.index.size;
  }

  get(text: string): Float32Array | undefined {
    const hash = sha256(text);
    const i = this.index.get(hash.toString('hex'));
    if (i === undefined) return undefined;
    const record = Buffer.alloc(this.recordBytes());
    readSync(this.fd, record, 0, record.length, this.offset(i));
    if (!record.subarray(0, HASH_BYTES).equals(hash)) {
      throw new Error(`embedding cache ${this.path}: record ${i} does not hold the hash it was indexed under`);
    }
    const vector = new Float32Array(this.dims!);
    record.copy(new Uint8Array(vector.buffer), 0, HASH_BYTES);
    return vector;
  }

  put(text: string, vector: Float32Array): void {
    const key = sha256(text);
    if (this.index.has(key.toString('hex'))) return;
    if (this.dims === null) {
      this.dims = vector.length;
      const header = Buffer.alloc(HEADER_BYTES);
      header.writeUInt32LE(this.dims, 0);
      writeSync(this.fd, header);
    }
    if (vector.length !== this.dims) {
      throw new Error(`embedding cache ${this.path}: ${vector.length}-dim vector, file holds ${this.dims}`);
    }
    writeSync(this.fd, Buffer.concat([key, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)]));
    this.index.set(key.toString('hex'), this.index.size);
  }

  close(): void {
    closeSync(this.fd);
  }

  private recordBytes(): number {
    return HASH_BYTES + 4 * this.dims!;
  }

  private offset(i: number): number {
    return HEADER_BYTES + i * this.recordBytes();
  }
}

/** `models`, with document embeddings served from and saved to `cache`. Queries are never cached. */
export function withEmbeddingCache(models: RetrievalModels, cache: EmbeddingCache): RetrievalModels {
  return {
    embeddingModel: models.embeddingModel,
    rerankerModel: models.rerankerModel,
    async embed(texts, kind) {
      if (kind === 'query') return models.embed(texts, kind);
      const vectors = texts.map(t => cache.get(t));
      const missing = [...new Set(texts.filter((_, i) => vectors[i] === undefined))];
      const fresh = await models.embed(missing, 'document');
      missing.forEach((t, i) => cache.put(t, fresh[i]));
      return texts.map((t, i) => vectors[i] ?? cache.get(t)!);
    },
    rerank: (query, documents) => models.rerank(query, documents),
    async dispose() {
      cache.close();
      await models.dispose();
    },
  };
}
