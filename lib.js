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
    body = body.replace(/^\s*(?:summary|สรุป)\s*[:：]\s*/im, '').trim();

    return { title: title.slice(0, 120), keys: [...new Set(keys)].slice(0, 12), text: body, overview };
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

/** Plain BM25 with a bonus for the summarizer's own keys found in the query. */
export function rankMemories(memories, queryText, { k1 = 1.2, b = 0.75 } = {}) {
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
        const hits = [];
        for (const w of qTerms) {
            const f = tf.get(w);
            if (!f) continue;
            const s = idf(w) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avgdl));
            score += s;
            hits.push(w);
        }
        for (const key of m.keys ?? []) {
            const kl = String(key).toLowerCase().trim();
            if (kl.length < (THAI.test(kl) ? 3 : 2)) continue;
            if (qLower.includes(kl)) {
                // rarer keys weigh more: a key present in every memory is a name, not a clue
                const inDocs = memories.filter(x => (x.keys ?? []).some(y => String(y).toLowerCase().trim() === kl)).length;
                score += 1.5 * Math.log(1 + N / inDocs);
                hits.push(`🔑${key}`);
            }
        }
        return { memory: m, score, hits };
    }).sort((a, b) => b.score - a.score);
}
