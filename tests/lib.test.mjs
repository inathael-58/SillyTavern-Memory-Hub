// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { ageTag, agoText, arcBounds, clampCut, estimateArcs, isComplete, normalizeArcs, parseArc, planArcStep, rankMemories, tokenize } from '../lib.js';

// ---------------------------------------------------------------- rankMemories: same answers as 1.13, faster

// 1.13.2's key bonus, counted per key per memory
function rankOld(memories, queryText, { k1 = 1.2, b = 0.75 } = {}) {
    const THAI = /[฀-๿]/;
    const docs = memories.map(m => tokenize(`${m.title ?? ''} ${(m.keys ?? []).join(' ')} ${m.text ?? ''}`));
    const N = docs.length;
    if (!N) return [];
    const avgdl = docs.reduce((a, d) => a + d.length, 0) / N || 1;
    const df = new Map();
    for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
    const idf = w => Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
    const qTerms = [...new Set(tokenize(queryText))];
    const qLower = String(queryText ?? '').toLowerCase();
    return memories.map((m, i) => {
        const d = docs[i];
        const tf = new Map();
        for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
        let score = 0;
        for (const w of qTerms) {
            const f = tf.get(w);
            if (!f) continue;
            score += idf(w) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avgdl));
        }
        for (const key of m.keys ?? []) {
            const kl = String(key).toLowerCase().trim();
            if (kl.length < (THAI.test(kl) ? 3 : 2)) continue;
            if (qLower.includes(kl)) {
                const inDocs = memories.filter(x => (x.keys ?? []).some(y => String(y).toLowerCase().trim() === kl)).length;
                score += 1.5 * Math.log(1 + N / inDocs);
            }
        }
        return { memory: m, score };
    }).sort((a, b) => b.score - a.score);
}

const WORDS = 'โนเอล ลีอา ปราสาท ทะเลสาบ ดาบ แหวน สัญญา จูบ ป่า หมู่บ้าน ราชา มังกร บาดแผล จดหมาย ความลับ castle ring dragon Lake'.split(' ');
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = n => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]);
const mem = i => ({ id: `m${i}`, title: `ตอน ${i} ${pick(2).join(' ')}`, keys: pick(5), text: pick(30).join(' ') });

test('rankMemories gives the same scores and order as before', () => {
    for (const n of [1, 5, 60]) {
        const mems = Array.from({ length: n }, (_, i) => mem(i));
        for (let q = 0; q < 5; q++) {
            const query = pick(20).join(' ');
            const a = rankMemories(mems, query);
            const b = rankOld(mems, query);
            assert.equal(a.length, b.length);
            a.forEach((r, i) => {
                assert.ok(Math.abs(r.score - b[i].score) < 1e-9, `score ${i}`);
                assert.equal(r.memory.id, b[i].memory.id);
            });
        }
    }
});

test('rankMemories stays fast with many memories', () => {
    const mems = Array.from({ length: 500 }, (_, i) => mem(i));
    const q = pick(60).join(' ');
    rankMemories(mems, q); // warm the word cache, as the second turn would be
    const t = performance.now();
    rankMemories(mems, q);
    assert.ok(performance.now() - t < 400, 'ranking 500 memories should take well under a second');
});

// ---------------------------------------------------------------- arcs

test('arcBounds: half to one and a half of the target', () => {
    assert.deepEqual(arcBounds(10), { target: 10, min: 5, max: 15 });
    assert.deepEqual(arcBounds(20), { target: 20, min: 10, max: 30 });
    assert.deepEqual(arcBounds(3), { target: 3, min: 2, max: 5 });
    assert.deepEqual(arcBounds(2), { target: 2, min: 2, max: 3 });
});

const ids = n => Array.from({ length: n }, (_, i) => `u${i}`);

test('planArcStep: the newest memories wait until max of them, flexible', () => {
    assert.equal(planArcStep({ units: ids(14), arcs: [], target: 10 }), null);
    const s = planArcStep({ units: ids(15), arcs: [], target: 10 });
    assert.equal(s.type, 'make');
    assert.equal(s.tail, true);
    assert.equal(s.ids.length, 15);
    assert.deepEqual([s.min, s.max], [5, 15]);
    const big = planArcStep({ units: ids(52), arcs: [], target: 10 });
    assert.equal(big.ids.length, 15);
    assert.equal(big.rest.length, 37);
});

test('planArcStep: fixed size, and forced by hand', () => {
    assert.equal(planArcStep({ units: ids(9), arcs: [], target: 10, flexible: false }), null);
    const f = planArcStep({ units: ids(12), arcs: [], target: 10, flexible: false });
    assert.deepEqual([f.ids.length, f.min, f.max], [10, 10, 10]);
    assert.equal(planArcStep({ units: ids(4), arcs: [], target: 10, force: true }), null);
    const forced = planArcStep({ units: ids(7), arcs: [], target: 10, force: true });
    assert.deepEqual([forced.ids.length, forced.min, forced.max], [7, 5, 7]);
});

test('planArcStep: arcs already made are skipped', () => {
    const arcs = [{ id: 'A', members: ids(8) }];
    assert.equal(planArcStep({ units: ids(20), arcs, target: 10 }), null); // 12 waiting < 15
    const s = planArcStep({ units: ids(23), arcs, target: 10 });
    assert.equal(s.ids[0], 'u8');
    assert.equal(s.ids.length, 15);
});

test('planArcStep: a memory filled in inside an arc joins that arc', () => {
    const units = ids(12);
    const arcs = [{ id: 'A', members: units.filter(x => x !== 'u4') }];
    assert.deepEqual(planArcStep({ units, arcs, target: 10 }), { type: 'attach', arcId: 'A', ids: ['u4'] });
});

test('planArcStep: a few memories between two arcs join the earlier one; stale arcs are rewritten', () => {
    const units = ids(30);
    const arcs = [{ id: 'A', members: ids(10) }, { id: 'B', members: units.slice(12, 22) }];
    assert.deepEqual(planArcStep({ units, arcs, target: 10 }), { type: 'attach', arcId: 'A', ids: ['u10', 'u11'] });
    arcs[0].members.push('u10', 'u11');
    arcs[0].stale = true;
    assert.deepEqual(planArcStep({ units, arcs, target: 10 }), { type: 'rebuild', arcId: 'A' });
});

test('planArcStep: carried memories imported before existing arcs are used up completely', () => {
    const units = ids(40);
    const arcs = [{ id: 'A', members: units.slice(22, 32) }]; // 22 memories before it
    const s = planArcStep({ units, arcs, target: 10 });
    assert.equal(s.type, 'make');
    assert.equal(s.tail, false);
    assert.ok(s.max <= 22 - 5, 'leaves at least half an arc for the next one');
    // the last part before the arc is taken whole
    const arcs2 = [{ id: 'X', members: ids(12) }, ...arcs];
    const s2 = planArcStep({ units, arcs: arcs2, target: 10 });
    assert.deepEqual([s2.ids.length, s2.min, s2.max], [10, 10, 10]);
});

test('normalizeArcs: drops gone members, marks stale, removes empty arcs, sorts', () => {
    const arcs = [
        { id: 'B', members: ['u5', 'u6'] },
        { id: 'A', members: ['u0', 'gone', 'u1'] },
        { id: 'C', members: ['gone2'] },
    ];
    const { arcs: out, changed } = normalizeArcs(ids(8), arcs);
    assert.equal(changed, true);
    assert.deepEqual(out.map(a => a.id), ['A', 'B']);
    assert.equal(out[0].stale, true);
    assert.deepEqual(out[0].members, ['u0', 'u1']);
    assert.equal(out[1].stale, undefined);
    assert.equal(normalizeArcs(ids(8), out).changed, false);
});

test('estimateArcs', () => {
    assert.deepEqual(estimateArcs(52, 10), [4, 5]);
    assert.deepEqual(estimateArcs(15, 10), [1, 2]);
});

test('parseArc reads the cut, the memory fields and the overview', () => {
    const raw = `<think>hmm</think><arc>
cut: 7
title: การเดินทางสู่ปราสาท
keys: ปราสาท, แหวน, มังกร
summary:
- โนเอลได้แหวนจากราชา
- ลีอากับโนเอลเปลี่ยนจากคู่แข่งเป็นคนรัก
</arc>
<overview>
เรื่องย่อใหม่
</overview>`;
    const p = parseArc(raw);
    assert.equal(p.cut, 7);
    assert.equal(p.title, 'การเดินทางสู่ปราสาท');
    assert.deepEqual(p.keys, ['ปราสาท', 'แหวน', 'มังกร']);
    assert.match(p.text, /^- โนเอลได้แหวนจากราชา/);
    assert.doesNotMatch(p.text, /cut/);
    assert.equal(p.overview, 'เรื่องย่อใหม่');
    assert.equal(parseArc('<arc>\ntitle: x\nsummary:\n- a\n</arc>').cut, null);
    assert.equal(parseArc('<arc>\ncut: [12]\nsummary:\n- a\n</arc>').cut, 12);
    assert.equal(isComplete(raw, { memory: false, arc: true, overview: true }), true);
    assert.equal(isComplete('<arc>\ncut: 3\nsummary:\n- a', { memory: false, arc: true }), false);
});

test('clampCut keeps the cut inside the range', () => {
    assert.equal(clampCut(7, 5, 15, 10), 7);
    assert.equal(clampCut(30, 5, 15, 10), 15);
    assert.equal(clampCut(2, 5, 15, 10), 5);
    assert.equal(clampCut(null, 5, 15, 10), 10);
});

test('age labels', () => {
    assert.equal(agoText(12), 'just before the recent messages');
    assert.equal(agoText(147), '~150 messages ago');
    assert.equal(agoText(812), '~800 messages ago');
    assert.equal(agoText(1234), '~1200 messages ago');
    assert.equal(ageTag({ kind: 'memory', index: 8, total: 58, start: 140, end: 159, chatLength: 1060 }), '[Memory 8/58 · #140–#159 · ~900 messages ago]');
    assert.equal(ageTag({ kind: 'arc', index: 2, total: 5, start: -1, end: -1, chatLength: 10, earlier: true }), '[Arc 2/5 · from an earlier chat]');
});
