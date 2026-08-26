// #3594 / #3881: registers the adversarial frontmatter fixture corpus that
// tests/fixtures/adversarial/frontmatter/README.md instructs contributors to add entries to.
// This file did not previously exist, which is how the unicode-keys-and-values round-trip
// invariant (row B3, ADR-3473 50-test-matrix.md) shipped violated under a green suite: no test
// ever loaded the fixture and checked the README's own claim. The matrix below is table-driven
// over the fixture directory itself so a fixture dropped in without a matching entry fails loudly
// instead of going silently unowned.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractFrontmatter, FRONTMATTER_UNPARSEABLE } = require('../gsd-core/bin/lib/frontmatter.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'adversarial', 'frontmatter');

function readFixture(name) {
    return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function collectValues(node, out) {
    if (typeof node === 'string') {
        out.push(node);
    } else if (Array.isArray(node)) {
        for (const item of node) collectValues(item, out);
    } else if (node && typeof node === 'object') {
        for (const value of Object.values(node)) collectValues(value, out);
    }
    return out;
}

// Table-driven ownership: every fixture file present on disk (excluding README.md, which is
// documentation, not a fixture) must have exactly one entry here. Adding a fixture without
// registering it here is the exact failure mode this file closes.
const MATRIX = {
    'duplicate-keys.md': {
        invariant: 'deterministic result, last-wins',
        check(parsed) {
            // The fixture repeats `title` and `status`. README pins last-wins as current behavior.
            assert.equal(parsed.title, 'Second');
            assert.equal(parsed.status, 'blocked');
            // Determinism: parsing the same content twice yields the same structural result.
            const again = extractFrontmatter(readFixture('duplicate-keys.md'), 'duplicate-keys.md');
            assert.deepEqual(again, parsed);
        },
    },
    'crlf-mixed.md': {
        invariant: '\\r handled consistently, never bled into parsed values',
        check(parsed) {
            const values = collectValues(parsed, []);
            assert.ok(values.length > 0, 'fixture must produce at least one parsed value to check');
            for (const value of values) {
                assert.ok(
                    !value.includes('\r'),
                    `parsed value ${JSON.stringify(value)} carries a bled-in \\r`
                );
            }
        },
    },
    'unclosed-block.md': {
        invariant: 'empty or a clean error, never partial',
        check() {
            const content = readFixture('unclosed-block.md');
            let result;
            let threw = false;
            try {
                result = extractFrontmatter(content, 'unclosed-block.md');
            } catch {
                threw = true;
            }
            if (threw) return; // a clean error satisfies the invariant
            // Not thrown: the only non-partial outcome is a fully empty result. A result
            // carrying only `title` (captured before the missing close) would be partial.
            assert.equal(typeof result, 'object');
            assert.equal(Object.keys(result).length, 0);
        },
    },
    'unicode-keys-and-values.md': {
        invariant: 'round-trips as-is (row B3)',
        check(parsed) {
            assert.ok(
                Object.prototype.hasOwnProperty.call(parsed, '相'),
                'the 相 key must survive parsing as documented by the fixture README'
            );
            assert.equal(parsed['相'], '04');
            assert.equal(parsed.title, '日本語のタイトル');
            assert.deepEqual(parsed.tags, ['α', 'β', 'γ']);
        },
    },
    'null-byte-value.md': {
        invariant: 'preserved or normalized, must not crash, must not truncate silently',
        check(parsed) {
            const value = parsed.weird;
            assert.equal(typeof value, 'string');
            // Truncation would drop everything from the null byte onward, losing "after".
            assert.ok(value.includes('before'));
            assert.ok(value.includes('after'));
            assert.notEqual(value, 'before');
        },
    },
    'huge-bounded.md': {
        invariant: 'completes with a typed result (never asserted via elapsed wall-clock time)',
        check(parsed) {
            assert.equal(typeof parsed, 'object');
            assert.ok(Array.isArray(parsed.plans));
            assert.ok(parsed.plans.length > 0);
            for (const item of parsed.plans) {
                assert.equal(typeof item, 'string');
            }
        },
    },
    'anchor-alias-bomb.md': {
        invariant: 'refused rather than expanded (ADR-3473 §8.1 consequence 6, row A8)',
        check(parsed) {
            // A naive port that let js-yaml resolve anchors/aliases would expand this 7-line
            // fixture to tens of megabytes. The parser must refuse it outright instead: zero
            // keys, and the unparseable marker set rather than a bare, indistinguishable {}.
            assert.equal(Object.keys(parsed).length, 0);
            assert.equal(parsed[FRONTMATTER_UNPARSEABLE], true);
            // Bounded via a size assertion on the RESULT, never on elapsed wall-clock time
            // (repo rule): the serialized form of a refused parse must stay tiny.
            assert.ok(Buffer.byteLength(JSON.stringify(parsed), 'utf8') < 1024);
        },
    },
};

describe('feat-3594 parser adversarial frontmatter fixture matrix', () => {
    test('every fixture on disk has exactly one matrix entry (no unowned fixtures)', () => {
        const onDisk = fs
            .readdirSync(FIXTURE_DIR)
            .filter((name) => name.endsWith('.md') && name !== 'README.md')
            .sort();
        const registered = Object.keys(MATRIX).sort();

        const unowned = onDisk.filter((name) => !registered.includes(name));
        assert.deepEqual(
            unowned,
            [],
            `fixture(s) present on disk with no matrix entry: ${unowned.join(', ')}`
        );

        const stale = registered.filter((name) => !onDisk.includes(name));
        assert.deepEqual(
            stale,
            [],
            `matrix entry(ies) with no corresponding fixture file: ${stale.join(', ')}`
        );
    });

    for (const [fixtureName, entry] of Object.entries(MATRIX)) {
        test(`${fixtureName}: ${entry.invariant}`, () => {
            const content = readFixture(fixtureName);
            const parsed = extractFrontmatter(content, fixtureName);
            entry.check(parsed);
        });
    }
});

describe('B1/B2: block scalar defects (ADR-3473 50-test-matrix.md rows B1, B2)', () => {
    const ADD_TESTS_PATH = path.join(__dirname, '..', 'commands', 'gsd', 'add-tests.md');

    test('blockScalarValueIsNotTheBlockIndicator: argument-instructions is the instruction text, not "|"', () => {
        const content = fs.readFileSync(ADD_TESTS_PATH, 'utf8');
        const parsed = extractFrontmatter(content, ADD_TESTS_PATH);

        const value = parsed['argument-instructions'];
        assert.equal(typeof value, 'string');
        assert.notEqual(value, '|');
        assert.ok(value.length > 1, 'block scalar value must be the multi-line instruction body');
        assert.ok(
            value.includes('Parse the argument as a phase number'),
            'block scalar value must retain the source instruction text'
        );
    });

    test('blockScalarDoesNotInventATopLevelKey: parsing add-tests.md produces no phantom "Example" key', () => {
        const content = fs.readFileSync(ADD_TESTS_PATH, 'utf8');
        const parsed = extractFrontmatter(content, ADD_TESTS_PATH);

        assert.ok(
            !Object.prototype.hasOwnProperty.call(parsed, 'Example'),
            'parser must not scrape a top-level "Example" key out of the block scalar body'
        );
    });
});

describe('B3: unicode key round-trip (ADR-3473 50-test-matrix.md row B3)', () => {
    test('unicodeKeyRoundTripsAsIs: the 相 key from the #3594 fixture survives parsing', () => {
        const content = readFixture('unicode-keys-and-values.md');
        const parsed = extractFrontmatter(content, 'unicode-keys-and-values.md');

        assert.ok(
            Object.prototype.hasOwnProperty.call(parsed, '相'),
            'the 相 key must be present on the parsed object'
        );
        assert.equal(parsed['相'], '04');
    });
});
