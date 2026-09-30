/*
 * Memory Hub — SillyTavern UI extension
 *
 * One place for long-chat memory, built to spend as few tokens as possible:
 *   1. Every N messages, the oldest un-summarized chunk is turned into one
 *      "memory" (title, keys, bullet summary). The same call also refreshes a
 *      short "story so far". One model call per chunk, never per turn.
 *   2. Messages that are already summarized are dropped from the prompt (the
 *      chat file is untouched), so the raw history sent stays small.
 *   3. Each turn, only the memories that matter now are recalled: the newest
 *      one (continuity), pinned ones, and the best BM25 matches for the last
 *      few messages, all under a token budget. No vector setup; Thai text is
 *      split with the browser's word breaker (see lib.js).
 *
 * Everything lives in the chat's metadata. SillyTavern copies metadata into
 * branches; reconcile() then drops the memories past the branch point and
 * restores the story-so-far that was current there. "Continue in a new chat"
 * carries the memories over and opens the new chat with the last reply.
 *
 * Summaries go to an ordered list of APIs (main API and/or Connection
 * Profiles); when one fails, times out or answers empty, the next is tried.
 */

import { cleanKeys, cleanText, hasSegmenter, nextChunk, parseMany, parseSummary, rankMemories } from './lib.js';

const MODULE = 'memory_hub';
const LOG = '[MemoryHub]';
const VERSION = '1.1.0'; // keep in sync with manifest.json
const KEY_OVERVIEW = 'memory_hub_overview';
const KEY_RECALL = 'memory_hub_recall';

// ---------------------------------------------------------------- prompts

const FORMAT = `Answer in exactly this format and nothing else:
<memory>
title: <short title>
keys: <comma separated>
summary:
- ...
</memory>{{overview_format}}`;

const PROMPT_SINGLE = `You are the memory keeper of an ongoing roleplay between {{user}} and {{char}}.
Read NEW MESSAGES and write one compact memory of them.

Rules:
- Write in the same language the story is written in.
- Keep what will matter later:
  • events, decisions and their consequences; promises and plans
  • how the relationship changed: feelings, trust, conflicts, milestones, boundaries
  • what {{char}} learned about {{user}} (likes, habits, past, secrets) and the other way round
  • nicknames, inside jokes, gifts, places that became meaningful
  • injuries, items, time and place changes; unresolved threads
- Skip flavour text, repeated description and status panels.
- Always write names in full instead of "he/she": memories are read out of order.
- Be concrete. No commentary, no guessing.
- summary: short bullet points, at most {{memory_words}} words in total.
- keys: 3-8 distinctive words someone would say when this memory becomes relevant again (places, objects, events, nicknames). Never use {{user}} or {{char}} alone as a key.
{{overview_rule}}
${FORMAT}`;

const PROMPT_RPG = `You are the chronicler of an ongoing role-playing game / multi-character story with {{user}}.
Read NEW MESSAGES and write one compact memory of them.

Rules:
- Write in the same language the story is written in.
- Keep what will matter later:
  • plot events and outcomes, decisions and their consequences
  • every character involved: what they did and what changed (attitude towards {{user}}, relationships, secrets, injuries, status, whereabouts)
  • quests and goals: started, advanced, completed, failed
  • items, money, stats and abilities gained or lost; locations reached or unlocked
  • factions, world facts and rules that were revealed
  • open threads, promises, debts, enemies who got away
- Always write names in full instead of "he/she": memories are read out of order.
- Skip blow-by-blow combat, flavour text and status panels (keep only numbers that changed and matter).
- summary: bullet points, at most {{memory_words}} words in total.
- keys: 3-10 distinctive words (places, secondary characters, items, quest names, factions). Never use {{user}} alone as a key.
{{overview_rule}}
${FORMAT}`;

const OVERVIEW_RULE_SINGLE = '- overview: rewrite PREVIOUS OVERVIEW so it also covers the new memory. It is the story so far in at most {{overview_words}} words: where the relationship stands, what happened that still matters, where they are now, open threads. Drop details that no longer matter.';
const OVERVIEW_RULE_RPG = `- overview: rewrite PREVIOUS OVERVIEW as the CURRENT STATE of the game, at most {{overview_words}} words, under these headings:
  Characters: one line each for the party and important characters (role, current state, relation to {{user}})
  Now: where we are and what is happening
  Quests & threads: active ones only
  Key facts & items: what must not be forgotten
  Drop what is resolved and no longer matters.`;
const OVERVIEW_FORMAT = '\n<overview>\n<updated overview>\n</overview>';

// v1.0.0 shipped one prompt; if a user edited it, keep theirs as "custom".
const PROMPT_V1 = `You are the memory keeper of an ongoing roleplay between {{user}} and {{char}}.
Read NEW MESSAGES and write one compact memory of them.

Rules:
- Write in the same language the story is written in.
- Keep only what will matter later: events, decisions, promises, secrets revealed, changes in relationships, feelings that shifted, injuries, items, places, unresolved threads. Skip flavour text, repeated description and status panels.
- Be concrete: names, places, objects, numbers. No commentary, no guessing.
- summary: short bullet points, at most {{memory_words}} words in total.
- keys: 3-8 distinctive words someone would say when this memory becomes relevant again (places, objects, events, nicknames). Never use a main character's name alone as a key.
{{overview_rule}}
Answer in exactly this format and nothing else:
<memory>
title: <short title>
keys: <comma separated>
summary:
- ...
</memory>{{overview_format}}`;

const PROMPT_OPTIMIZE = `You tidy up the long-term memories of an ongoing roleplay between {{user}} and {{char}}.
Each MEMORY below is one past event. Rewrite each one so it is compact but keeps every fact that could matter later (who, what, where, outcome, feelings, promises, items, numbers).

Rules:
- Write in the same language as the memory.
- summary: bullet points, at most {{memory_words}} words per memory. Remove repetition, flowery prose and meta text (like "Memory #12", dates of the summary, formatting notes).
- Always write names in full instead of "he/she".
- title: short and specific.
- keys: 3-8 distinctive words for when this memory becomes relevant again (places, objects, events, secondary characters). Never {{user}} or {{char}} alone.
- Keep the same id. Do not merge or drop memories.

Answer with one block per memory and nothing else:
<memory id="ID">
title: ...
keys: ...
summary:
- ...
</memory>`;

const PROMPT_REBUILD = `You keep the "story so far" of an ongoing roleplay between {{user}} and {{char}}.
Update PREVIOUS OVERVIEW with the MEMORIES below (they are in story order).
Write in the same language as the story.
{{overview_rule}}
Answer in exactly this format and nothing else:
<overview>
...
</overview>`;

const STYLE_LABEL = {
    auto: ['อัตโนมัติ', 'แชทกลุ่มใช้แบบ RPG, แชทเดี่ยวใช้แบบคาร์เดียว'],
    single: ['คาร์เดียว / ความสัมพันธ์', 'เน้นความรู้สึก ความสัมพันธ์ สิ่งที่รู้เกี่ยวกับกันและกัน'],
    rpg: ['RPG / หลายตัวละคร', 'เน้นตัวละครแต่ละตัว เควส ไอเท็ม สถานที่ ฝ่าย เรื่องย่อเป็นสถานะเกมแบบมีหัวข้อ'],
    custom: ['กำหนดเอง', 'เขียน prompt เอง'],
};

const DEFAULTS = Object.freeze({
    enabled: true,
    autoSummarize: true,
    chunkSize: 20,          // messages per memory
    keepRaw: 12,            // newest messages that are never summarized yet
    trimSummarized: true,   // drop summarized messages from the prompt
    overviewEnabled: true,
    overviewWords: 250,
    memoryWords: 120,
    responseLength: 800,
    topK: 3,
    recallBudget: 800,      // tokens for recalled memories (overview not counted)
    queryDepth: 4,          // last N messages used to decide what to recall
    includeLatest: true,
    style: 'auto',          // auto | single | rpg | custom
    sources: null,          // ordered list: 'main' or Connection Profile ids
    timeoutSec: 120,
    overviewPosition: 'prompt', // 'prompt' | 'chat'
    overviewDepth: 4,
    recallPosition: 'chat',
    recallDepth: 2,
    maxMessageChars: 3000,  // per message, in the summarizer's input
    prompt: PROMPT_SINGLE,  // used when style = custom
    overviewTemplate: '[Story so far]\n{{overview}}',
    recallTemplate: '[Memories from earlier in the story that matter now]\n{{memories}}',
    notify: true,
    carrySummarizeRest: true,
});

// ---------------------------------------------------------------- helpers

const ctx = () => SillyTavern.getContext();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clampInt = (v, lo, hi, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const wait = ms => new Promise(r => setTimeout(r, ms));
const errText = e => [e?.message || String(e), e?.cause?.message].filter(Boolean).join(' — ');

const toast = {
    ok: m => globalThis.toastr?.success(m, 'Memory Hub'),
    info: (m, o) => globalThis.toastr?.info(m, 'Memory Hub', o),
    warn: (m, o) => globalThis.toastr?.warning(m, 'Memory Hub', o),
    err: (m, o) => globalThis.toastr?.error(m, 'Memory Hub', o),
};

function settings() {
    const ext = ctx().extensionSettings;
    ext[MODULE] ??= {};
    const s = ext[MODULE];
    // migrate 1.0.0
    if (s.sources == null) s.sources = s.source === 'profile' && s.profileId ? [s.profileId, 'main'] : ['main'];
    if (s.style == null && s.prompt != null) s.style = s.prompt.trim() === PROMPT_V1.trim() ? 'auto' : 'custom';
    if (s.prompt != null && s.prompt.trim() === PROMPT_V1.trim()) s.prompt = PROMPT_SINGLE;
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined || (k === 'sources' && s[k] == null)) s[k] = v ?? ['main'];
    if (!Array.isArray(s.sources) || !s.sources.length) s.sources = ['main'];
    return s;
}
const saveSettings = () => ctx().saveSettingsDebounced();

/** @returns {{v:number, memories:any[], overview:string, lastEnd:number, baseOverview?:string, chain?:string[]}|null} */
function state() {
    const c = ctx();
    if (!c.chatId) return null;
    const meta = c.chatMetadata;
    if (!meta) return null;
    meta[MODULE] ??= { v: 1, memories: [], overview: '', lastEnd: -1 };
    const st = meta[MODULE];
    st.memories ??= [];
    st.overview ??= '';
    if (!Number.isInteger(st.lastEnd)) st.lastEnd = -1;
    return st;
}
const saveState = () => ctx().saveMetadataDebounced();

const tokenCache = new Map();
async function countTokens(text) {
    const s = String(text ?? '');
    if (!s) return 0;
    if (tokenCache.has(s)) return tokenCache.get(s);
    let n;
    try { n = await ctx().getTokenCountAsync(s); } catch { n = Math.ceil(s.length / 3); }
    if (tokenCache.size > 500) tokenCache.clear();
    tokenCache.set(s, n);
    return n;
}

const memoryBlock = m => `• ${m.title ? m.title + ': ' : ''}${String(m.text ?? '').trim()}`;
const isGroup = () => !!ctx().groupId;
const mainNames = () => {
    const c = ctx();
    const names = [c.name1, c.name2];
    if (c.groupId) {
        const g = c.groups?.find(x => x.id === c.groupId);
        for (const av of g?.members ?? []) names.push(c.characters?.find(ch => ch.avatar === av)?.name);
    }
    return names.filter(Boolean);
};

/** Newest memory: the last summarized chunk of this chat, else the last carried-over one. */
function latestOf(pool) {
    const autos = pool.filter(m => m.source === 'auto' && m.end >= 0).sort((a, b) => b.end - a.end);
    if (autos.length) return autos[0];
    return [...pool].reverse().find(m => m.source === 'carry') ?? null;
}

function effectiveStyle() {
    const s = settings();
    if (s.style === 'single' || s.style === 'rpg') return s.style;
    return isGroup() ? 'rpg' : 'single';
}

// ---------------------------------------------------------------- model calls (with fallback chain)

let lastApi = null; // { ok:boolean, label:string, error?:string, at:number, fallback?:boolean }

function profiles() {
    try { return ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? []; } catch { return []; }
}
function sourceLabel(id) {
    if (id === 'main') return 'API หลัก';
    const p = profiles().find(x => x.id === id);
    return p ? p.name : '(profile ที่ถูกลบ)';
}
function activeSources() {
    const known = new Set(profiles().map(p => p.id));
    const list = settings().sources.filter(id => id === 'main' || known.has(id));
    return list.length ? list : ['main'];
}

async function callOne(src, messages, maxTokens, timeoutMs) {
    const c = ctx();
    if (src === 'main') {
        let timer;
        const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`ไม่ตอบภายใน ${timeoutMs / 1000} วินาที`)), timeoutMs); });
        try {
            return await Promise.race([c.generateRaw({ prompt: structuredClone(messages), responseLength: maxTokens }), timeout]);
        } finally { clearTimeout(timer); }
    }
    const svc = c.ConnectionManagerRequestService;
    if (!svc) throw new Error('Connection Manager ไม่พร้อมใช้งาน');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await svc.sendRequest(src, structuredClone(messages), maxTokens, { stream: false, signal: ac.signal, extractData: true, includePreset: true });
        return typeof res === 'string' ? res : String(res?.content ?? '');
    } catch (e) {
        if (ac.signal.aborted) throw new Error(`ไม่ตอบภายใน ${timeoutMs / 1000} วินาที`);
        throw e;
    } finally { clearTimeout(timer); }
}

/**
 * Tries each API in order. An API "fails" when it throws, times out, or
 * answers without anything `accept` can use.
 */
async function callModel(system, user, maxTokens, accept = out => !!String(out ?? '').trim()) {
    const s = settings();
    const order = activeSources();
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const errors = [];
    for (let i = 0; i < order.length; i++) {
        const src = order[i];
        try {
            const out = await callOne(src, messages, maxTokens, s.timeoutSec * 1000);
            if (!String(out ?? '').trim()) throw new Error('ได้คำตอบว่าง (อาจโดน safety filter หรือโควต้าหมด)');
            if (!accept(out)) throw new Error('คำตอบไม่อยู่ในรูปแบบที่ต้องการ');
            if (i > 0) toast.warn(`${errors.join(' · ')}\n→ ใช้ ${sourceLabel(src)} แทนแล้ว`, { timeOut: 8000 });
            lastApi = { ok: true, label: sourceLabel(src), fallback: i > 0, at: Date.now() };
            return out;
        } catch (e) {
            console.warn(LOG, `API ${sourceLabel(src)} failed`, e);
            errors.push(`${sourceLabel(src)}: ${errText(e)}`);
        }
    }
    lastApi = { ok: false, label: sourceLabel(order[0]), error: errors.join(' · '), at: Date.now() };
    throw new Error(errors.join(' · '));
}

// ---------------------------------------------------------------- summarizing

let busy = null;          // Promise of the running summarization
let cancelRequested = false;
let lastInjection = null; // what the last generation received (for the preview)
let autoPausedUntil = 0;  // chat length; auto-summary waits after a failure

function transcript(start, end) {
    const { chat } = ctx();
    const max = settings().maxMessageChars;
    const lines = [];
    for (let i = start; i <= end && i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const text = cleanText(m.mes, max);
        if (!text) continue;
        lines.push(`${m.name || (m.is_user ? '{{user}}' : '{{char}}')}: ${text}`);
    }
    return lines.join('\n\n');
}

function fill(template, withOverview) {
    const s = settings();
    const rule = effectiveStyle() === 'rpg' ? OVERVIEW_RULE_RPG : OVERVIEW_RULE_SINGLE;
    const p = String(template)
        .replaceAll('{{overview_rule}}', withOverview ? rule : '')
        .replaceAll('{{overview_format}}', withOverview ? OVERVIEW_FORMAT : '')
        .replaceAll('{{overview_words}}', String(s.overviewWords))
        .replaceAll('{{memory_words}}', String(s.memoryWords));
    return ctx().substituteParams(p);
}

function summaryTemplate() {
    const s = settings();
    if (s.style === 'custom' && String(s.prompt ?? '').trim()) return s.prompt;
    return effectiveStyle() === 'rpg' ? PROMPT_RPG : PROMPT_SINGLE;
}

/** Summarizes chat[start..end] into one memory (and refreshes the overview). */
async function summarizeRange(start, end, { replaceId = null, updateOverview = true } = {}) {
    const s = settings();
    const st = state();
    if (!st) throw new Error('ยังไม่ได้เปิดแชท');
    const chatId = ctx().chatId;

    const body = transcript(start, end);
    if (!body.trim()) return null;

    const withOverview = s.overviewEnabled && updateOverview;
    const prev = latestOf(st.memories.filter(m => m.source !== 'auto' || m.end < start));
    const parts = [];
    if (withOverview) parts.push(`PREVIOUS OVERVIEW:\n${st.overview.trim() || '(none yet — this is the start of the story)'}`);
    if (prev) parts.push(`PREVIOUS MEMORY (for continuity, do not repeat it):\n${memoryBlock(prev)}`);
    parts.push(`NEW MESSAGES (#${start}–#${end}):\n${body}`);

    const raw = await callModel(fill(summaryTemplate(), withOverview), ctx().substituteParams(parts.join('\n\n')), s.responseLength,
        out => !!parseSummary(out).text);
    if (ctx().chatId !== chatId) throw new Error('เปลี่ยนแชทระหว่างสรุป ผลลัพธ์ถูกทิ้ง');

    const parsed = parseSummary(raw);
    const keys = cleanKeys(parsed.keys, mainNames());
    const cur = state();
    let mem;
    if (replaceId) {
        mem = cur.memories.find(m => m.id === replaceId);
        if (mem) Object.assign(mem, { title: parsed.title || mem.title, keys: keys.length ? keys : mem.keys, text: parsed.text, ts: Date.now() });
    }
    if (!mem) {
        mem = { id: uid(), start, end, title: parsed.title || `#${start}–#${end}`, keys, text: parsed.text, pinned: false, source: 'auto', ts: Date.now() };
        cur.memories.push(mem);
        cur.memories.sort((a, b) => (a.start - b.start) || (a.ts - b.ts));
        cur.lastEnd = Math.max(cur.lastEnd, end);
    }
    if (withOverview && parsed.overview) cur.overview = parsed.overview;
    if (!replaceId) mem.overviewAfter = cur.overview; // lets a branch restore the story-so-far of its time
    saveState();
    return mem;
}

/**
 * Summarizes chunk after chunk until the chat is caught up.
 * @param {{force?:boolean, quiet?:boolean, keepRaw?:number}} opt force = also take a last partial chunk
 * @returns {Promise<{made:number, failed:boolean}>}
 */
function runSummaries({ force = false, quiet = false, keepRaw = null } = {}) {
    if (busy) return busy.then(() => runSummaries({ force, quiet, keepRaw }));
    cancelRequested = false;
    busy = (async () => {
        let made = 0;
        let failed = false;
        let progress = null;
        try {
            for (;;) {
                if (cancelRequested) break;
                const st = state();
                if (!st) break;
                const s = settings();
                const chunk = nextChunk(st.lastEnd, ctx().chat.length, s.chunkSize, keepRaw ?? s.keepRaw, force);
                if (!chunk) break;
                if (!quiet || made > 0) {
                    if (progress) globalThis.toastr?.clear(progress);
                    progress = toast.info(`กำลังสรุปข้อความ #${chunk.start}–#${chunk.end}…`, { timeOut: 0, extendedTimeOut: 0 });
                }
                const mem = await summarizeRange(chunk.start, chunk.end);
                if (!mem) { state().lastEnd = chunk.end; saveState(); continue; }
                made++;
                refreshUi();
            }
        } catch (e) {
            failed = true;
            console.error(LOG, e);
            autoPausedUntil = ctx().chat.length + 4;
            toast.err(`สรุปไม่สำเร็จ ลองครบทุก API แล้ว:\n${errText(e)}`, { timeOut: 15000 });
        } finally {
            if (progress) globalThis.toastr?.clear(progress);
            busy = null;
            refreshUi();
        }
        if (made && (settings().notify || !quiet)) toast.ok(`สร้างความจำใหม่ ${made} ก้อน`);
        if (!made && !failed && !quiet && !cancelRequested) toast.info('ยังไม่มีข้อความที่ต้องสรุป (ข้อความล่าสุดจะถูกเก็บไว้แบบเต็มตามที่ตั้งไว้)');
        return { made, failed };
    })();
    return busy;
}

function onMessageReceived(_id, type) {
    const s = settings();
    if (!s.enabled || !s.autoSummarize || type === 'quiet') return;
    const st = state();
    if (!st) return;
    const len = ctx().chat.length;
    if (len < autoPausedUntil) return;
    if (!nextChunk(st.lastEnd, len, s.chunkSize, s.keepRaw)) return;
    runSummaries({ quiet: true });
}

/**
 * Keeps memories consistent with the chat. After a branch (or deleting
 * messages at the end), memories covering messages that no longer exist are
 * removed, the story-so-far goes back to what it was at that point, and the
 * cut part will be summarized again from the branch's own messages.
 */
function reconcile({ announce = false } = {}) {
    const st = state();
    if (!st) return;
    const len = ctx().chat.length;
    let changed = false;
    const before = st.memories.length;
    st.memories = st.memories.filter(m => m.source !== 'auto' || m.end <= len - 1);
    const dropped = before - st.memories.length;
    if (dropped) {
        const last = latestOf(st.memories.filter(m => m.source === 'auto'));
        st.lastEnd = last ? last.end : -1;
        st.overview = last ? (last.overviewAfter ?? st.overview) : (st.baseOverview ?? '');
        changed = true;
        if (announce) toast.info(`แชทนี้สั้นกว่าที่ความจำครอบคลุม (เช่น แตกกิ่ง) — ถอดความจำหลังจุดนั้นออก ${dropped} ก้อน และย้อนเรื่องย่อกลับไปตามจุดนั้นแล้ว`, { timeOut: 8000 });
    }
    if (st.lastEnd > len - 1) { st.lastEnd = len - 1; changed = true; }
    if (changed) { saveState(); refreshUi(); }
}

// ---------------------------------------------------------------- per-generation: trim + recall

function clearPrompts() {
    const c = ctx();
    c.setExtensionPrompt(KEY_OVERVIEW, '', 0, 0);
    c.setExtensionPrompt(KEY_RECALL, '', 0, 0);
}

function place(key, value, where, depth) {
    // 0 = IN_PROMPT (after the story string), 1 = IN_CHAT at depth
    if (where === 'chat') ctx().setExtensionPrompt(key, value, 1, depth, false, 0);
    else ctx().setExtensionPrompt(key, value, 0, 0, false, 0);
}

async function selectRecall(st, queryText) {
    const s = settings();
    const pool = st.memories.filter(m => String(m.text ?? '').trim());
    const why = new Map();
    if (!pool.length) return { picked: [], tokens: 0, why };

    const latest = latestOf(pool);
    const chosen = new Map();
    for (const m of pool) if (m.pinned) { chosen.set(m.id, m); why.set(m.id, ['📌']); }
    if (s.includeLatest && latest && !chosen.has(latest.id)) { chosen.set(latest.id, latest); why.set(latest.id, ['🕘 ล่าสุด']); }

    // Words shared by every memory (main characters' names) only add a little
    // score each; the floor keeps small talk from pulling in random memories.
    const all = rankMemories(pool, queryText);
    const floor = Math.max(1, (all[0]?.score ?? 0) * 0.35);
    let extra = 0;
    for (const r of all) {
        if (extra >= s.topK || r.score < floor) break;
        if (chosen.has(r.memory.id)) continue;
        chosen.set(r.memory.id, r.memory);
        why.set(r.memory.id, r.hits.slice(0, 6));
        extra++;
    }

    // budget: pinned first, then the latest, then by relevance
    const picked = [];
    let tokens = 0;
    for (const m of chosen.values()) {
        const t = await countTokens(memoryBlock(m));
        if (tokens + t > s.recallBudget && picked.length) continue;
        if (t > s.recallBudget && !m.pinned) continue;
        picked.push(m);
        tokens += t;
    }
    const order = new Map(st.memories.map((m, i) => [m.id, i]));
    picked.sort((a, b) => order.get(a.id) - order.get(b.id));
    return { picked, tokens, why };
}

let savedCache = { chatId: null, lastEnd: -2, tokens: 0 };
/** Rough size of the messages we stopped sending (counted once per summary). */
async function savedTokens(lastEnd) {
    const c = ctx();
    if (savedCache.chatId === c.chatId && savedCache.lastEnd === lastEnd) return savedCache.tokens;
    const text = c.chat.slice(0, lastEnd + 1).filter(m => !m.is_system).map(m => m.mes).join('\n');
    let tokens;
    try { tokens = await c.getTokenCountAsync(text); } catch { tokens = Math.ceil(text.length / 3); }
    savedCache = { chatId: c.chatId, lastEnd, tokens };
    return tokens;
}

async function intercept(chat, _contextSize, _abort, type) {
    const s = settings();
    clearPrompts();
    if (!s.enabled) { lastInjection = null; return; }

    // A chunk may be summarizing right now: let it land first, so this prompt
    // already benefits from it.
    if (busy) await Promise.race([busy, wait(s.timeoutSec * 1000 * Math.max(1, activeSources().length))]);

    const st = state();
    if (!st) return;
    reconcile();

    const full = ctx().chat;

    // 1. drop messages already covered by memories (prompt only; the chat is untouched)
    let trimmed = 0;
    if (s.trimSummarized && st.lastEnd >= 0 && st.memories.some(m => m.source === 'auto')) {
        let n = 0;
        for (let i = 0; i <= st.lastEnd && i < full.length; i++) if (!full[i].is_system) n++;
        // always leave the newest keepRaw messages, even if messages were deleted
        // in the middle and the summarized range no longer lines up
        n = Math.min(n, Math.max(0, chat.length - Math.max(2, s.keepRaw)));
        if (n > 0) { chat.splice(0, n); trimmed = n; }
    }

    // 2. overview
    let overviewText = '';
    if (s.overviewEnabled && st.overview.trim()) {
        overviewText = String(s.overviewTemplate || '{{overview}}').replaceAll('{{overview}}', st.overview.trim());
        place(KEY_OVERVIEW, overviewText, s.overviewPosition, s.overviewDepth);
    }

    // 3. recall
    const recent = full.filter(m => !m.is_system).slice(-Math.max(1, s.queryDepth));
    const query = recent.map(m => cleanText(m.mes, 4000)).join('\n');
    const { picked, tokens, why } = await selectRecall(st, query);
    let recallText = '';
    if (picked.length) {
        recallText = String(s.recallTemplate || '{{memories}}').replaceAll('{{memories}}', picked.map(memoryBlock).join('\n'));
        place(KEY_RECALL, recallText, s.recallPosition, s.recallDepth);
    }

    lastInjection = {
        at: Date.now(),
        type,
        trimmed,
        trimmedTokens: trimmed ? await savedTokens(st.lastEnd) : 0,
        overviewText,
        overviewTokens: await countTokens(overviewText),
        recallText,
        recallTokens: tokens,
        picked: picked.map(m => ({ id: m.id, title: m.title, why: why.get(m.id) ?? [] })),
    };
    refreshUi();
}
globalThis.memoryHub_intercept = intercept;

// ---------------------------------------------------------------- continue in a new chat

async function continueInNewChat() {
    const c = ctx();
    const st = state();
    if (!st) return toast.warn('เปิดแชทก่อน');
    const s = settings();

    const box = document.createElement('div');
    box.className = 'mh_carry';
    box.innerHTML = `
      <h3>เริ่มแชทใหม่ต่อเรื่องเดิม</h3>
      <p>สร้างแชทใหม่กับตัวละครนี้ โดยพกความจำทั้งหมด (${st.memories.length} ก้อน) และเรื่องย่อไปด้วย
      แล้วใช้ <b>ข้อความล่าสุดของบอท</b> ในแชทนี้เป็นข้อความแรกของแชทใหม่</p>
      <label class="checkbox_label"><input type="checkbox" class="mh_carry_rest"> สรุปข้อความที่ยังไม่ได้สรุปให้หมดก่อน (แนะนำ ไม่งั้นข้อความ ${Math.max(0, c.chat.length - 1 - st.lastEnd)} ข้อความล่าสุดจะไม่ถูกจำ)</label>
      <small>แชทเดิมไม่ถูกแก้ไข เปิดกลับไปได้ตามปกติ</small>`;
    const restBox = box.querySelector('.mh_carry_rest');
    restBox.checked = !!s.carrySummarizeRest;
    const ok = await c.callGenericPopup(box, c.POPUP_TYPE.CONFIRM, '', { okButton: 'เริ่มแชทใหม่', cancelButton: 'ยกเลิก' });
    if (!ok) return;
    s.carrySummarizeRest = restBox.checked; saveSettings();

    if (restBox.checked) {
        const res = await runSummaries({ force: true, keepRaw: 0 });
        if (res?.failed) {
            const go = await c.callGenericPopup('สรุปข้อความที่เหลือไม่สำเร็จ ยังจะเริ่มแชทใหม่ต่อไหม? (ข้อความที่ยังไม่สรุปจะไม่ถูกพกไป)', c.POPUP_TYPE.CONFIRM);
            if (!go) return;
        }
    }

    const oldId = c.getCurrentChatId();
    const old = structuredClone(state());
    const lastBot = [...c.chat].reverse().find(m => !m.is_user && !m.is_system && String(m.mes ?? '').trim());

    await c.executeSlashCommandsWithOptions('/newchat');
    for (let i = 0; i < 50 && ctx().getCurrentChatId() === oldId; i++) await wait(200);
    if (ctx().getCurrentChatId() === oldId) return toast.err('สร้างแชทใหม่ไม่สำเร็จ');
    await wait(600); // let the greeting land

    const n = ctx();
    n.chatMetadata[MODULE] = {
        v: 1,
        overview: old.overview,
        baseOverview: old.overview,
        lastEnd: -1,
        chain: [...(old.chain ?? []), oldId],
        memories: old.memories.map(m => {
            const { overviewAfter: _drop, ...rest } = m;
            return {
                ...rest,
                source: m.source === 'auto' ? 'carry' : m.source,
                origin: m.origin ?? (m.end >= 0 ? { chat: oldId, start: m.start, end: m.end } : undefined),
                start: -1,
                end: -1,
            };
        }),
    };

    if (lastBot) {
        const base = n.chat[0] && !n.chat[0].is_user ? n.chat[0] : { is_user: false, is_system: false };
        const msg = {
            ...base,
            name: lastBot.name,
            is_user: false,
            is_system: false,
            mes: lastBot.mes,
            swipes: [lastBot.mes],
            swipe_id: 0,
            send_date: n.humanizedDateTime?.() ?? base.send_date,
            extra: {},
        };
        delete msg.swipe_info;
        if (lastBot.original_avatar) msg.original_avatar = lastBot.original_avatar;
        if (lastBot.force_avatar) msg.force_avatar = lastBot.force_avatar;
        n.chat.splice(0, n.chat.length, msg);
    }
    await n.saveChat();
    await n.reloadCurrentChat();
    toast.ok(`เริ่มแชทใหม่แล้ว พกความจำมา ${old.memories.length} ก้อน`);
}

// ---------------------------------------------------------------- import + optimize

async function listOtherChats() {
    const c = ctx();
    if (c.groupId) {
        const g = c.groups?.find(x => x.id === c.groupId);
        return (g?.chats ?? []).filter(id => id !== c.getCurrentChatId()).map(id => ({ id, label: id }));
    }
    const ch = c.characters?.[c.characterId];
    if (!ch) return [];
    const res = await fetch('/api/characters/chats', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ avatar_url: ch.avatar, simple: true }) });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(x => String(x.file_id ?? x.file_name ?? '').replace(/\.jsonl$/, ''))
        .filter(id => id && id !== c.getCurrentChatId())
        .sort().reverse()
        .map(id => ({ id, label: id }));
}

async function readChatState(id) {
    const c = ctx();
    let res;
    if (c.groupId) {
        res = await fetch('/api/chats/group/get', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ id }) });
    } else {
        const ch = c.characters?.[c.characterId];
        res = await fetch('/api/chats/get', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ ch_name: ch.name, file_name: id, avatar_url: ch.avatar }) });
    }
    if (!res.ok) throw new Error(`โหลดแชทไม่ได้ (${res.status})`);
    const data = await res.json();
    const head = Array.isArray(data) ? data[0] : null;
    return head?.chat_metadata?.[MODULE] ?? null;
}

async function importFromChat(id) {
    const other = await readChatState(id);
    if (!other?.memories?.length && !other?.overview) return toast.warn('แชทนั้นไม่มีความจำของ Memory Hub');
    const st = state();
    const seen = new Set(st.memories.map(m => m.text));
    let n = 0;
    const incoming = other.memories.filter(m => !seen.has(m.text)).map(m => {
        const { overviewAfter: _drop, ...rest } = m;
        n++;
        return { ...rest, id: uid(), source: m.source === 'auto' ? 'carry' : m.source, origin: m.origin ?? (m.end >= 0 ? { chat: id, start: m.start, end: m.end } : undefined), start: -1, end: -1 };
    });
    // carried memories come before this chat's own ones
    const firstOwn = st.memories.findIndex(m => m.source === 'auto');
    st.memories.splice(firstOwn < 0 ? st.memories.length : firstOwn, 0, ...incoming);
    if (!st.overview.trim() && other.overview) { st.overview = other.overview; st.baseOverview = other.overview; }
    st.chain = [...new Set([...(other.chain ?? []), id, ...(st.chain ?? [])])];
    saveState();
    toast.ok(`นำเข้า ${n} ก้อนจาก ${id}`);
    refreshUi();
}

async function importFromBook(name, skipOff) {
    const c = ctx();
    const data = await c.loadWorldInfo(name);
    const entries = Object.values(data?.entries ?? {}).filter(x => String(x.content ?? '').trim() && !(skipOff && x.disable));
    const st = state();
    const seen = new Set(st.memories.map(m => m.text));
    const names = mainNames();
    let n = 0;
    const incoming = [];
    for (const x of entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.uid - b.uid))) {
        const text = cleanText(x.content);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        const title = String(x.comment || (x.key ?? []).join(', ') || `#${x.uid}`).replace(/\s+/g, ' ').trim().slice(0, 120);
        incoming.push({ id: uid(), start: -1, end: -1, title, keys: cleanKeys((x.key ?? []).map(String), names), text, pinned: !!x.constant, source: 'import', ts: Date.now() + n });
        n++;
    }
    const firstOwn = st.memories.findIndex(m => m.source === 'auto');
    st.memories.splice(firstOwn < 0 ? st.memories.length : firstOwn, 0, ...incoming);
    saveState();
    refreshUi();
    return { n, skipped: entries.length - n };
}

/** Rewrites long imported memories into the compact format, a few per call. */
async function optimizeImported({ onlyLong = true } = {}) {
    const s = settings();
    const st = state();
    if (!st) return;
    const limit = s.memoryWords * 3; // tokens; Thai runs ~2-3 tokens per word
    const targets = [];
    for (const m of st.memories.filter(x => x.source === 'import' && !x.optimized)) {
        if (!onlyLong || await countTokens(m.text) > limit) targets.push(m);
        else m.optimized = true;
    }
    if (!targets.length) { saveState(); return toast.info('ไม่มีความจำที่นำเข้าที่ยาวเกินไป'); }

    const batches = [];
    let cur = [];
    let size = 0;
    for (const m of targets) {
        const t = await countTokens(m.text);
        if (cur.length && (cur.length >= 6 || size + t > 5000)) { batches.push(cur); cur = []; size = 0; }
        cur.push(m); size += t;
    }
    if (cur.length) batches.push(cur);

    const system = fill(PROMPT_OPTIMIZE, false);
    let done = 0;
    let progress = null;
    cancelRequested = false;
    busy = (async () => {
        try {
            for (const [bi, batch] of batches.entries()) {
                if (cancelRequested) break;
                if (progress) globalThis.toastr?.clear(progress);
                progress = toast.info(`จัดระเบียบความจำที่นำเข้า ชุด ${bi + 1}/${batches.length}…`, { timeOut: 0, extendedTimeOut: 0 });
                const user = batch.map((m, i) => `MEMORY id="${i}":\ntitle: ${m.title}\nkeys: ${(m.keys ?? []).join(', ')}\n${cleanText(m.text, 12000)}`).join('\n\n');
                const raw = await callModel(system, ctx().substituteParams(user), Math.min(4000, 350 * batch.length + 200), out => parseMany(out).size > 0);
                const got = parseMany(raw);
                batch.forEach((m, i) => {
                    const r = got.get(String(i));
                    if (!r) return;
                    m.title = r.title || m.title;
                    m.keys = cleanKeys(r.keys.length ? r.keys : m.keys, mainNames());
                    m.text = r.text;
                    m.optimized = true;
                    done++;
                });
                saveState();
            }
        } catch (e) {
            toast.err(`จัดระเบียบไม่สำเร็จ: ${errText(e)}`, { timeOut: 15000 });
        } finally {
            if (progress) globalThis.toastr?.clear(progress);
            busy = null;
        }
    })();
    await busy;
    refreshUi();
    if (done) toast.ok(`ย่อความจำที่นำเข้าแล้ว ${done}/${targets.length} ก้อน`);
    if (done && !state()?.overview.trim()) await rebuildOverview();
}

/** Writes the story-so-far from all memories, folding a batch at a time. */
async function rebuildOverview() {
    const s = settings();
    const st = state();
    if (!st?.memories.length) return toast.info('ยังไม่มีความจำ');
    const batches = [];
    let cur = [];
    let size = 0;
    for (const m of st.memories) {
        const t = await countTokens(memoryBlock(m));
        if (cur.length && size + t > 6000) { batches.push(cur); cur = []; size = 0; }
        cur.push(m); size += t;
    }
    if (cur.length) batches.push(cur);
    let overview = '';
    let progress = null;
    busy = (async () => {
        try {
            for (const [bi, batch] of batches.entries()) {
                if (progress) globalThis.toastr?.clear(progress);
                progress = toast.info(`สร้างเรื่องย่อใหม่ ${bi + 1}/${batches.length}…`, { timeOut: 0, extendedTimeOut: 0 });
                const user = `PREVIOUS OVERVIEW:\n${overview || '(none yet)'}\n\nMEMORIES:\n${batch.map(memoryBlock).join('\n')}`;
                const raw = await callModel(fill(PROMPT_REBUILD, true), ctx().substituteParams(user), s.responseLength, out => !!parseSummary(out).overview);
                overview = parseSummary(raw).overview || overview;
            }
            const now = state();
            now.overview = overview;
            if (!now.memories.some(m => m.source === 'auto')) now.baseOverview = overview;
            saveState();
            toast.ok('สร้างเรื่องย่อใหม่แล้ว');
        } catch (e) {
            toast.err(`สร้างเรื่องย่อไม่สำเร็จ: ${errText(e)}`, { timeOut: 15000 });
        } finally {
            if (progress) globalThis.toastr?.clear(progress);
            busy = null;
        }
    })();
    await busy;
    refreshUi();
}

// ---------------------------------------------------------------- settings panel

function numberRow(id, label, hint, min, max) {
    return `<label class="mh_row" title="${esc(hint)}"><span>${label}</span><input type="number" class="text_pole" id="${id}" min="${min}" max="${max}"></label>`;
}

function renderSettings() {
    const html = `
    <div class="memory-hub-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Memory Hub <small class="mh_version">v${VERSION}</small></b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div id="mh_status" class="mh_status"></div>
          <div class="mh_btns">
            <div class="menu_button" id="mh_open"><i class="fa-solid fa-brain"></i> เปิดคลังความจำ</div>
            <div class="menu_button" id="mh_now"><i class="fa-solid fa-wand-magic-sparkles"></i> สรุปตอนนี้</div>
            <div class="menu_button" id="mh_last"><i class="fa-solid fa-eye"></i> ดูสิ่งที่ส่งล่าสุด</div>
            <div class="menu_button" id="mh_carry"><i class="fa-solid fa-forward"></i> เริ่มแชทใหม่ต่อเรื่อง</div>
          </div>
          <div id="mh_warn" class="mh_warn"></div>

          <label class="checkbox_label"><input type="checkbox" id="mh_enabled"> เปิดใช้งาน</label>
          <label class="checkbox_label"><input type="checkbox" id="mh_auto"> สรุปอัตโนมัติเมื่อข้อความครบรอบ</label>
          <label class="checkbox_label" title="ข้อความที่สรุปแล้วจะไม่ถูกส่งซ้ำ ประหยัดที่สุด แชทจริงไม่ถูกลบหรือซ่อน"><input type="checkbox" id="mh_trim"> ไม่ส่งข้อความที่สรุปแล้ว (ประหยัดโทเคนมากที่สุด)</label>
          <label class="checkbox_label"><input type="checkbox" id="mh_overview"> มี "เรื่องย่อจนถึงตอนนี้" หนึ่งก้อน</label>
          <label class="checkbox_label"><input type="checkbox" id="mh_latest"> ใส่ความจำก้อนล่าสุดเสมอ (ต่อเนื่องกับข้อความดิบ)</label>
          <label class="checkbox_label"><input type="checkbox" id="mh_notify"> แจ้งเตือนเมื่อสร้างความจำใหม่</label>

          <h4>สไตล์การสรุป</h4>
          <label class="mh_row"><span>แบบ</span>
            <select id="mh_style" class="text_pole">
              ${Object.entries(STYLE_LABEL).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}
            </select></label>
          <small id="mh_style_hint" class="mh_hint"></small>

          <h4>จังหวะการสรุป</h4>
          ${numberRow('mh_chunk', 'สรุปทีละ (ข้อความ)', 'ทุก ๆ กี่ข้อความถึงจะสรุปหนึ่งครั้ง ยิ่งมากยิ่งเรียก API น้อย', 4, 200)}
          ${numberRow('mh_keep', 'เก็บข้อความล่าสุดแบบเต็ม', 'ข้อความใหม่สุดกี่ข้อความที่จะยังไม่ถูกสรุป และส่งแบบเต็มเสมอ', 2, 200)}
          ${numberRow('mh_memwords', 'ความยาวความจำ (คำ)', 'ความยาวสูงสุดของความจำแต่ละก้อน', 30, 600)}
          ${numberRow('mh_ovwords', 'ความยาวเรื่องย่อ (คำ)', 'ความยาวสูงสุดของเรื่องย่อจนถึงตอนนี้', 50, 1500)}
          ${numberRow('mh_resp', 'Response length ตอนสรุป (โทเคน)', 'เพดานคำตอบของโมเดลตอนสรุป', 200, 8000)}

          <h4>การดึงความจำ</h4>
          ${numberRow('mh_topk', 'ดึงความจำที่เกี่ยวข้องสูงสุด (ก้อน)', 'ไม่นับก้อนล่าสุดและก้อนที่ปักหมุด', 0, 20)}
          ${numberRow('mh_budget', 'งบโทเคนของความจำที่ดึง', 'รวมทุกก้อนที่ดึงมา (ไม่นับเรื่องย่อ)', 100, 8000)}
          ${numberRow('mh_qdepth', 'ดูบริบทจากข้อความล่าสุด (ข้อความ)', 'ใช้ข้อความล่าสุดกี่ข้อความเป็นตัวตัดสินว่าอะไรเกี่ยวข้อง', 1, 20)}

          <h4>API ที่ใช้สรุป (เรียงตามลำดับ ตัวแรกพังจะใช้ตัวถัดไป)</h4>
          <div id="mh_sources" class="mh_sources"></div>
          <div class="mh_btns"><div class="menu_button" id="mh_src_add"><i class="fa-solid fa-plus"></i> เพิ่ม API สำรอง</div></div>
          ${numberRow('mh_timeout', 'รอคำตอบนานสุด (วินาที)', 'เกินนี้ถือว่าพัง แล้วไปใช้ตัวถัดไป', 15, 600)}
          <small class="mh_hint">API สำรองคือ Connection Profile — สร้างที่แท็บ API Connections → Connection Profile (เช่น Google AI Studio หนึ่งอัน, DeepSeek หนึ่งอัน)</small>

          <div class="inline-drawer mh_adv">
            <div class="inline-drawer-toggle inline-drawer-header"><span>ขั้นสูง: ตำแหน่งและข้อความ prompt</span><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
              <label class="mh_row"><span>ตำแหน่งเรื่องย่อ</span>
                <select id="mh_ovpos" class="text_pole"><option value="prompt">ต่อจาก Story string / Char (แนะนำ)</option><option value="chat">ในแชทที่ depth</option></select></label>
              ${numberRow('mh_ovdepth', 'depth ของเรื่องย่อ', 'ใช้เมื่อเลือกตำแหน่งในแชท', 0, 50)}
              <label class="mh_row"><span>ตำแหน่งความจำที่ดึง</span>
                <select id="mh_recpos" class="text_pole"><option value="chat">ในแชทที่ depth (แนะนำ ถ้าใช้ prompt caching)</option><option value="prompt">ต่อจาก Story string / Char</option></select></label>
              ${numberRow('mh_recdepth', 'depth ของความจำที่ดึง', '0 = ท้ายสุด, 2 = ก่อนข้อความล่าสุด 2 ข้อความ', 0, 50)}
              ${numberRow('mh_maxchars', 'ตัดข้อความยาวเกิน (ตัวอักษร) ตอนส่งไปสรุป', 'กันข้อความที่มี status panel ยาว ๆ กินโทเคน', 500, 50000)}
              <label>แม่แบบเรื่องย่อ <small>(ใช้ {{overview}})</small></label>
              <textarea id="mh_ovtpl" class="text_pole" rows="2"></textarea>
              <label>แม่แบบความจำที่ดึง <small>(ใช้ {{memories}})</small></label>
              <textarea id="mh_rectpl" class="text_pole" rows="2"></textarea>
              <div id="mh_prompt_box">
                <label>Prompt ที่ใช้สรุป (สไตล์ "กำหนดเอง")</label>
                <textarea id="mh_prompt" class="text_pole" rows="12"></textarea>
                <div class="mh_btns">
                  <div class="menu_button" id="mh_prompt_single">เริ่มจากแบบคาร์เดียว</div>
                  <div class="menu_button" id="mh_prompt_rpg">เริ่มจากแบบ RPG</div>
                </div>
                <small class="mh_hint">ใช้ได้: {{memory_words}} {{overview_words}} {{overview_rule}} {{overview_format}} {{char}} {{user}} — ต้องคงรูปแบบคำตอบ &lt;memory&gt; ไว้</small>
              </div>
            </div>
          </div>
          <small class="mh_note">คำสั่ง <code>/memhub</code> เปิดคลังความจำ · <code>/memhub-now</code> สรุปทันที · <code>/memhub-continue</code> เริ่มแชทใหม่ต่อเรื่อง — ใช้ทำปุ่มใน Quick Dock ได้</small>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);

    const s = settings();
    const bindCheck = (id, key) => $(id).prop('checked', !!s[key]).on('change', function () { s[key] = this.checked; saveSettings(); refreshUi(); });
    const bindNum = (id, key, lo, hi) => $(id).val(s[key]).on('change', function () { s[key] = clampInt(this.value, lo, hi, DEFAULTS[key]); this.value = s[key]; saveSettings(); refreshUi(); });
    const bindVal = (id, key) => $(id).val(s[key]).on('change input', function () { s[key] = this.value; saveSettings(); refreshUi(); });

    bindCheck('#mh_enabled', 'enabled');
    bindCheck('#mh_auto', 'autoSummarize');
    bindCheck('#mh_trim', 'trimSummarized');
    bindCheck('#mh_overview', 'overviewEnabled');
    bindCheck('#mh_latest', 'includeLatest');
    bindCheck('#mh_notify', 'notify');
    bindNum('#mh_chunk', 'chunkSize', 4, 200);
    bindNum('#mh_keep', 'keepRaw', 2, 200);
    bindNum('#mh_memwords', 'memoryWords', 30, 600);
    bindNum('#mh_ovwords', 'overviewWords', 50, 1500);
    bindNum('#mh_resp', 'responseLength', 200, 8000);
    bindNum('#mh_topk', 'topK', 0, 20);
    bindNum('#mh_budget', 'recallBudget', 100, 8000);
    bindNum('#mh_qdepth', 'queryDepth', 1, 20);
    bindNum('#mh_timeout', 'timeoutSec', 15, 600);
    bindNum('#mh_ovdepth', 'overviewDepth', 0, 50);
    bindNum('#mh_recdepth', 'recallDepth', 0, 50);
    bindNum('#mh_maxchars', 'maxMessageChars', 500, 50000);
    bindVal('#mh_ovpos', 'overviewPosition');
    bindVal('#mh_recpos', 'recallPosition');
    bindVal('#mh_ovtpl', 'overviewTemplate');
    bindVal('#mh_rectpl', 'recallTemplate');
    bindVal('#mh_prompt', 'prompt');

    $('#mh_style').val(s.style).on('change', function () {
        const prev = s.style;
        s.style = this.value;
        // RPG needs room for more characters and threads
        if (this.value === 'rpg' && prev !== 'rpg') {
            if (s.memoryWords === 120) { s.memoryWords = 180; $('#mh_memwords').val(180); }
            if (s.overviewWords === 250) { s.overviewWords = 400; $('#mh_ovwords').val(400); }
            if (s.responseLength < 1200) { s.responseLength = 1200; $('#mh_resp').val(1200); }
        }
        saveSettings(); refreshUi();
    });
    $('#mh_prompt_single').on('click', () => { s.prompt = PROMPT_SINGLE; $('#mh_prompt').val(s.prompt); saveSettings(); });
    $('#mh_prompt_rpg').on('click', () => { s.prompt = PROMPT_RPG; $('#mh_prompt').val(s.prompt); saveSettings(); });

    $('#mh_src_add').on('click', () => {
        const used = new Set(s.sources);
        const next = profiles().find(p => !used.has(p.id))?.id ?? (used.has('main') ? null : 'main');
        if (!next) return toast.info('ไม่มี Connection Profile ที่ยังไม่ได้ใช้ สร้างเพิ่มที่แท็บ API Connections ก่อน');
        s.sources.push(next); saveSettings(); renderSources();
    });
    $('#mh_sources').on('change', 'select', function () {
        s.sources[Number(this.dataset.i)] = this.value; saveSettings(); refreshUi();
    }).on('click', '.mh_src_up, .mh_src_del', function () {
        const i = Number(this.dataset.i);
        if (this.classList.contains('mh_src_up') && i > 0) [s.sources[i - 1], s.sources[i]] = [s.sources[i], s.sources[i - 1]];
        if (this.classList.contains('mh_src_del') && s.sources.length > 1) s.sources.splice(i, 1);
        saveSettings(); renderSources(); refreshUi();
    }).on('focus mousedown', 'select', renderSourcesOptionsOnly);

    $('#mh_open').on('click', openManager);
    $('#mh_now').on('click', summarizeNow);
    $('#mh_last').on('click', showLastInjection);
    $('#mh_carry').on('click', continueInNewChat);
    renderSources();
    refreshUi();
}

function sourceOptions(selected) {
    const opts = [['main', 'API หลักที่ใช้แชทอยู่'], ...profiles().map(p => [p.id, `Profile: ${p.name}`])];
    if (selected && !opts.some(o => o[0] === selected)) opts.push([selected, '(profile ที่ถูกลบ — จะถูกข้าม)']);
    return opts.map(([v, l]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('');
}
function renderSources() {
    const s = settings();
    $('#mh_sources').html(s.sources.map((id, i) => `
      <div class="mh_src">
        <span class="mh_src_n">${i + 1}.</span>
        <select class="text_pole" data-i="${i}">${sourceOptions(id)}</select>
        <i class="fa-solid fa-arrow-up mh_icon mh_src_up${i === 0 ? ' mh_off' : ''}" data-i="${i}" title="เลื่อนขึ้น"></i>
        <i class="fa-solid fa-xmark mh_icon mh_src_del${s.sources.length < 2 ? ' mh_off' : ''}" data-i="${i}" title="ลบ"></i>
      </div>`).join(''));
}
function renderSourcesOptionsOnly() {
    // profiles may have been created since the panel was drawn
    const sel = this;
    const i = Number(sel.dataset.i);
    const val = settings().sources[i];
    if (sel.options.length !== profiles().length + 1 + (val !== 'main' && !profiles().some(p => p.id === val) ? 1 : 0)) sel.innerHTML = sourceOptions(val);
}

function refreshUi() {
    const s = settings();
    const st = state();
    $('#mh_ovdepth').closest('.mh_row').toggle(s.overviewPosition === 'chat');
    $('#mh_recdepth').closest('.mh_row').toggle(s.recallPosition === 'chat');
    $('#mh_prompt_box').toggle(s.style === 'custom');
    const effective = effectiveStyle();
    $('#mh_style_hint').text(`${STYLE_LABEL[s.style]?.[1] ?? ''}${s.style === 'auto' ? ` — ตอนนี้ใช้: ${STYLE_LABEL[effective][0]}` : ''}`);

    let status;
    if (!st) status = 'ยังไม่ได้เปิดแชท';
    else {
        const len = ctx().chat.length;
        const pending = Math.max(0, len - 1 - st.lastEnd);
        status = `ความจำ <b>${st.memories.length}</b> ก้อน · สรุปแล้วถึงข้อความ <b>#${st.lastEnd}</b> · ยังไม่สรุป <b>${pending}</b> ข้อความ`;
        if (st.chain?.length) status += ` · ต่อมาจาก ${st.chain.length} แชทก่อนหน้า`;
        if (busy) status += ' · <i class="fa-solid fa-spinner fa-spin"></i> กำลังทำงาน';
        if (lastInjection) {
            status += `<br>ครั้งล่าสุด: ส่งเรื่องย่อ ${lastInjection.overviewTokens} + ความจำ ${lastInjection.picked.length} ก้อน ${lastInjection.recallTokens} โทเคน`;
            if (lastInjection.trimmed) status += ` · ไม่ส่งข้อความเก่า ${lastInjection.trimmed} ข้อความ (ประหยัด ~${lastInjection.trimmedTokens} โทเคน)`;
        }
        if (lastApi) {
            status += lastApi.ok
                ? `<br><span class="mh_ok">✔ สรุปล่าสุดด้วย ${esc(lastApi.label)}${lastApi.fallback ? ' (สำรอง)' : ''}</span>`
                : `<br><span class="mh_bad">✖ สรุปล่าสุดล้มเหลว: ${esc(lastApi.error)}</span>`;
        }
    }
    $('#mh_status').html(status);
    $('#mh_now').toggleClass('disabled', !!busy);

    const warns = [];
    const c = ctx();
    if (c.extensionPrompts?.['1_memory']?.value?.trim()) warns.push('Summarize ในตัวของ SillyTavern ยังส่งบทสรุปอยู่ ถ้าใช้ Memory Hub แทน ให้ปิดตัวนั้น (Summarize → Pause หรือปิดส่วนขยาย) ไม่งั้นจะเสียโทเคนซ้ำสองทาง');
    if (!hasSegmenter()) warns.push('เบราว์เซอร์นี้ไม่มีตัวตัดคำ (Intl.Segmenter) จะใช้วิธีสำรองซึ่งแม่นน้อยกว่า');
    const missing = s.sources.filter(id => id !== 'main' && !profiles().some(p => p.id === id));
    if (missing.length) warns.push(`มี Connection Profile ในรายการ API ที่หาไม่เจอ ${missing.length} อัน (จะถูกข้าม)`);
    $('#mh_warn').html(warns.map(w => `<div><i class="fa-solid fa-triangle-exclamation"></i> ${esc(w)}</div>`).join(''));

    if (managerEl?.isConnected) renderManagerHeader();
}

// ---------------------------------------------------------------- actions

async function summarizeNow() {
    if (!state()) return toast.warn('เปิดแชทก่อน');
    if (busy) return toast.info('กำลังทำงานอยู่');
    autoPausedUntil = 0;
    await runSummaries({ force: true });
}

async function showLastInjection() {
    const li = lastInjection;
    const { Popup, POPUP_TYPE } = ctx();
    if (!li) return toast.info('ยังไม่มีการส่งข้อความตั้งแต่เปิดแชทนี้ ลองส่งหรือ swipe หนึ่งครั้ง');
    const rows = li.picked.map(p => `<li><b>${esc(p.title)}</b> <small>${esc(p.why.join(' · '))}</small></li>`).join('');
    const html = `<div class="mh_preview">
      <h3>สิ่งที่ Memory Hub ใส่ใน prompt ล่าสุด</h3>
      <p>ไม่ส่งข้อความที่สรุปแล้ว <b>${li.trimmed}</b> ข้อความ (~${li.trimmedTokens} โทเคน) ·
         เรื่องย่อ <b>${li.overviewTokens}</b> โทเคน · ความจำที่ดึง <b>${li.recallTokens}</b> โทเคน</p>
      ${rows ? `<h4>ความจำที่ถูกเลือก (เหตุผล)</h4><ul>${rows}</ul>` : ''}
      ${li.overviewText ? `<h4>เรื่องย่อ</h4><pre>${esc(li.overviewText)}</pre>` : ''}
      ${li.recallText ? `<h4>ความจำ</h4><pre>${esc(li.recallText)}</pre>` : ''}
    </div>`;
    await new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true }).show();
}

// ---------------------------------------------------------------- memory manager

let managerEl = null;
let managerFilter = '';

function renderManagerHeader() {
    const st = state();
    const el = managerEl?.querySelector('.mh_mgr_status');
    if (!el || !st) return;
    const len = ctx().chat.length;
    const imported = st.memories.filter(m => m.source === 'import').length;
    const carried = st.memories.filter(m => m.source === 'carry').length;
    el.innerHTML = `ความจำ <b>${st.memories.length}</b> ก้อน${carried ? ` (จากแชทก่อน ${carried})` : ''}${imported ? ` (นำเข้า ${imported})` : ''} · สรุปแล้วถึง #${st.lastEnd} จาก ${len} ข้อความ${busy ? ' · <i class="fa-solid fa-spinner fa-spin"></i> กำลังทำงาน <a href="#" class="mh_cancel">หยุด</a>' : ''}`;
    el.querySelector('.mh_cancel')?.addEventListener('click', e => { e.preventDefault(); cancelRequested = true; toast.info('จะหยุดหลังก้อนนี้เสร็จ'); });
}

function memoryCard(m, recalled) {
    const range = m.end >= 0 ? `#${m.start}–#${m.end}`
        : m.source === 'carry' ? `จากแชทก่อน${m.origin ? ` #${m.origin.start}–#${m.origin.end}` : ''}`
            : m.source === 'import' ? `นำเข้า${m.optimized ? ' ✓' : ''}` : 'เพิ่มเอง';
    return `<div class="mh_card${m.pinned ? ' mh_pinned' : ''}${recalled ? ' mh_recalled' : ''}" data-id="${esc(m.id)}">
      <div class="mh_card_head">
        <input class="text_pole mh_title" value="${esc(m.title)}" placeholder="ชื่อ">
        <span class="mh_range" title="${esc(m.origin?.chat ?? '')}">${esc(range)}</span>
        <i class="fa-solid fa-thumbtack mh_icon mh_pin" title="ปักหมุด: ใส่ใน prompt ทุกครั้ง"></i>
        ${m.end >= 0 && m.source === 'auto' ? '<i class="fa-solid fa-rotate mh_icon mh_resum" title="สรุปช่วงนี้ใหม่ (เช่น หลังแก้ข้อความ)"></i>' : ''}
        <i class="fa-solid fa-trash mh_icon mh_del" title="ลบ"></i>
      </div>
      <input class="text_pole mh_keys" value="${esc((m.keys ?? []).join(', '))}" placeholder="คีย์ (คั่นด้วย ,)">
      <textarea class="text_pole mh_text" rows="4">${esc(m.text)}</textarea>
      ${recalled ? '<small class="mh_tag">ถูกใส่ใน prompt ล่าสุด</small>' : ''}
    </div>`;
}

function renderManagerList() {
    const st = state();
    const list = managerEl?.querySelector('.mh_list');
    if (!list || !st) return;
    const f = managerFilter.trim().toLowerCase();
    const recalled = new Set(lastInjection?.picked.map(p => p.id) ?? []);
    const mems = [...st.memories].reverse().filter(m => !f || `${m.title} ${(m.keys ?? []).join(' ')} ${m.text}`.toLowerCase().includes(f));
    list.innerHTML = mems.length ? mems.map(m => memoryCard(m, recalled.has(m.id))).join('') : '<div class="mh_empty">ยังไม่มีความจำ กด "สรุปตอนนี้" หรือคุยต่อไปจนครบรอบ</div>';
    const hasImports = st.memories.some(m => m.source === 'import' && !m.optimized);
    managerEl.querySelector('.mh_do_optimize')?.classList.toggle('mh_hidden', !hasImports);
}

async function openManager() {
    const st = state();
    if (!st) return toast.warn('เปิดแชทก่อน');
    const { Popup, POPUP_TYPE } = ctx();

    const root = document.createElement('div');
    root.className = 'mh_manager';
    root.innerHTML = `
      <h3><i class="fa-solid fa-brain"></i> คลังความจำของแชทนี้</h3>
      <div class="mh_mgr_status"></div>
      <div class="mh_btns">
        <div class="menu_button mh_do_now"><i class="fa-solid fa-wand-magic-sparkles"></i> สรุปตอนนี้ / ย้อนหลัง</div>
        <div class="menu_button mh_do_add"><i class="fa-solid fa-plus"></i> เพิ่มความจำเอง</div>
        <div class="menu_button mh_do_import"><i class="fa-solid fa-file-import"></i> นำเข้า</div>
        <div class="menu_button mh_do_optimize"><i class="fa-solid fa-broom"></i> จัดระเบียบที่นำเข้า (AI)</div>
        <div class="menu_button mh_do_rebuild"><i class="fa-solid fa-book-open"></i> สร้างเรื่องย่อใหม่</div>
        <div class="menu_button mh_do_carry"><i class="fa-solid fa-forward"></i> เริ่มแชทใหม่ต่อเรื่อง</div>
        <div class="menu_button mh_do_reset"><i class="fa-solid fa-eraser"></i> ล้างทั้งหมด</div>
      </div>
      <label><b>เรื่องย่อจนถึงตอนนี้</b> <small>(แก้ได้ · ถูกเขียนทับเมื่อสรุปก้อนถัดไป)</small></label>
      <textarea class="text_pole mh_overview_edit" rows="6" placeholder="ยังไม่มี"></textarea>
      <div class="mh_list_head"><b>ความจำ</b> <input class="text_pole mh_search" placeholder="ค้นหา…"></div>
      <div class="mh_list"></div>`;
    managerEl = root;
    renderManagerHeader();
    renderManagerList();

    const ov = root.querySelector('.mh_overview_edit');
    const syncOverview = () => { ov.value = state()?.overview ?? ''; };
    syncOverview();
    ov.addEventListener('input', () => { state().overview = ov.value; saveState(); });

    root.querySelector('.mh_search').addEventListener('input', e => { managerFilter = e.target.value; renderManagerList(); });

    const find = el => {
        const id = el.closest('.mh_card')?.dataset.id;
        return state().memories.find(m => m.id === id);
    };
    root.addEventListener('input', e => {
        const t = e.target;
        const m = t.closest?.('.mh_card') && find(t);
        if (!m) return;
        if (t.classList.contains('mh_title')) m.title = t.value;
        else if (t.classList.contains('mh_keys')) m.keys = t.value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
        else if (t.classList.contains('mh_text')) m.text = t.value;
        else return;
        saveState();
    });
    let popup;
    root.addEventListener('click', async e => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const guardBusy = () => { if (busy) { toast.info('กำลังทำงานอยู่'); return true; } return false; };
        if (t.closest('.mh_do_now')) { await summarizeNow(); syncOverview(); renderManagerList(); return; }
        if (t.closest('.mh_do_add')) {
            state().memories.push({ id: uid(), start: -1, end: -1, title: 'ความจำใหม่', keys: [], text: '', pinned: false, source: 'manual', ts: Date.now() });
            saveState(); renderManagerList();
            return;
        }
        if (t.closest('.mh_do_import')) { await importDialog(); syncOverview(); renderManagerList(); renderManagerHeader(); return; }
        if (t.closest('.mh_do_optimize')) { if (guardBusy()) return; await optimizeImported(); syncOverview(); renderManagerList(); return; }
        if (t.closest('.mh_do_rebuild')) { if (guardBusy()) return; await rebuildOverview(); syncOverview(); return; }
        if (t.closest('.mh_do_carry')) { await popup?.completeCancelled(); await continueInNewChat(); return; }
        if (t.closest('.mh_do_reset')) {
            const ok = await ctx().callGenericPopup('ลบความจำและเรื่องย่อทั้งหมดของแชทนี้? (ข้อความในแชทไม่ถูกลบ ข้อความเก่าจะกลับไปถูกส่งแบบเต็มจนกว่าจะสรุปใหม่)', ctx().POPUP_TYPE.CONFIRM);
            if (!ok) return;
            const cur = state();
            cur.memories = []; cur.overview = ''; cur.lastEnd = -1; delete cur.baseOverview; delete cur.chain;
            saveState();
            syncOverview(); renderManagerList(); refreshUi();
            return;
        }
        const m = find(t);
        if (!m) return;
        if (t.classList.contains('mh_pin')) { m.pinned = !m.pinned; saveState(); renderManagerList(); }
        else if (t.classList.contains('mh_del')) {
            const cur = state();
            cur.memories = cur.memories.filter(x => x.id !== m.id);
            saveState(); renderManagerList(); refreshUi();
        } else if (t.classList.contains('mh_resum')) {
            if (guardBusy()) return;
            t.classList.add('fa-spin');
            try {
                busy = summarizeRange(m.start, m.end, { replaceId: m.id, updateOverview: false });
                await busy;
                toast.ok('สรุปช่วงนี้ใหม่แล้ว');
            } catch (err) { toast.err(`สรุปไม่สำเร็จ: ${errText(err)}`, { timeOut: 15000 }); } finally { busy = null; }
            renderManagerList(); refreshUi();
        }
    });

    popup = new Popup(root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'ปิด' });
    await popup.show();
    managerEl = null;
    refreshUi();
}

async function importDialog() {
    const c = ctx();
    const names = c.getWorldInfoNames?.() ?? [];
    const lastSummary = [...c.chat].reverse().find(m => m?.extra?.memory)?.extra?.memory;
    let chats = [];
    try { chats = await listOtherChats(); } catch (e) { console.warn(LOG, e); }
    const box = document.createElement('div');
    box.className = 'mh_import';
    box.innerHTML = `
      <h3>นำเข้าความจำ</h3>
      <p><b>จากแชทอื่นของตัวละครนี้</b> — ดึงความจำและเรื่องย่อของ Memory Hub จากแชทนั้นมาต่อ</p>
      <select class="text_pole mh_chat"><option value="">— เลือกแชท —</option>${chats.map(x => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('')}</select>
      <div class="menu_button mh_go_chat">นำเข้าจากแชท</div>
      <hr>
      <p><b>จาก lorebook</b> (เช่น ที่ Memory Books สร้างไว้) — ทุกเอนทรีจะกลายเป็นความจำ แล้วถูกดึงตามความเกี่ยวข้องแทนการติดคีย์เวิร์ด</p>
      <select class="text_pole mh_book"><option value="">— เลือก lorebook —</option>${names.map(n => `<option>${esc(n)}</option>`).join('')}</select>
      <label class="checkbox_label"><input type="checkbox" class="mh_skipoff" checked> ข้ามเอนทรีที่ปิดอยู่</label>
      <label class="checkbox_label"><input type="checkbox" class="mh_optimize" checked> จัดระเบียบด้วย AI หลังนำเข้า (ย่อเอนทรีที่ยาว ทำคีย์ใหม่ และสร้างเรื่องย่อถ้ายังไม่มี)</label>
      <div class="menu_button mh_go_book">นำเข้าจาก lorebook</div>
      <small>ทุกครั้งที่นำเข้าจะล้าง HTML ตัดเอนทรีซ้ำ และลบคีย์ที่เป็นชื่อตัวหลักออกให้เอง (ไม่เสีย API) — นำเข้าแล้วให้ถอด lorebook นั้นออกจากแชท/ตัวละคร ไม่งั้นจะถูกส่งซ้ำ</small>
      <hr>
      <p><b>จาก Summarize ในตัวของ SillyTavern</b> — ใช้บทสรุปล่าสุดของแชทนี้เป็นเรื่องย่อ</p>
      <div class="menu_button mh_go_sum ${lastSummary ? '' : 'disabled'}">${lastSummary ? 'ใช้บทสรุปล่าสุดเป็นเรื่องย่อ' : 'แชทนี้ไม่มีบทสรุปของ Summarize'}</div>`;
    let optimizeAfter = false;
    box.addEventListener('click', async e => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest('.mh_go_chat')) {
            const id = box.querySelector('.mh_chat').value;
            if (!id) return toast.warn('เลือกแชทก่อน');
            try { await importFromChat(id); } catch (err) { toast.err(errText(err)); }
        } else if (t.closest('.mh_go_book')) {
            const name = box.querySelector('.mh_book').value;
            if (!name) return toast.warn('เลือก lorebook ก่อน');
            const { n, skipped } = await importFromBook(name, box.querySelector('.mh_skipoff').checked);
            toast.ok(`นำเข้า ${n} เอนทรีจาก ${name}${skipped ? ` (ข้ามที่ซ้ำ/ว่าง ${skipped})` : ''}`);
            if (n && box.querySelector('.mh_optimize').checked) optimizeAfter = true;
        } else if (t.closest('.mh_go_sum') && lastSummary) {
            state().overview = String(lastSummary);
            saveState();
            toast.ok('ตั้งเป็นเรื่องย่อแล้ว');
        }
    });
    const { Popup, POPUP_TYPE } = c;
    await new Popup(box, POPUP_TYPE.TEXT, '', { okButton: 'ปิด' }).show();
    if (optimizeAfter && !busy) await optimizeImported();
}

// ---------------------------------------------------------------- init

function registerCommands() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'memhub',
        callback: async () => { await openManager(); return ''; },
        helpString: 'เปิดคลังความจำของ Memory Hub',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'memhub-now',
        callback: async () => { await summarizeNow(); return ''; },
        helpString: 'Memory Hub: สรุปข้อความที่ยังไม่ได้สรุปทันที',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'memhub-continue',
        callback: async () => { await continueInNewChat(); return ''; },
        helpString: 'Memory Hub: เริ่มแชทใหม่ต่อเรื่องเดิม พกความจำไปด้วย',
    }));
}

jQuery(() => {
    try {
        settings();
        renderSettings();
        registerCommands();
        const { eventSource, eventTypes: E } = ctx();
        eventSource.on(E.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(E.MESSAGE_DELETED, () => reconcile({ announce: true }));
        eventSource.on(E.CHAT_CHANGED, () => {
            clearPrompts();
            lastInjection = null;
            cancelRequested = true;
            autoPausedUntil = 0;
            reconcile({ announce: true });
            refreshUi();
        });
        console.log(LOG, `v${VERSION} loaded`);
    } catch (e) {
        console.error(LOG, 'init failed', e);
    }
});
