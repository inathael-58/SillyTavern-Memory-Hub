/*
 * Memory Hub — pure helpers (no SillyTavern imports, unit-testable in Node).
 *
 * Recall is lexical, not vector: BM25 over word tokens. Thai has no spaces, so
 * words come from the browser's own word breaker (Intl.Segmenter); query and
 * memories go through the same breaker, so even names it splits oddly
 * (โน|เอ|ล) still match each other. Words that appear in most memories (the
 * main characters' names, "said", ...) get almost no weight from the IDF term,
 * which is exactly what keyword lorebooks cannot do.
 */

const THAI = /[฀-๿]/;

const STOPWORDS = new Set([
    // English
    'the', 'and', 'of', 'to', 'a', 'an', 'in', 'is', 'was', 'were', 'he', 'she', 'it', 'that', 'his', 'her', 'him',
    'you', 'your', 'i', 'me', 'my', 'we', 'our', 'with', 'for', 'on', 'as', 'at', 'but', 'not', 'they', 'them',
    'their', 'this', 'be', 'are', 'had', 'have', 'has', 'do', 'did', 'so', 'if', 'or', 'from', 'by', 'into', 'out',
    'up', 'down', 'then', 'than', 'just', 'there', 'what', 'when', 'who', 'how', 'all', 'can', 'will', 'would',
    'could', 'about', 'over', 'its', 'been', 'one', 'no', 'yes', 'said', 'says',
    // Thai function words
    'ที่', 'และ', 'ของ', 'ใน', 'ไม่', 'ได้', 'ให้', 'ก็', 'จะ', 'แล้ว', 'เป็น', 'มี', 'กับ', 'นั้น', 'นี้', 'ว่า',
    'อยู่', 'ไป', 'มา', 'คือ', 'แต่', 'หรือ', 'เขา', 'เธอ', 'ฉัน', 'ผม', 'คุณ', 'กัน', 'อย่าง', 'เมื่อ', 'จาก',
    'ถึง', 'ตัว', 'ขึ้น', 'ลง', 'ออก', 'เข้า', 'ด้วย', 'ยัง', 'อีก', 'ก่อน', 'หลัง', 'ทำ', 'เลย', 'นะ', 'ค่ะ',
    'ครับ', 'คะ', 'จ้ะ', 'การ', 'ความ', 'โดย', 'เพื่อ', 'ซึ่ง', 'แค่', 'ทั้ง', 'ๆ', 'เอง', 'นั่น', 'นี่', 'พูด',
]);

let segmenter = null;
try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        segmenter = new Intl.Segmenter('th', { granularity: 'word' });
    }
} catch { segmenter = null; }

export const hasSegmenter = () => !!segmenter;

/** @param {string} text @returns {string[]} */
export function tokenize(text) {
    const s = String(text ?? '').toLowerCase();
    const out = [];
    const push = w => {
        if (w.length < 2) return;
        if (STOPWORDS.has(w)) return;
        if (/^\d+$/.test(w)) return;
        out.push(w);
    };
    if (segmenter) {
        for (const seg of segmenter.segment(s)) {
            if (seg.isWordLike) push(seg.segment);
        }
        return out;
    }
    // Fallback: split on non-letters; Thai runs become character bigrams.
    for (const run of s.split(/[^\p{L}\p{N}\p{M}]+/u)) {
        if (!run) continue;
        if (THAI.test(run)) {
            for (let i = 0; i < run.length - 1; i++) push(run.slice(i, i + 2));
        } else {
            push(run);
        }
    }
    return out;
}

/**
 * Removes markup that costs tokens but carries no story: <style>/<script>
 * blocks, HTML comments, tags, and runs of whitespace.
 */
export function cleanText(text, maxChars = 0) {
    let s = String(text ?? '')
        .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n[ \n]*/g, '\n')
        .trim();
    if (maxChars > 0 && s.length > maxChars) s = s.slice(0, maxChars).trimEnd() + ' …';
    return s;
}

/**
 * Parses the summarizer's answer. Tolerates missing closing tags, <think>
 * blocks, code fences and a model that ignored the format altogether.
 * @returns {{title:string, keys:string[], text:string, overview:string}}
 */
export function parseSummary(raw) {
    let txt = String(raw ?? '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/```[a-z]*\n?/gi, '')
        .trim();

    const ovMatch = /<overview>([\s\S]*?)(?:<\/overview>|$)/i.exec(txt);
    const overview = ovMatch ? ovMatch[1].trim() : '';
    if (ovMatch) txt = (txt.slice(0, ovMatch.index) + txt.slice(ovMatch.index + ovMatch[0].length)).trim();

    const memMatch = /<memory>([\s\S]*?)(?:<\/memory>|$)/i.exec(txt);
    let body = (memMatch ? memMatch[1] : txt).trim();

    let title = '';
    let keys = [];
    const t = /^\s*(?:title|ชื่อ)\s*[:：]\s*(.+)$/im.exec(body);
    if (t) { title = t[1].trim(); body = body.replace(t[0], ''); }
    const k = /^\s*(?:keys?|keywords?|คีย์)\s*[:：]\s*(.+)$/im.exec(body);
    if (k) {
        keys = k[1].split(/[,，、;|]/).map(x => x.trim().replace(/^["'`]|["'`]$/g, '')).filter(Boolean);
        body = body.replace(k[0], '');
    }
    // "facts:" carries who-is-who and agreements; it becomes the first bullet
    let facts = '';
    const f = /^\s*(?:facts?|ข้อเท็จจริง)\s*[:：]\s*(.+)$/im.exec(body);
    if (f) {
        body = body.replace(f[0], '');
        const v = f[1].trim();
        if (!/^(?:none|n\/a|ไม่มี|-|—|\(none\)|<.*>)\.?$/i.test(v)) facts = v;
    }
    body = body.replace(/^\s*(?:summary|สรุป)\s*[:：]\s*/im, '').trim();
    if (facts) body = `- ${facts}\n${body}`.trim();

    return { title: title.slice(0, 120), keys: [...new Set(keys)].slice(0, 12), text: body, overview };
}

/**
 * Did a provider's content filter stop this answer?
 * 'prohibited' = Gemini's PROHIBITED_CONTENT, which no safety setting turns off;
 * 'filter' = another filter, or an answer with nothing in it.
 * SillyTavern reports a blocked Gemini answer as "no candidate" or "Candidate text empty".
 * @returns {'prohibited'|'filter'|null}
 */
export function blockKind(text) {
    const s = String(text ?? '');
    if (/PROHIBITED_CONTENT/i.test(s)) return 'prohibited';
    if (/blockReason|BLOCKLIST|\bSPII\b|\bSAFETY\b|no candidate|candidate text empty|content[_ ]?filter|content management policy|ได้คำตอบว่าง/i.test(s)) return 'filter';
    return null;
}

/**
 * Which messages should the next summary cover?
 * Leaves the newest `keepRaw` messages alone. Without `force`, only a full
 * chunk of `chunkSize` messages is taken.
 * @returns {{start:number,end:number}|null}
 */
export function nextChunk(lastEnd, chatLength, chunkSize, keepRaw, force = false) {
    const start = Math.max(0, lastEnd + 1);
    const limit = chatLength - 1 - Math.max(0, keepRaw); // last index we may summarize
    const available = limit - start + 1;
    if (available <= 0) return null;
    if (available < chunkSize && !force) return null;
    return { start, end: start + Math.min(chunkSize, available) - 1 };
}

/**
 * Stretches of messages up to `lastEnd` that no memory covers, e.g. after a
 * memory was deleted. Messages with nothing to summarize (system, empty) never
 * open a gap, and do not split one either.
 * @param {Array<[number, number]>} ranges covered [start, end] pairs
 * @param {number} lastEnd
 * @param {(i:number) => boolean} isEmpty
 * @returns {Array<[number, number]>}
 */
export function findGaps(ranges, lastEnd, isEmpty = () => false) {
    const covered = new Uint8Array(Math.max(0, lastEnd + 1));
    for (const [a, b] of ranges) {
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0) continue;
        for (let i = a; i <= Math.min(b, lastEnd); i++) covered[i] = 1;
    }
    const gaps = [];
    let cur = null;
    for (let i = 0; i <= lastEnd; i++) {
        if (covered[i]) { cur = null; continue; }
        if (isEmpty(i)) continue;
        if (cur) cur[1] = i;
        else gaps.push(cur = [i, i]);
    }
    return gaps;
}

// Word lists of memories, by their text: ranking runs every turn, the
// memories rarely change, and the word breaker is the slow part.
const docCache = new Map();
function docTokens(m) {
    const text = `${m.title ?? ''} ${(m.keys ?? []).join(' ')} ${m.text ?? ''}`;
    let t = docCache.get(text);
    if (!t) {
        if (docCache.size > 4000) docCache.clear();
        t = tokenize(text);
        docCache.set(text, t);
    }
    return t;
}
const normKey = k => String(k ?? '').toLowerCase().trim();

/** Plain BM25 with a bonus for the summarizer's own keys found in the query. */
export function rankMemories(memories, queryText, { k1 = 1.2, b = 0.75 } = {}) {
    const docs = memories.map(docTokens);
    const N = docs.length;
    if (!N) return [];
    const avgdl = docs.reduce((a, d) => a + d.length, 0) / N || 1;
    const df = new Map();
    for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
    const idf = w => Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
    // in how many memories each key appears, counted once (was once per key per memory)
    const keyDf = new Map();
    for (const m of memories) for (const k of new Set((m.keys ?? []).map(normKey))) keyDf.set(k, (keyDf.get(k) ?? 0) + 1);

    const qTerms = [...new Set(tokenize(queryText))];
    const qLower = String(queryText ?? '').toLowerCase();

    return memories.map((m, i) => {
        const d = docs[i];
        const tf = new Map();
        for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
        let score = 0;
        const hits = [];
        for (const w of qTerms) {
            const f = tf.get(w);
            if (!f) continue;
            const s = idf(w) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avgdl));
            score += s;
            hits.push(w);
        }
        for (const key of m.keys ?? []) {
            const kl = normKey(key);
            if (kl.length < (THAI.test(kl) ? 3 : 2)) continue;
            if (qLower.includes(kl)) {
                // rarer keys weigh more: a key present in every memory is a name, not a clue
                score += 1.5 * Math.log(1 + N / (keyDf.get(kl) || 1));
                hits.push(`🔑${key}`);
            }
        }
        return { memory: m, score, hits };
    }).sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- arcs (ภาค)
//
// An arc folds a run of consecutive memories into one bigger memory, so a long
// chat has three levels: story-so-far > arcs > memories. Arcs always cover the
// oldest memories first and never overlap; the newest memories wait until
// enough of them pile up.

/** How many memories an arc may hold when its size is `target` (the AI picks the cut in between). */
export function arcBounds(target) {
    const t = Math.max(2, Math.round(Number(target) || 0));
    const min = Math.max(2, Math.round(t / 2));
    const max = Math.max(min + 1, Math.round(t * 1.5));
    return { target: t, min, max };
}

/**
 * Brings arcs in line with the memories that exist now: members that are gone
 * are dropped (the arc becomes stale and must be rewritten), empty arcs go,
 * members and arcs are put in story order. Mutates the arcs.
 * @param {string[]} units ids of the memories arcs may hold, in story order
 * @param {Array<{id:string, members:string[], stale?:boolean}>} arcs
 * @returns {{arcs: any[], changed: boolean}}
 */
export function normalizeArcs(units, arcs) {
    const at = new Map(units.map((id, i) => [id, i]));
    let changed = false;
    const out = [];
    const taken = new Set();
    for (const a of arcs ?? []) {
        const before = Array.isArray(a.members) ? a.members : [];
        // a memory belongs to one arc only: the first arc that claims it keeps it
        const members = [...new Set(before)].filter(id => at.has(id) && !taken.has(id)).sort((x, y) => at.get(x) - at.get(y));
        if (members.length !== before.length || members.some((id, i) => id !== before[i])) {
            if (members.length < before.length) a.stale = true;
            a.members = members;
            changed = true;
        }
        if (!members.length) { changed = true; continue; }
        for (const id of members) taken.add(id);
        out.push(a);
    }
    const first = a => at.get(a.members[0]);
    const sorted = [...out].sort((x, y) => first(x) - first(y));
    if (sorted.some((a, i) => a !== out[i]) || out.length !== (arcs ?? []).length) changed = true;
    return { arcs: sorted, changed };
}

/**
 * The next thing to do with arcs, or null when nothing is due.
 *   attach  — a few memories sit between (or inside) arcs: add them to that arc (it becomes stale)
 *   rebuild — rewrite a stale arc from its members
 *   make    — fold the first memories of `ids` into a new arc; the cut is between min and max
 * The newest memories (the tail) only make an arc when `max` of them wait
 * (`target` when not flexible), or `min` when forced by hand.
 * Expects normalized arcs (see normalizeArcs).
 * @returns {null | {type:'attach', arcId:string, ids:string[]} | {type:'rebuild', arcId:string}
 *   | {type:'make', ids:string[], min:number, max:number, tail:boolean, rest:string[]}}
 */
export function planArcStep({ units, arcs, target, flexible = true, force = false }) {
    const b = arcBounds(target);
    const owner = new Map();
    for (const a of arcs) for (const id of a.members) owner.set(id, a.id);
    // runs of memories no arc holds yet
    const runs = [];
    let cur = null;
    units.forEach((id, i) => {
        if (owner.has(id)) { cur = null; return; }
        if (!cur) runs.push(cur = { ids: [], before: owner.get(units[i - 1]) ?? null, after: null });
        cur.ids.push(id);
    });
    for (const r of runs) {
        const last = units.indexOf(r.ids.at(-1));
        r.after = owner.get(units[last + 1]) ?? null;
    }

    // 1. small runs between arcs, and anything inside an arc, join that arc
    for (const r of runs) {
        if (!r.after) continue;
        if (r.before && r.before === r.after) return { type: 'attach', arcId: r.before, ids: r.ids };
        if (r.ids.length < b.min) return { type: 'attach', arcId: r.before ?? r.after, ids: r.ids };
    }
    // 2. stale arcs
    const stale = arcs.find(a => a.stale);
    if (stale) return { type: 'rebuild', arcId: stale.id };
    // 3. bigger runs before an arc must be used up completely
    for (const r of runs) {
        if (!r.after) continue;
        const L = r.ids.length;
        if (flexible) {
            if (L <= b.max) return { type: 'make', ids: r.ids, min: L, max: L, tail: false, rest: [] };
            const hi = Math.min(b.max, L - b.min);
            return { type: 'make', ids: r.ids.slice(0, hi), min: Math.min(b.min, hi), max: hi, tail: false, rest: r.ids.slice(hi) };
        }
        if (L < b.target + b.min) return { type: 'make', ids: r.ids, min: L, max: L, tail: false, rest: [] };
        return { type: 'make', ids: r.ids.slice(0, b.target), min: b.target, max: b.target, tail: false, rest: r.ids.slice(b.target) };
    }
    // 4. the newest memories
    const tail = runs.find(r => !r.after);
    if (!tail) return null;
    const L = tail.ids.length;
    if (flexible) {
        if (L < (force ? b.min : b.max)) return null;
        const hi = Math.min(L, b.max);
        return { type: 'make', ids: tail.ids.slice(0, hi), min: b.min, max: hi, tail: true, rest: tail.ids.slice(hi) };
    }
    if (L < (force ? b.min : b.target)) return null;
    const n = Math.min(L, b.target);
    return { type: 'make', ids: tail.ids.slice(0, n), min: n, max: n, tail: true, rest: tail.ids.slice(n) };
}

/** About how many arcs `waiting` memories at the end make, as [low, high] for a "4–5" label. */
export function estimateArcs(waiting, target) {
    const t = Math.max(2, target);
    return [Math.max(1, Math.round((waiting - t) / t)), Math.max(1, Math.round(waiting / t))];
}

/**
 * Parses an arc answer: <arc> with "cut:" plus the memory fields, and an optional <overview>.
 * @returns {{cut:number|null, title:string, keys:string[], text:string, overview:string}}
 */
export function parseArc(raw) {
    const txt = String(raw ?? '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/<(\/?)arc>/gi, '<$1memory>');
    let cut = null;
    const c = /^\s*(?:cut|ตัด|ends? at)\s*[:：]\s*#?\[?(\d+)/im.exec(txt);
    if (c) cut = parseInt(c[1], 10);
    const p = parseSummary(txt.replace(/^\s*(?:cut|ตัด|ends? at)\s*[:：].*$/im, ''));
    return { cut, ...p };
}

/** A cut the model gave, kept inside [min, max]; `fallback` when it gave none. */
export function clampCut(cut, min, max, fallback) {
    const n = Number.isInteger(cut) ? cut : fallback;
    return Math.min(max, Math.max(min, Number.isInteger(n) ? n : max));
}

/** "~800 messages ago", rounded so the label stays the same for a while. */
export function agoText(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 30) return 'just before the recent messages';
    const step = n < 200 ? 10 : n < 1000 ? 50 : 100;
    return `~${Math.round(n / step) * step} messages ago`;
}

/**
 * The label in front of a recalled memory or arc: where it sits in the story,
 * so the model can tell old facts from current ones.
 * @param {{kind:'arc'|'memory', index:number, total:number, start?:number, end?:number, chatLength:number, earlier?:boolean}} o
 */
export function ageTag({ kind, index, total, start = -1, end = -1, chatLength, earlier = false }) {
    const parts = [`${kind === 'arc' ? 'Arc' : 'Memory'} ${index}/${total}`];
    if (end >= 0) {
        parts.push(start >= 0 && start !== end ? `#${start}–#${end}` : `#${end}`);
        const ago = agoText(chatLength - 1 - end);
        if (ago) parts.push(ago);
    } else if (earlier) parts.push('from an earlier chat');
    return `[${parts.join(' · ')}]`;
}

/**
 * Several <memory id="n"> blocks in one answer (batch rewrite of imports).
 * @returns {Map<string, {title:string, keys:string[], text:string}>}
 */
export function parseMany(raw) {
    const txt = String(raw ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    const out = new Map();
    const rx = /<memory\s+id\s*=\s*["']?([\w-]+)["']?\s*>([\s\S]*?)<\/memory>/gi;
    let m;
    while ((m = rx.exec(txt))) {
        const p = parseSummary(`<memory>${m[2]}</memory>`);
        if (p.text) out.set(m[1], { title: p.title, keys: p.keys, text: p.text });
    }
    return out;
}

/** Drops keys that are just a main character's name or too short to mean anything. */
export function cleanKeys(keys, names = []) {
    const ban = new Set(names.map(n => String(n ?? '').trim().toLowerCase()).filter(Boolean));
    const seen = new Set();
    const out = [];
    for (const k of keys ?? []) {
        const s = String(k ?? '').trim();
        const l = s.toLowerCase();
        if (s.length < 2 || ban.has(l) || seen.has(l)) continue;
        seen.add(l);
        out.push(s);
    }
    return out;
}

/**
 * Did the answer finish? A reply cut off by the token limit (common when a
 * "thinking" model spends the budget on reasoning) lacks its closing tags.
 */
export function isComplete(raw, { memory = true, overview = false, arc = false } = {}) {
    const t = String(raw ?? '');
    if (memory && /<memory>/i.test(t) && !/<\/memory>/i.test(t)) return false;
    if (arc && !/<\/arc>/i.test(t)) return false;
    if (overview && !/<\/overview>/i.test(t)) return false;
    return true;
}
