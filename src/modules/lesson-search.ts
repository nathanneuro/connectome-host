/**
 * Lexical search over lessons: one tokenizer shared by the near-duplicate
 * gate and retrieval's shortlist, plus an incremental Okapi BM25 index.
 *
 * Lexical search is only the shortlist for libraries too large to show the
 * relevance model whole; the semantic judgment is always the model's.
 */

import type { Lesson } from './lessons-module.js';

const STOPWORDS = new Set([
  'an', 'as', 'at', 'be', 'by', 'do', 'he', 'if', 'in', 'is', 'it', 'me', 'my',
  'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new',
  'now', 'see', 'two', 'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too',
  'use', 'that', 'with', 'have', 'this', 'will', 'your', 'from', 'they', 'been',
  'were', 'when', 'what', 'which', 'their', 'there', 'than', 'then', 'them',
  'these', 'those', 'into', 'also', 'should', 'would', 'could', 'about',
]);

/** Lowercased content words (letters/digits, length >= 2, no stopwords), in order, with repeats. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2 && !STOPWORDS.has(w));
}

export function lexicalSimilarity(a: string, b: string): number {
  const wa = new Set(tokenize(a));
  const wb = new Set(tokenize(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

function lessonTokens(lesson: Lesson): string[] {
  return tokenize(`${lesson.content} ${lesson.tags.join(' ')}`);
}

const K1 = 1.2;
const B = 0.75;

interface IndexedDoc {
  key: string;
  termFreq: Map<string, number>;
  length: number;
}

/**
 * Okapi BM25 over an inverted index kept in step with the library. `sync`
 * re-tokenizes only lessons whose text changed, and a query reads only the
 * postings of its own terms, so per-query cost follows the matches rather
 * than the size of the library.
 */
export class LexicalIndex {
  private readonly docs = new Map<string, IndexedDoc>();
  private readonly postings = new Map<string, Set<string>>();
  private totalLength = 0;

  /** Make the index hold exactly `lessons`. */
  sync(lessons: Lesson[]): void {
    const live = new Set<string>();
    for (const lesson of lessons) {
      live.add(lesson.id);
      const key = `${lesson.content}\u0000${lesson.tags.join('\u0000')}`;
      const doc = this.docs.get(lesson.id);
      if (doc?.key === key) continue;
      if (doc) this.remove(lesson.id);
      this.add(lesson.id, key, lessonTokens(lesson));
    }
    for (const id of [...this.docs.keys()]) if (!live.has(id)) this.remove(id);
  }

  /** BM25 score of every lesson sharing a term with the query; absent = zero. */
  scores(query: string): Map<string, number> {
    const scores = new Map<string, number>();
    const n = this.docs.size;
    if (n === 0) return scores;
    const avgLength = Math.max(this.totalLength / n, 1);
    for (const term of new Set(tokenize(query))) {
      const ids = this.postings.get(term);
      if (!ids) continue;
      const idf = Math.log(1 + (n - ids.size + 0.5) / (ids.size + 0.5));
      for (const id of ids) {
        const doc = this.docs.get(id)!;
        const tf = doc.termFreq.get(term)!;
        const score = idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * doc.length / avgLength));
        scores.set(id, (scores.get(id) ?? 0) + score);
      }
    }
    return scores;
  }

  private add(id: string, key: string, tokens: string[]): void {
    const termFreq = new Map<string, number>();
    for (const term of tokens) termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
    for (const term of termFreq.keys()) {
      let ids = this.postings.get(term);
      if (!ids) this.postings.set(term, ids = new Set());
      ids.add(id);
    }
    this.docs.set(id, { key, termFreq, length: tokens.length });
    this.totalLength += tokens.length;
  }

  private remove(id: string): void {
    const doc = this.docs.get(id)!;
    for (const term of doc.termFreq.keys()) {
      const ids = this.postings.get(term)!;
      ids.delete(id);
      if (ids.size === 0) this.postings.delete(term);
    }
    this.docs.delete(id);
    this.totalLength -= doc.length;
  }
}
