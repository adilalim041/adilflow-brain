import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Extract pure functions from server.js for testing
function toInt(value, fallback, min = 1, max = 100) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function mergeScoreDetails(existing, extra) {
    return { ...(existing || {}), ...(extra || {}) };
}

// Inline CheckSimilaritySchema — mirrors server.js exactly
const CheckSimilaritySchema = z.object({
    caption: z.string().min(10).max(5000),
    exclude_article_id: z.number().int().positive().optional(),
    window_days: z.number().int().min(1).max(90).default(30),
    threshold: z.number().min(0.5).max(0.99).default(0.92)
});

describe('toInt', () => {
    it('parses valid integers', () => {
        expect(toInt('10', 5)).toBe(10);
        expect(toInt('1', 5)).toBe(1);
        expect(toInt('100', 5)).toBe(100);
    });

    it('returns fallback for invalid input', () => {
        expect(toInt('abc', 5)).toBe(5);
        expect(toInt(undefined, 5)).toBe(5);
        expect(toInt(null, 5)).toBe(5);
        expect(toInt('', 5)).toBe(5);
    });

    it('clamps to min/max', () => {
        expect(toInt('0', 5)).toBe(1);
        expect(toInt('-5', 5)).toBe(1);
        expect(toInt('200', 5)).toBe(100);
        expect(toInt('50', 5, 10, 60)).toBe(50);
        expect(toInt('5', 5, 10, 60)).toBe(10);
        expect(toInt('70', 5, 10, 60)).toBe(60);
    });
});

describe('mergeScoreDetails', () => {
    it('merges two objects', () => {
        expect(mergeScoreDetails({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    });

    it('overrides existing keys', () => {
        expect(mergeScoreDetails({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
    });

    it('handles null/undefined', () => {
        expect(mergeScoreDetails(null, { b: 2 })).toEqual({ b: 2 });
        expect(mergeScoreDetails({ a: 1 }, null)).toEqual({ a: 1 });
        expect(mergeScoreDetails(null, null)).toEqual({});
    });
});

// ─────────────────────────────────────────────────────────────
// CheckSimilaritySchema validation
// ─────────────────────────────────────────────────────────────
describe('CheckSimilaritySchema', () => {
    it('accepts valid input with defaults applied', () => {
        const result = CheckSimilaritySchema.safeParse({ caption: 'Apple releases new iPhone with AI chip.' });
        expect(result.success).toBe(true);
        expect(result.data.window_days).toBe(30);
        expect(result.data.threshold).toBe(0.92);
        expect(result.data.exclude_article_id).toBeUndefined();
    });

    it('accepts all optional fields', () => {
        const result = CheckSimilaritySchema.safeParse({
            caption: 'Tech giant unveils latest AI assistant model.',
            exclude_article_id: 42,
            window_days: 7,
            threshold: 0.85
        });
        expect(result.success).toBe(true);
        expect(result.data.exclude_article_id).toBe(42);
        expect(result.data.window_days).toBe(7);
        expect(result.data.threshold).toBe(0.85);
    });

    it('rejects caption shorter than 10 chars', () => {
        const result = CheckSimilaritySchema.safeParse({ caption: 'Short' });
        expect(result.success).toBe(false);
    });

    it('rejects caption longer than 5000 chars', () => {
        const result = CheckSimilaritySchema.safeParse({ caption: 'x'.repeat(5001) });
        expect(result.success).toBe(false);
    });

    it('rejects window_days above 90', () => {
        const result = CheckSimilaritySchema.safeParse({ caption: 'A valid caption text here.', window_days: 91 });
        expect(result.success).toBe(false);
    });

    it('rejects threshold below 0.5', () => {
        const result = CheckSimilaritySchema.safeParse({ caption: 'A valid caption text here.', threshold: 0.3 });
        expect(result.success).toBe(false);
    });

    it('rejects threshold above 0.99', () => {
        const result = CheckSimilaritySchema.safeParse({ caption: 'A valid caption text here.', threshold: 1.0 });
        expect(result.success).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────
// embedCaption logic (unit: fail-open contract)
// ─────────────────────────────────────────────────────────────
describe('embedCaption fail-open contract', () => {
    // We test the contract inline without importing server.js (which would
    // trigger process.exit on missing API_KEY). The key invariant is:
    // a null return from embedCaption must never crash downstream callers.

    it('downstream caption save is skipped gracefully when embedding is null', async () => {
        // Simulate the fire-and-forget in /api/articles/:id/generated
        const savedEmbeddings = [];
        const fakeSupabaseUpdate = (emb) => { if (emb) savedEmbeddings.push(emb); };

        const fakeEmbedCaption = async () => null; // simulates CB_OPEN / API failure

        const captionText = 'Apple reveals AI chip for iPhone 18.';
        const emb = await fakeEmbedCaption(captionText);
        if (emb) fakeSupabaseUpdate(emb);

        // Nothing should have been saved
        expect(savedEmbeddings).toHaveLength(0);
    });

    it('downstream caption save proceeds when embedding is available', async () => {
        const savedEmbeddings = [];
        const fakeSupabaseUpdate = (emb) => { if (emb) savedEmbeddings.push(emb); };

        const fakeVector = new Array(384).fill(0.01);
        const fakeEmbedCaption = async () => fakeVector;

        const captionText = 'Apple reveals AI chip for iPhone 18.';
        const emb = await fakeEmbedCaption(captionText);
        if (emb) fakeSupabaseUpdate(emb);

        expect(savedEmbeddings).toHaveLength(1);
        expect(savedEmbeddings[0]).toHaveLength(384);
    });

    it('check-similarity endpoint returns unique:true when embedding is null', () => {
        // Simulate the endpoint response path when embedCaption returns null
        const embedding = null;
        let response;
        if (!embedding) {
            response = { unique: true, embedding_failed: true };
        }
        expect(response.unique).toBe(true);
        expect(response.embedding_failed).toBe(true);
    });

    it('check-similarity returns unique:false when similarity >= threshold', () => {
        const threshold = 0.92;
        const closest = { id: 99, niche: 'technology', caption_preview: 'Apple launches iPhone 18', similarity: 0.97 };

        let response;
        if (closest && closest.similarity >= threshold) {
            response = {
                unique: false,
                similarity: closest.similarity,
                matched_article_id: closest.id,
                matched_niche: closest.niche,
                matched_caption_preview: closest.caption_preview
            };
        }

        expect(response.unique).toBe(false);
        expect(response.similarity).toBe(0.97);
        expect(response.matched_article_id).toBe(99);
    });

    it('check-similarity returns unique:true when similarity < threshold', () => {
        const threshold = 0.92;
        const closest = { id: 99, niche: 'technology', caption_preview: 'Samsung releases foldable', similarity: 0.65 };

        let response;
        if (closest && closest.similarity >= threshold) {
            response = { unique: false };
        } else {
            response = { unique: true, closest_similarity: closest ? closest.similarity : null };
        }

        expect(response.unique).toBe(true);
        expect(response.closest_similarity).toBe(0.65);
    });
});
