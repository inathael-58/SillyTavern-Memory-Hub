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
 * Everything lives in the chat's metadata, so branches and chat copies carry
 * their memories with them.
 */

import { cleanText, hasSegmenter, nextChunk, parseSummary, rankMemories } from './lib.js';

const MODULE = 'memory_hub';
const LOG = '[MemoryHub]';
const VERSION = '1.0.0'; // keep in sync with manifest.json
const KEY_OVERVIEW = 'memory_hub_overview';
const KEY_RECALL = 'memory_hub_recall';

const DEFAULT_PROMPT = `You are the memory keeper of an ongoing roleplay between {{user}} and {{char}}.
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

const OVERVIEW_RULE = '- overview: rewrite PREVIOUS OVERVIEW so it also covers the new memory. It is the story so far in at most {{overview_words}} words: who is who, where things stand, open threads. Drop details that no longer matter.';
const OVERVIEW_FORMAT = '\n<overview>\n<updated story so far>\n</overview>';

const DEFAULTS = Object.freeze({
    enabled: true,
    autoSummarize: true,
    chunkSize: 20,          // messages per memory
    keepRaw: 12,            // newest messages that are never summarized yet
    trimSummarized: true,   // drop summarized messages from the prompt
    overviewEnabled: true,
    overviewWords: 250,
    memoryWords: 120,
    responseLength: 700,
    topK: 3,
    recallBudget: 800,      // tokens for recalled memories (overview not counted)
    queryDepth: 4,          // last N messages used to decide what to recall
    includeLatest: true,
    source: 'main',         // 'main' | 'profile'
    profileId: '',
    overviewPosition: 'prompt', // 'prompt' | 'chat'
    overviewDepth: 4,
    recallPosition: 'chat',
    recallDepth: 2,
    maxMessageChars: 3000,  // per message, in the summarizer's input
    prompt: DEFAULT_PROMPT,
    overviewTemplate: '[Story so far]\n{{overview}}',
    recallTemplate: '[Memories from earlier in the story that matter now]\n{{memories}}',
    notify: true,
});

// ---------------------------------------------------------------- helpers

const ctx = () => SillyTavern.getContext();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clampInt = (v, lo, hi, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const toast = {
    ok: m => globalThis.toastr?.success(m, 'Memory Hub'),
    info: (m, o) => globalThis.toastr?.info(m, 'Memory Hub', o),
    warn: m => globalThis.toastr?.warning(m, 'Memory Hub'),
    err: m => globalThis.toastr?.error(m, 'Memory Hub'),
};

function settings() {
    const ext = ctx().extensionSettings;
    ext[MODULE] ??= {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = v;
    return s;
}
const saveSettings = () => ctx().saveSettingsDebounced();

/** @returns {{v:number, memories:any[], overview:string, lastEnd:number}|null} */
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

// ---------------------------------------------------------------- summarizing

let busy = null;          // Promise of the running summarization
let cancelRequested = false;
let lastInjection = null; // what the last generation received (for the preview)

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

function buildSystemPrompt(withOverview) {
    const s = settings();
    const p = String(s.prompt || DEFAULT_PROMPT)
        .replaceAll('{{overview_rule}}', withOverview ? OVERVIEW_RULE : '')
        .replaceAll('{{overview_format}}', withOverview ? OVERVIEW_FORMAT : '')
        .replaceAll('{{overview_words}}', String(s.overviewWords))
        .replaceAll('{{memory_words}}', String(s.memoryWords));
    return ctx().substituteParams(p);
}

async function callModel(system, user, maxTokens) {
    const s = settings();
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const c = ctx();
    if (s.source === 'profile' && s.profileId) {
        const svc = c.ConnectionManagerRequestService;
        if (!svc) throw new Error('Connection Manager ไม่พร้อมใช้งาน');
        const res = await svc.sendRequest(s.profileId, messages, maxTokens);
        return typeof res === 'string' ? res : String(res?.content ?? '');
    }
    return await c.generateRaw({ prompt: messages, responseLength: maxTokens });
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
    const prev = [...st.memories].filter(m => m.end < start && m.end >= 0).sort((a, b) => b.end - a.end)[0];
    const parts = [];
    if (withOverview) parts.push(`PREVIOUS OVERVIEW:\n${st.overview.trim() || '(none yet — this is the start of the story)'}`);
    if (prev) parts.push(`PREVIOUS MEMORY (for continuity, do not repeat it):\n${memoryBlock(prev)}`);
    parts.push(`NEW MESSAGES (#${start}–#${end}):\n${body}`);

    const raw = await callModel(buildSystemPrompt(withOverview), ctx().substituteParams(parts.join('\n\n')), s.responseLength);
    if (ctx().chatId !== chatId) throw new Error('เปลี่ยนแชทระหว่างสรุป ผลลัพธ์ถูกทิ้ง');

    const parsed = parseSummary(raw);
    if (!parsed.text) throw new Error('โมเดลตอบกลับว่าง');

    const cur = state();
    let mem;
    if (replaceId) {
        mem = cur.memories.find(m => m.id === replaceId);
        if (mem) Object.assign(mem, { title: parsed.title || mem.title, keys: parsed.keys.length ? parsed.keys : mem.keys, text: parsed.text, ts: Date.now() });
    }
    if (!mem) {
        mem = { id: uid(), start, end, title: parsed.title || `#${start}–#${end}`, keys: parsed.keys, text: parsed.text, pinned: false, source: 'auto', ts: Date.now() };
        cur.memories.push(mem);
        cur.memories.sort((a, b) => (a.start - b.start) || (a.ts - b.ts));
        cur.lastEnd = Math.max(cur.lastEnd, end);
    }
    if (withOverview && parsed.overview) cur.overview = parsed.overview;
    saveState();
    return mem;
}

/**
 * Summarizes chunk after chunk until the chat is caught up.
 * @param {{force?:boolean, quiet?:boolean}} opt force = also take a last partial chunk
 */
function runSummaries({ force = false, quiet = false } = {}) {
    if (busy) return busy;
    cancelRequested = false;
    busy = (async () => {
        let made = 0;
        let progress = null;
        try {
            for (;;) {
                if (cancelRequested) break;
                const st = state();
                if (!st) break;
                const s = settings();
                const chunk = nextChunk(st.lastEnd, ctx().chat.length, s.chunkSize, s.keepRaw, force);
                if (!chunk) break;
                if (!quiet || made > 0) {
                    progress?.remove?.();
                    progress = toast.info(`กำลังสรุปข้อความ #${chunk.start}–#${chunk.end}…`, { timeOut: 0, extendedTimeOut: 0 });
                }
                const mem = await summarizeRange(chunk.start, chunk.end);
                if (!mem) { state().lastEnd = chunk.end; saveState(); continue; }
                made++;
                refreshUi();
            }
        } catch (e) {
            console.error(LOG, e);
            toast.err(`สรุปไม่สำเร็จ: ${e?.message || e}${e?.cause?.message ? ` (${e.cause.message})` : ''}`);
        } finally {
            progress?.remove?.();
            if (globalThis.toastr && progress) globalThis.toastr.clear(progress);
            busy = null;
            refreshUi();
        }
        if (made && (settings().notify || !quiet)) toast.ok(`สร้างความจำใหม่ ${made} อัน`);
        if (!made && !quiet && !cancelRequested) toast.info('ยังไม่มีข้อความที่ต้องสรุป (ข้อความล่าสุดจะถูกเก็บไว้แบบเต็มตามที่ตั้งไว้)');
        return made;
    })();
    return busy;
}

function onMessageReceived(_id, type) {
    const s = settings();
    if (!s.enabled || !s.autoSummarize || type === 'quiet') return;
    const st = state();
    if (!st) return;
    if (!nextChunk(st.lastEnd, ctx().chat.length, s.chunkSize, s.keepRaw)) return;
    runSummaries({ quiet: true });
}

/** Keeps memories consistent after messages were deleted (or a branch was cut). */
function reconcile() {
    const st = state();
    if (!st) return;
    const len = ctx().chat.length;
    let changed = false;
    if (st.lastEnd > len - 1) { st.lastEnd = len - 1; changed = true; }
    const before = st.memories.length;
    st.memories = st.memories.filter(m => m.source !== 'auto' || m.start < len);
    for (const m of st.memories) if (m.end > len - 1 && m.end >= 0) { m.end = len - 1; changed = true; }
    if (st.memories.length !== before) changed = true;
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
    if (!pool.length) return { picked: [], tokens: 0, ranked: [] };

    const latest = [...pool].filter(m => m.end >= 0).sort((a, b) => b.end - a.end)[0];
    const chosen = new Map();
    const why = new Map();
    for (const m of pool) if (m.pinned) { chosen.set(m.id, m); why.set(m.id, ['📌']); }
    if (s.includeLatest && latest && !chosen.has(latest.id)) { chosen.set(latest.id, latest); why.set(latest.id, ['🕘 ล่าสุด']); }

    // Words shared by every memory (main characters' names) only add a little
    // score each; the floor keeps small talk from pulling in random memories.
    const all = rankMemories(pool, queryText);
    const floor = Math.max(1, (all[0]?.score ?? 0) * 0.35);
    const ranked = all.filter(r => r.score >= floor);
    let extra = 0;
    for (const r of ranked) {
        if (extra >= s.topK) break;
        if (chosen.has(r.memory.id)) continue;
        chosen.set(r.memory.id, r.memory);
        why.set(r.memory.id, r.hits.slice(0, 6));
        extra++;
    }

    // budget: pinned first, then the latest, then by relevance
    const order = [...chosen.values()];
    const picked = [];
    let tokens = 0;
    for (const m of order) {
        const t = await countTokens(memoryBlock(m));
        if (tokens + t > s.recallBudget && picked.length) continue;
        if (t > s.recallBudget && !m.pinned) continue;
        picked.push(m);
        tokens += t;
    }
    picked.sort((a, b) => (a.start - b.start) || (a.ts - b.ts));
    return { picked, tokens, ranked, why };
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

    // A chunk may be summarizing with the main API right now: let it land first,
    // so this prompt already benefits from it.
    if (busy) {
        await Promise.race([busy, new Promise(r => setTimeout(r, 120_000))]);
    }

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

    const trimmedTokens = trimmed ? await savedTokens(st.lastEnd) : 0;
    lastInjection = {
        at: Date.now(),
        type,
        trimmed,
        trimmedTokens,
        overviewText,
        overviewTokens: await countTokens(overviewText),
        recallText,
        recallTokens: tokens,
        picked: picked.map(m => ({ id: m.id, title: m.title, why: why?.get(m.id) ?? [] })),
    };
    refreshUi();
}
globalThis.memoryHub_intercept = intercept;

// ---------------------------------------------------------------- settings panel

function profileOptions() {
    try {
        const list = ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? [];
        return list.map(p => ({ id: p.id, name: p.name }));
    } catch { return []; }
}

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
          </div>
          <div id="mh_warn" class="mh_warn"></div>

          <label class="checkbox_label"><input type="checkbox" id="mh_enabled"> เปิดใช้งาน</label>
          <label class="checkbox_label"><input type="checkbox" id="mh_auto"> สรุปอัตโนมัติเมื่อข้อความครบรอบ</label>
          <label class="checkbox_label" title="ข้อความที่สรุปแล้วจะไม่ถูกส่งซ้ำ ประหยัดที่สุด แชทจริงไม่ถูกลบหรือซ่อน"><input type="checkbox" id="mh_trim"> ไม่ส่งข้อความที่สรุปแล้ว (ประหยัดโทเคนมากที่สุด)</label>
          <label class="checkbox_label"><input type="checkbox" id="mh_overview"> มี "เรื่องย่อจนถึงตอนนี้" หนึ่งก้อน</label>
          <label class="checkbox_label"><input type="checkbox" id="mh_latest"> ใส่ความจำก้อนล่าสุดเสมอ (ต่อเนื่องกับข้อความดิบ)</label>
          <label class="checkbox_label"><input type="checkbox" id="mh_notify"> แจ้งเตือนเมื่อสร้างความจำใหม่</label>

          <h4>จังหวะการสรุป</h4>
          ${numberRow('mh_chunk', 'สรุปทีละ (ข้อความ)', 'ทุก ๆ กี่ข้อความถึงจะสรุปหนึ่งครั้ง ยิ่งมากยิ่งเรียก API น้อย', 4, 200)}
          ${numberRow('mh_keep', 'เก็บข้อความล่าสุดแบบเต็ม', 'ข้อความใหม่สุดกี่ข้อความที่จะยังไม่ถูกสรุป และส่งแบบเต็มเสมอ', 2, 200)}
          ${numberRow('mh_memwords', 'ความยาวความจำ (คำ)', 'ความยาวสูงสุดของความจำแต่ละก้อน', 30, 600)}
          ${numberRow('mh_ovwords', 'ความยาวเรื่องย่อ (คำ)', 'ความยาวสูงสุดของเรื่องย่อจนถึงตอนนี้', 50, 1500)}
          ${numberRow('mh_resp', 'Response length ตอนสรุป (โทเคน)', 'เพดานคำตอบของโมเดลตอนสรุป', 200, 4000)}

          <h4>การดึงความจำ</h4>
          ${numberRow('mh_topk', 'ดึงความจำที่เกี่ยวข้องสูงสุด (ก้อน)', 'ไม่นับก้อนล่าสุดและก้อนที่ปักหมุด', 0, 20)}
          ${numberRow('mh_budget', 'งบโทเคนของความจำที่ดึง', 'รวมทุกก้อนที่ดึงมา (ไม่นับเรื่องย่อ)', 100, 8000)}
          ${numberRow('mh_qdepth', 'ดูบริบทจากข้อความล่าสุด (ข้อความ)', 'ใช้ข้อความล่าสุดกี่ข้อความเป็นตัวตัดสินว่าอะไรเกี่ยวข้อง', 1, 20)}

          <h4>โมเดลที่ใช้สรุป</h4>
          <label class="mh_row"><span>ใช้</span>
            <select id="mh_source" class="text_pole">
              <option value="main">API หลักที่ใช้แชทอยู่</option>
              <option value="profile">Connection Profile (เลือกโมเดลถูก ๆ ได้)</option>
            </select></label>
          <label class="mh_row" id="mh_profile_row"><span>Profile</span><select id="mh_profile" class="text_pole"></select></label>

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
              <label>Prompt ที่ใช้สรุป</label>
              <textarea id="mh_prompt" class="text_pole" rows="10"></textarea>
              <div class="menu_button" id="mh_prompt_reset">คืนค่า prompt เริ่มต้น</div>
            </div>
          </div>
          <small class="mh_note">คำสั่ง <code>/memhub</code> เปิดคลังความจำ · <code>/memhub-now</code> สรุปทันที — ใช้ทำปุ่มใน Quick Dock ได้</small>
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
    bindNum('#mh_resp', 'responseLength', 200, 4000);
    bindNum('#mh_topk', 'topK', 0, 20);
    bindNum('#mh_budget', 'recallBudget', 100, 8000);
    bindNum('#mh_qdepth', 'queryDepth', 1, 20);
    bindNum('#mh_ovdepth', 'overviewDepth', 0, 50);
    bindNum('#mh_recdepth', 'recallDepth', 0, 50);
    bindNum('#mh_maxchars', 'maxMessageChars', 500, 50000);
    bindVal('#mh_source', 'source');
    bindVal('#mh_ovpos', 'overviewPosition');
    bindVal('#mh_recpos', 'recallPosition');
    bindVal('#mh_ovtpl', 'overviewTemplate');
    bindVal('#mh_rectpl', 'recallTemplate');
    bindVal('#mh_prompt', 'prompt');
    $('#mh_prompt_reset').on('click', () => { s.prompt = DEFAULT_PROMPT; $('#mh_prompt').val(DEFAULT_PROMPT); saveSettings(); });
    $('#mh_profile').on('focus mousedown', fillProfiles).on('change', function () { s.profileId = this.value; saveSettings(); });
    fillProfiles();

    $('#mh_open').on('click', openManager);
    $('#mh_now').on('click', summarizeNow);
    $('#mh_last').on('click', showLastInjection);
    refreshUi();
}

function fillProfiles() {
    const s = settings();
    const sel = $('#mh_profile');
    const list = profileOptions();
    const current = sel.val() || s.profileId;
    sel.empty().append(`<option value="">— เลือก —</option>`);
    for (const p of list) sel.append(`<option value="${esc(p.id)}">${esc(p.name)}</option>`);
    if (!list.length) sel.append('<option value="" disabled>ยังไม่มี profile (สร้างได้ที่ Connection Profiles)</option>');
    sel.val(current || '');
}

function refreshUi() {
    const s = settings();
    const st = state();
    $('#mh_profile_row').toggle(s.source === 'profile');
    $('#mh_ovdepth').closest('.mh_row').toggle(s.overviewPosition === 'chat');
    $('#mh_recdepth').closest('.mh_row').toggle(s.recallPosition === 'chat');

    let status;
    if (!st) status = 'ยังไม่ได้เปิดแชท';
    else {
        const len = ctx().chat.length;
        const pending = Math.max(0, len - 1 - st.lastEnd);
        status = `ความจำ <b>${st.memories.length}</b> ก้อน · สรุปแล้วถึงข้อความ <b>#${st.lastEnd}</b> · ยังไม่สรุป <b>${pending}</b> ข้อความ`;
        if (busy) status += ' · <i class="fa-solid fa-spinner fa-spin"></i> กำลังสรุป';
        if (lastInjection) {
            status += `<br>ครั้งล่าสุด: ส่งเรื่องย่อ ${lastInjection.overviewTokens} + ความจำ ${lastInjection.picked.length} ก้อน ${lastInjection.recallTokens} โทเคน`;
            if (lastInjection.trimmed) status += ` · ไม่ส่งข้อความเก่า ${lastInjection.trimmed} ข้อความ (ประหยัด ~${lastInjection.trimmedTokens} โทเคน)`;
        }
    }
    $('#mh_status').html(status);
    $('#mh_now').toggleClass('disabled', !!busy);

    const warns = [];
    const c = ctx();
    if (c.extensionPrompts?.['1_memory']?.value?.trim()) warns.push('Summarize ในตัวของ SillyTavern ยังส่งบทสรุปอยู่ ถ้าใช้ Memory Hub แทน ให้ปิดตัวนั้น (Summarize → Pause หรือปิดส่วนขยาย) ไม่งั้นจะเสียโทเคนซ้ำสองทาง');
    if (!hasSegmenter()) warns.push('เบราว์เซอร์นี้ไม่มีตัวตัดคำ (Intl.Segmenter) จะใช้วิธีสำรองซึ่งแม่นน้อยกว่า');
    if (s.source === 'profile' && !s.profileId) warns.push('ยังไม่ได้เลือก Connection Profile จะใช้ API หลักแทน');
    $('#mh_warn').html(warns.map(w => `<div><i class="fa-solid fa-triangle-exclamation"></i> ${esc(w)}</div>`).join(''));

    if (managerEl?.isConnected) renderManagerHeader();
}

// ---------------------------------------------------------------- actions

async function summarizeNow() {
    if (!state()) return toast.warn('เปิดแชทก่อน');
    if (busy) return toast.info('กำลังสรุปอยู่');
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
    el.innerHTML = `ความจำ <b>${st.memories.length}</b> ก้อน · สรุปแล้วถึง #${st.lastEnd} จาก ${len} ข้อความ${busy ? ' · <i class="fa-solid fa-spinner fa-spin"></i> กำลังสรุป <a href="#" class="mh_cancel">หยุด</a>' : ''}`;
    el.querySelector('.mh_cancel')?.addEventListener('click', e => { e.preventDefault(); cancelRequested = true; toast.info('จะหยุดหลังก้อนนี้เสร็จ'); });
}

function memoryCard(m, recalled) {
    const range = m.end >= 0 ? `#${m.start}–#${m.end}` : (m.source === 'import' ? 'นำเข้า' : 'เพิ่มเอง');
    return `<div class="mh_card${m.pinned ? ' mh_pinned' : ''}${recalled ? ' mh_recalled' : ''}" data-id="${esc(m.id)}">
      <div class="mh_card_head">
        <input class="text_pole mh_title" value="${esc(m.title)}" placeholder="ชื่อ">
        <span class="mh_range" title="ช่วงข้อความที่สรุป">${esc(range)}</span>
        <i class="fa-solid fa-thumbtack mh_icon mh_pin" title="ปักหมุด: ใส่ใน prompt ทุกครั้ง"></i>
        ${m.end >= 0 ? '<i class="fa-solid fa-rotate mh_icon mh_resum" title="สรุปช่วงนี้ใหม่ (เช่น หลังแก้ข้อความ)"></i>' : ''}
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
        <div class="menu_button mh_do_reset"><i class="fa-solid fa-eraser"></i> ล้างทั้งหมด</div>
      </div>
      <label><b>เรื่องย่อจนถึงตอนนี้</b> <small>(แก้ได้ · ถูกเขียนทับเมื่อสรุปก้อนถัดไป)</small></label>
      <textarea class="text_pole mh_overview_edit" rows="5" placeholder="ยังไม่มี"></textarea>
      <div class="mh_list_head"><b>ความจำ</b> <input class="text_pole mh_search" placeholder="ค้นหา…"></div>
      <div class="mh_list"></div>`;
    managerEl = root;
    renderManagerHeader();
    renderManagerList();

    const ov = root.querySelector('.mh_overview_edit');
    ov.value = st.overview;
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
    root.addEventListener('click', async e => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest('.mh_do_now')) {
            await summarizeNow();
            ov.value = state()?.overview ?? '';
            renderManagerList();
            return;
        }
        if (t.closest('.mh_do_add')) {
            state().memories.push({ id: uid(), start: -1, end: -1, title: 'ความจำใหม่', keys: [], text: '', pinned: false, source: 'manual', ts: Date.now() });
            saveState();
            renderManagerList();
            return;
        }
        if (t.closest('.mh_do_import')) { await importDialog(); ov.value = state()?.overview ?? ''; renderManagerList(); return; }
        if (t.closest('.mh_do_reset')) {
            const ok = await ctx().callGenericPopup('ลบความจำและเรื่องย่อทั้งหมดของแชทนี้? (ข้อความในแชทไม่ถูกลบ ข้อความเก่าจะกลับไปถูกส่งแบบเต็มจนกว่าจะสรุปใหม่)', ctx().POPUP_TYPE.CONFIRM);
            if (!ok) return;
            const cur = state();
            cur.memories = []; cur.overview = ''; cur.lastEnd = -1;
            saveState();
            ov.value = '';
            renderManagerList(); refreshUi();
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
            if (busy) return toast.info('กำลังสรุปอยู่');
            t.classList.add('fa-spin');
            try {
                busy = summarizeRange(m.start, m.end, { replaceId: m.id, updateOverview: false });
                await busy;
                toast.ok('สรุปช่วงนี้ใหม่แล้ว');
            } catch (err) { toast.err(`สรุปไม่สำเร็จ: ${err?.message || err}`); } finally { busy = null; }
            renderManagerList(); refreshUi();
        }
    });

    await new Popup(root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'ปิด' }).show();
    managerEl = null;
    refreshUi();
}

async function importDialog() {
    const c = ctx();
    const names = c.getWorldInfoNames?.() ?? [];
    const lastSummary = [...c.chat].reverse().find(m => m?.extra?.memory)?.extra?.memory;
    const box = document.createElement('div');
    box.className = 'mh_import';
    box.innerHTML = `
      <h3>นำเข้าความจำ</h3>
      <p><b>จาก lorebook</b> (เช่น ที่ Memory Books สร้างไว้) — ทุกเอนทรีจะกลายเป็นความจำ แล้วถูกดึงตามความเกี่ยวข้องแทนการติดคีย์เวิร์ด
      <br><small>นำเข้าแล้วให้ถอด lorebook นั้นออกจากแชท/ตัวละคร ไม่งั้นจะถูกส่งซ้ำ</small></p>
      <select class="text_pole mh_book"><option value="">— เลือก lorebook —</option>${names.map(n => `<option>${esc(n)}</option>`).join('')}</select>
      <label class="checkbox_label"><input type="checkbox" class="mh_skipoff" checked> ข้ามเอนทรีที่ปิดอยู่</label>
      <div class="menu_button mh_go_book">นำเข้าจาก lorebook</div>
      <hr>
      <p><b>จาก Summarize ในตัวของ SillyTavern</b> — ใช้บทสรุปล่าสุดของแชทนี้เป็นเรื่องย่อ</p>
      <div class="menu_button mh_go_sum ${lastSummary ? '' : 'disabled'}">${lastSummary ? 'ใช้บทสรุปล่าสุดเป็นเรื่องย่อ' : 'แชทนี้ไม่มีบทสรุปของ Summarize'}</div>`;
    box.addEventListener('click', async e => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest('.mh_go_book')) {
            const name = box.querySelector('.mh_book').value;
            if (!name) return toast.warn('เลือก lorebook ก่อน');
            const skipOff = box.querySelector('.mh_skipoff').checked;
            const data = await c.loadWorldInfo(name);
            const entries = Object.values(data?.entries ?? {}).filter(x => String(x.content ?? '').trim() && !(skipOff && x.disable));
            const st = state();
            const seen = new Set(st.memories.map(m => m.text));
            let n = 0;
            for (const x of entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.uid - b.uid))) {
                const text = String(x.content).trim();
                if (seen.has(text)) continue;
                st.memories.push({ id: uid(), start: -1, end: -1, title: String(x.comment || (x.key ?? []).join(', ') || `#${x.uid}`).slice(0, 120), keys: (x.key ?? []).map(String).filter(Boolean), text, pinned: !!x.constant, source: 'import', ts: Date.now() + n });
                n++;
            }
            saveState();
            toast.ok(`นำเข้า ${n} เอนทรีจาก ${name}${entries.length > n ? ` (ข้ามที่ซ้ำ ${entries.length - n})` : ''}`);
            refreshUi();
        } else if (t.closest('.mh_go_sum') && lastSummary) {
            state().overview = String(lastSummary);
            saveState();
            toast.ok('ตั้งเป็นเรื่องย่อแล้ว');
        }
    });
    const { Popup, POPUP_TYPE } = c;
    await new Popup(box, POPUP_TYPE.TEXT, '', { okButton: 'ปิด' }).show();
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
}

jQuery(() => {
    try {
        settings();
        renderSettings();
        registerCommands();
        const { eventSource, eventTypes: E } = ctx();
        eventSource.on(E.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(E.MESSAGE_DELETED, reconcile);
        eventSource.on(E.CHAT_CHANGED, () => { clearPrompts(); lastInjection = null; cancelRequested = true; reconcile(); refreshUi(); });
        console.log(LOG, `v${VERSION} loaded`);
    } catch (e) {
        console.error(LOG, 'init failed', e);
    }
});
