import { describe, expect, test } from '@jest/globals';

import { rowsFromLegacy } from '../public/scripts/extensions/sanguine/rows-seed.js';
import { renderLedger } from '../public/scripts/extensions/sanguine/rows-table.js';
import { stalenessSuspects } from '../public/scripts/extensions/sanguine/audit-table.js';

const ev = (t, d) => ({ s: 'x', kw: [], t, src: 'llm', k: `k${t}`, d });

describe('rows-seed: the legacy chat comes up as a populated table', () => {
    test('inventory, vitals, marks, threads and cast all become rows', () => {
        const events = [
            ev(1, { inv: [{ item: 'won', dq: 200, at: 'money' }], vit: [], st: [] }),
            ev(2, { inv: [{ item: 'ka-bar knife', dq: 1, at: 'carried' }], vit: [], st: [] }),
            ev(3, { inv: [], vit: [{ name: 'hp', dcur: 38 }], st: [] }),
            ev(4, { inv: [], vit: [], st: [{ flag: 'limping', on: true, who: 'Solomon' }] }),
        ];
        const threads = new Map([
            ['the missing shipment', { name: 'the missing shipment', first: 10 }],
        ]);
        const cast = new Map([
            ['person\u0000kang', { name: 'Kang Min-seo', first: 12, place: 'Nowon gate' }],
        ]);
        const table = rowsFromLegacy({ events, threads, cast, turn: 40 });

        expect(table.rows.size).toBe(6);
        const kinds = {};
        for (const r of table.rows.values()) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
        expect(kinds).toEqual({ item: 2, vital: 1, mark: 1, thread: 1, person: 1 });

        const money = [...table.rows.values()].find(r => r.name === 'won');
        expect(money).toMatchObject({ kind: 'item', place: 'money', qty: 200 });
        // Seeded rows are fresh at the current turn, not immediately flagged stale.
        expect(stalenessSuspects(table.rows, 40)).toEqual([]);
        // The ledger renders the seeded rows.
        expect(renderLedger(table)).toContain('ka-bar knife');
    });

    test('the seed is idempotent-shaped: repeated seeds do not duplicate rows', () => {
        const events = [ev(1, { inv: [{ item: 'ka-bar knife', dq: 1, at: 'carried' }], vit: [], st: [] })];
        const a = rowsFromLegacy({ events, turn: 1 });
        const b = rowsFromLegacy({ events, turn: 1 });
        expect(a.rows.size).toBe(b.rows.size);
    });
});
