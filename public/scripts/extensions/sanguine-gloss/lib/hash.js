// THE HASHMAP TRINITY — one structure, the merge is the only freedom.
//
// The JavaScript mirror of proof/Substrate/Algebra/HashTrinity.lean and lyrium's
// src/hash.rs. There is ONE data structure — the hashmap (the dictionary-as-
// applicative K → V; here, Map) — and ONE operation, insert_with(f) (update a key
// by MERGING the new value with the old via f). The merge f is the ONLY freedom;
// the three "forms of hashmap" are that one operation under the trinity of merges:
//
//   | form        | merge f               | trinity | what it is                        |
//   |-------------|-----------------------|---------|-----------------------------------|
//   | Set         | idempotent (∨)        | NB  (0) | membership · occupancy · presence |
//   | Map         | replace (last write)  | B   (1) | lookup · the value · the seed     |
//   | Accumulator | a monoid (+/++)       | B/U (/) | counting · combine · the field    |
//
//   (+ the 4th: Graph — ++ over keys, the / turned on the keys themselves.)
//
// Every stateful operation in this site goes through insert_with. Learn the merge;
// the rest is a choice of f.

// THE ONE OPERATION. Update key k by merging the new value with the old via
// f(new, old); if the key is absent, insert the new value. The merge f —
// collision resolution — is the only thing that changes between the forms.
export const insert_with = (m, f, k, v) =>
  (m.set(k, m.has(k) ? f(v, m.get(k)) : v), m);

// Total lookup — the Map face read, with a floor for absent keys.
export const lookup = (m, k, dflt) => (m.has(k) ? m.get(k) : dflt);

// ───────── THE TRINITY OF MERGES — one operation, three (+1) forms ─────────

// NB (0): the idempotent merge — once in, in. → Set.
export const merge_nb = (nu, old) => nu || old;

// B (1): replace — take the new value (last write). → Map.
export const merge_b = (nu, _old) => nu;

// B/U (/): a monoid merge — combine. Here (number, +), a counter. → Accumulator.
export const merge_bu = (nu, old) => nu + old;

// B/U (/): the pair monoid — additive accumulation of {sum, n} (a mean's seed).
// Same Accumulator form as merge_bu, over the componentwise additive monoid.
export const merge_acc = (nu, old) => ({ sum: nu.sum + old.sum, n: nu.n + old.n });

// The 4th: ++ over keys (V = Array) — link. → Graph / adjacency.
export const merge_graph = (nu, old) => old.concat(nu);

// Recursor helpers: arrays/iterables fold into the one Table operation. These are deliberately
// small; callers still choose the merge, which is the whole algebra.
export const fold = (xs, z, f) => Array.from(xs || []).reduce(f, z);

export const table_from = (xs, key, val, merge = merge_graph) =>
  fold(xs, new Map(), (m, x) => insert_with(m, merge, key(x), val(x)));

export const table_values = (m) => Array.from(m.values());
export const table_entries = (m) => Array.from(m.entries());

// ───────── the tests (hash.rs §tests, runnable: import { self_test }) ─────────

export const self_test = () => {
  const eq = (a, b, name) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('hash.js: ' + name);
  };
  const s = new Map();                                   // Set (NB)
  insert_with(s, merge_nb, 'x', true);
  insert_with(s, merge_nb, 'x', false);
  eq(lookup(s, 'x'), true, 'set_member');
  const m = new Map();                                   // Map (B)
  insert_with(m, merge_b, 'k', 1);
  insert_with(m, merge_b, 'k', 9);
  eq(lookup(m, 'k'), 9, 'map_lookup');
  const c = new Map();                                   // Accumulator (B/U)
  insert_with(c, merge_bu, 'k', 1);
  insert_with(c, merge_bu, 'k', 1);
  eq(lookup(c, 'k'), 2, 'count_two');
  const g = new Map();                                   // Graph (the 4th)
  insert_with(g, merge_graph, 'a', ['b']);
  insert_with(g, merge_graph, 'a', ['c']);
  eq(lookup(g, 'a'), ['b', 'c'], 'graph_edge');
  const a = new Map();                                   // Accumulator (pair monoid)
  insert_with(a, merge_acc, 'f', { sum: 3, n: 1 });
  insert_with(a, merge_acc, 'f', { sum: 5, n: 1 });
  eq(lookup(a, 'f'), { sum: 8, n: 2 }, 'acc_pair');
  const by = table_from(['aa', 'b', 'ac'], x => x[0], x => [x]);
  eq(lookup(by, 'a'), ['aa', 'ac'], 'table_from_graph');
  return 'hash.js: all merges hold';
};
