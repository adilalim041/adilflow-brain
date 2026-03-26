import { describe, it, expect } from 'vitest';

// Extract pure functions from server.js for testing
function toInt(value, fallback, min = 1, max = 100) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function mergeScoreDetails(existing, extra) {
    return { ...(existing || {}), ...(extra || {}) };
}

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
