import nodeTest, { describe as nodeDescribe } from 'node:test';
import assert from 'node:assert/strict';

export const describe = nodeDescribe;
export const test = nodeTest;
export const it = nodeTest;

function createMatcher(actual) {
    return {
        toBe(expected) {
            assert.equal(actual, expected);
        },
        toEqual(expected) {
            assert.deepEqual(actual, expected);
        },
        toBeNull() {
            assert.equal(actual, null);
        },
        toBeUndefined() {
            assert.equal(actual, undefined);
        },
        toBeTruthy() {
            assert.ok(actual);
        },
        toBeFalsy() {
            assert.ok(!actual);
        },
        toContain(expected) {
            if (typeof actual === 'string' || Array.isArray(actual)) {
                assert.ok(actual.includes(expected));
            } else if (actual instanceof Set || actual instanceof Map) {
                assert.ok(actual.has(expected));
            } else {
                assert.ok(expected in actual);
            }
        },
        toBeGreaterThan(expected) {
            assert.ok(actual > expected);
        },
        toBeGreaterThanOrEqual(expected) {
            assert.ok(actual >= expected);
        },
        toBeLessThan(expected) {
            assert.ok(actual < expected);
        },
        toBeLessThanOrEqual(expected) {
            assert.ok(actual <= expected);
        },
        toBeCloseTo(expected, precision = 2) {
            const diff = Math.abs(actual - expected);
            assert.ok(diff < Math.pow(10, -precision) / 2);
        },
        toMatch(expected) {
            if (expected instanceof RegExp) {
                assert.match(String(actual), expected);
            } else {
                assert.ok(String(actual).includes(expected));
            }
        },
        toThrow(expected) {
            assert.throws(actual, expected);
        },
        toHaveLength(expected) {
            assert.equal(actual?.length, expected);
        },
        toMatchObject(expected) {
            if (!actual || typeof actual !== 'object') {
                assert.fail('actual is not an object');
            }
            for (const [key, value] of Object.entries(expected)) {
                assert.deepEqual(actual[key], value);
            }
        },
        get not() {
            const inner = createMatcher(actual);
            return new Proxy(inner, {
                get(target, prop) {
                    return (...args) => {
                        assert.throws(() => target[prop](...args));
                    };
                },
            });
        },
    };
}

export function expect(actual) {
    return createMatcher(actual);
}
