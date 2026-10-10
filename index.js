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

import { cleanKeys, cleanText, hasSegmenter, isComplete, nextChunk, parseMany, parseSummary, rankMemories } from './lib.js';
import { allModules, BUILTIN_MODULES, buildOverviewRule, buildPrompt, extraWords, modulesFromTags } from './modules.js';

const MODULE = 'memory_hub';
const LOG = '[MemoryHub]';
const VERSION = '1.8.0'; // keep in sync with manifest.json
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

const DEFAULTS = Object.freeze({
    enabled: true,
    mode: 'auto',           // auto | semi (ask first) | manual
    chunkSize: 20,          // messages per memory
    semiSnooze: 10,         // semi: ask again after this many more messages
    quotaBoost: 1,          // multiplies memory length and recall budget
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
    style: 'modules',       // modules | custom
    defaultModules: null,   // module ids for bots without a choice; null = relationship (solo) / ensemble+story (group)
    botModules: {},         // 'group:<id>' -> module ids (characters keep theirs as tags on the card)
    customModules: [],      // user-made modules (same shape as BUILTIN_MODULES)
    autoWords: true,        // add the modules' extra words to the lengths below
    sources: null,          // ordered list: 'main' or Connection Profile ids
    timeoutSec: 120,
    overviewPosition: 'prompt', // 'prompt' | 'chat'
    overviewDepth: 4,
    recallPosition: 'chat',
    recallDepth: 2,
    maxMessageChars: 3000,  // per message, in the summarizer's input
    prompt: '',             // used when style = custom
    overviewTemplate: '[Story so far]\n{{overview}}',
    recallTemplate: '[Memories from earlier in the story that matter now]\n{{memories}}',
    notify: true,
    carrySummarizeRest: true,
    topbar: true,           // button + panel in the chat top bar (Top Info Bar extension)
    topbarFallback: true,   // our own slim bar when Top Info Bar is not installed
    icon: 'svg:heart',      // see ICONS
    badgeStyle: 'badge',    // badge (with border) | pill (no border) | replace (number instead of the icon) | none
    badgePos: 'br',         // br | tr | bl | center
    badgeColor: 'theme',    // theme | quote | em | underline | custom
    badgeFg: '#ffffff',     // custom colors
    badgeBg: '#444444',
    badgeSize: 9,           // px
});

// ---------------------------------------------------------------- icons

const SVG_ICONS = {
    heart: ['ที่คั่นหนังสือหัวใจ', `<svg class="mh_svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.2 2h11.6c.7 0 1.2.5 1.2 1.2v17.9c0 .5-.6.8-1 .5L12 17.4l-6 4.2c-.4.3-1-.0-1-.5V3.2C5 2.5 5.5 2 6.2 2z"/><path fill="var(--mh-accent, #ff8fab)" d="M12 13.2l-.55-.5C9.5 10.95 8.2 9.8 8.2 8.4c0-1.15.9-2.05 2.05-2.05.65 0 1.27.3 1.67.78.4-.48 1.02-.78 1.67-.78 1.15 0 2.05.9 2.05 2.05 0 1.4-1.3 2.55-3.25 4.3z"/></svg>`],
    star: ['ที่คั่นหนังสือดาว', `<svg class="mh_svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.2 2h11.6c.7 0 1.2.5 1.2 1.2v17.9c0 .5-.6.8-1 .5L12 17.4l-6 4.2c-.4.3-1-.0-1-.5V3.2C5 2.5 5.5 2 6.2 2z"/><path fill="var(--mh-accent-star, #ffd166)" d="M12 5.6l1.25 2.55 2.8.4-2.03 1.98.48 2.8L12 12l-2.5 1.33.48-2.8-2.03-1.98 2.8-.4z"/></svg>`],
    moon: ['ที่คั่นหนังสือจันทร์', `<svg class="mh_svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.2 2h11.6c.7 0 1.2.5 1.2 1.2v17.9c0 .5-.6.8-1 .5L12 17.4l-6 4.2c-.4.3-1-.0-1-.5V3.2C5 2.5 5.5 2 6.2 2z"/><path fill="var(--mh-accent-moon, #cdb4ff)" d="M13.6 5.8a3.9 3.9 0 1 0 1.9 6.3 3.2 3.2 0 0 1-1.9-6.3z"/></svg>`],
};
const ICONS = [
    'svg:heart', 'svg:star', 'svg:moon',
    'fa-solid fa-bookmark', 'fa-solid fa-book-bookmark', 'fa-solid fa-book-open', 'fa-solid fa-feather', 'fa-solid fa-scroll', 'fa-solid fa-brain',
    '🔖', '📖', '🌙', '✨', '🌸', '🍀',
];

/** Inner HTML for an icon choice (Font Awesome class, built-in SVG, or an emoji). */
function iconHtml(spec) {
    if (String(spec).startsWith('svg:')) return (SVG_ICONS[spec.slice(4)] ?? SVG_ICONS.heart)[1];
    if (String(spec).startsWith('fa-')) return `<i class="${esc(spec)}"></i>`;
    return `<span class="mh_emoji">${esc(spec)}</span>`;
}
/** Draws the chosen icon into every slot (settings, manager, top bar) and marks it in the picker. */
function applyIcon(scope = document) {
    const spec = settings().icon;
    const html = iconHtml(spec);
    for (const el of scope.querySelectorAll('.mh_icon_slot')) if (el.dataset.icon !== spec) { el.innerHTML = html; el.dataset.icon = spec; }
    for (const el of scope.querySelectorAll('.mh_iconpick')) el.classList.toggle('mh_on', el.dataset.icon === spec);
}
const iconLabel = spec => String(spec).startsWith('svg:') ? (SVG_ICONS[spec.slice(4)]?.[0] ?? spec) : spec;

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
    if (s.style == null && s.prompt != null) s.style = s.prompt.trim() === PROMPT_V1.trim() ? 'modules' : 'custom';
    if (s.prompt != null && s.prompt.trim() === PROMPT_V1.trim()) s.prompt = '';
    // migrate 1.1.0 styles to modules (1.1 raised the lengths for RPG by hand; modules now add them)
    if (s.style === 'single') { s.style = 'modules'; s.defaultModules = ['relationship']; }
    if (s.style === 'rpg') {
        s.style = 'modules'; s.defaultModules = ['ensemble', 'rpg'];
        if (s.memoryWords === 180) s.memoryWords = 120;
        if (s.overviewWords === 400) s.overviewWords = 250;
        if (s.responseLength === 1200) s.responseLength = 800;
    }
    if (s.style === 'auto') s.style = 'modules';
    // migrate 1.7.0: the plain-number badge was hard to read
    if (s.badgeStyle === 'plain') s.badgeStyle = 'badge';
    // migrate 1.5.x: the on/off switch became a mode
    if (s.mode == null && s.autoSummarize === false) s.mode = 'manual';
    delete s.autoSummarize;
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

// ---------------------------------------------------------------- prompt modules

/** Identity of the bot the open chat belongs to (per character, or per group). */
function botKey() {
    const c = ctx();
    if (c.groupId) return `group:${c.groupId}`;
    const ch = c.characters?.[c.characterId];
    return ch ? `char:${ch.avatar}` : null;
}
function botName() {
    const c = ctx();
    if (c.groupId) return c.groups?.find(g => g.id === c.groupId)?.name ?? 'กลุ่ม';
    return c.characters?.[c.characterId]?.name ?? '';
}
const lc = t => String(t ?? '').trim().toLowerCase();
/** Marks a card whose owner chose no modules at all (otherwise no module tags = the default set). */
const BASIC_TAG = 'memhub-basic';
const currentChar = () => { const c = ctx(); return c.groupId ? null : (c.characters?.[c.characterId] ?? null); };
/** Tags saved inside the card file itself. */
const cardTags = ch => [...new Set([...(Array.isArray(ch?.tags) ? ch.tags : []), ...(Array.isArray(ch?.data?.tags) ? ch.data.tags : [])].map(String))];
/** SillyTavern's tags for this bot (this install only) plus the card's own tags (travel with the card file). */
function botTagNames() {
    const c = ctx();
    const key = c.groupId ?? c.characters?.[c.characterId]?.avatar;
    const mapped = (key ? (c.tagMap?.[key] ?? []) : []).map(id => c.tags?.find(t => t.id === id)?.name);
    const seen = new Set();
    return [...mapped, ...cardTags(currentChar())].filter(t => t && !seen.has(lc(t)) && seen.add(lc(t)));
}
const moduleList = () => allModules(settings().customModules);
const isModuleTag = (t, mods = moduleList()) => lc(t) === BASIC_TAG || mods.some(m => (m.tags ?? []).some(x => lc(x) === lc(t)));

/** @returns {{ids:string[], from:'bot'|'tags'|'default', tags?:string[]}} */
function resolveModules() {
    const s = settings();
    const mods = moduleList();
    const known = new Set(mods.map(m => m.id));
    const key = botKey();
    const own = key ? s.botModules?.[key] : null;
    if (Array.isArray(own)) return { ids: own.filter(id => known.has(id)), from: 'bot' };
    const tags = botTagNames().filter(t => isModuleTag(t, mods));
    const byTag = modulesFromTags(tags, mods);
    if (byTag.length || tags.length) return { ids: byTag, from: 'tags', tags };
    const def = Array.isArray(s.defaultModules) ? s.defaultModules : (isGroup() ? ['ensemble', 'story'] : ['relationship']);
    return { ids: def.filter(id => known.has(id)), from: 'default' };
}
/**
 * Sets this bot's modules. A character gets them as tags on its card, so the
 * same modules apply on every device and app that opens the card; a group
 * (no card) keeps them in this install's settings.
 */
function setBotModules(ids) {
    const key = botKey();
    if (!key) { toast.warn('เปิดแชทก่อน'); return false; }
    const want = new Set(ids);
    const list = moduleList().map(m => m.id).filter(id => want.has(id));
    const ch = currentChar();
    if (ch) {
        tagCard(ch, list);
        delete settings().botModules[key];
    } else {
        settings().botModules[key] = list;
    }
    saveSettings();
    return true;
}

/**
 * Makes the card's module tags match `ids` (null = remove them all, back to the default).
 * Updates SillyTavern's tag list right away and writes the card file in the background.
 */
function tagCard(ch, ids, { quiet = false } = {}) {
    const s = settings();
    const c = ctx();
    const mods = moduleList();
    const wanted = ids ? mods.filter(m => ids.includes(m.id)) : [];
    const current = botTagNames();
    const keep = t => (ids && !wanted.length && lc(t) === BASIC_TAG) || wanted.some(m => (m.tags ?? []).some(x => lc(x) === lc(t)));
    const remove = current.filter(t => isModuleTag(t, mods) && !keep(t));
    const add = [];
    for (const m of wanted) {
        if (current.some(t => (m.tags ?? []).some(x => lc(x) === lc(t)))) continue;
        if (m.tags?.length) { add.push(m.tags[0]); continue; }
        // one of our own modules without tags: its name becomes its tag
        const own = s.customModules.find(x => x.id === m.id);
        if (own) own.tags = [m.name];
        add.push(m.name);
    }
    if (ids && !wanted.length && !current.some(t => lc(t) === BASIC_TAG)) add.push(BASIC_TAG);
    if (!add.length && !remove.length) return;

    // SillyTavern's tags (this install)
    const gone = new Set(remove.map(lc));
    const map = c.tagMap;
    const tags = c.tags;
    if (map && tags) {
        map[ch.avatar] = (map[ch.avatar] ?? []).filter(id => !gone.has(lc(tags.find(t => t.id === id)?.name)));
        for (const name of add) {
            let tag = tags.find(t => lc(t.name) === lc(name));
            if (!tag) {
                tag = {
                    id: globalThis.crypto?.randomUUID?.() ?? uid(), name,
                    folder_type: 'NONE', filter_state: 'UNDEFINED',
                    sort_order: Math.max(0, ...tags.map(t => t.sort_order ?? 0)) + 1,
                    is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now(),
                };
                tags.push(tag);
            }
            if (!map[ch.avatar].includes(tag.id)) map[ch.avatar].push(tag.id);
        }
        saveSettings();
    }

    // the card file (goes wherever the card goes)
    const before = cardTags(ch);
    const names = [...before.filter(t => !gone.has(lc(t))), ...add.filter(t => !before.some(x => lc(x) === lc(t)))];
    writeCardTags(ch, names).catch(e => toast.err(`บันทึกแท็กลงไฟล์การ์ดไม่สำเร็จ: ${errText(e)}\nแท็กยังอยู่ในเครื่องนี้ แต่จะไม่ติดการ์ดไปเครื่องอื่น`));
    if (!quiet) {
        const parts = [add.length ? `เพิ่ม ${add.join(', ')}` : '', remove.length ? `เอาออก ${remove.join(', ')}` : ''].filter(Boolean);
        toast.info(`แท็กของการ์ด ${ch.name}: ${parts.join(' · ')}`);
    }
}

async function writeCardTags(ch, names) {
    ch.tags = names;
    if (ch.data) ch.data.tags = names;
    if (ch.json_data) {
        try {
            const j = JSON.parse(ch.json_data);
            j.tags = names;
            if (j.data) j.data.tags = names;
            ch.json_data = JSON.stringify(j);
        } catch { /* keep what ST has */ }
    }
    const res = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ avatar: ch.avatar, tags: names, data: { tags: names } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** 1.7.x kept a character's modules in this install's settings; move them onto the card. */
function migrateBotModules() {
    const s = settings();
    const ch = currentChar();
    const key = botKey();
    if (!ch || !key || !Array.isArray(s.botModules?.[key])) return;
    const ids = s.botModules[key];
    delete s.botModules[key];
    tagCard(ch, ids);
    saveSettings();
    toast.info(`ย้ายโมดูลที่เลือกไว้ของ ${ch.name} ไปเป็นแท็กบนการ์ดแล้ว เครื่องอื่นที่เปิดการ์ดนี้จะใช้โมดูลชุดเดียวกัน`);
}
const MOD_FROM_TH = { bot: 'เลือกเอง', tags: 'จากแท็กของการ์ด', default: 'ค่าเริ่มต้น' };
/** Tooltip text: what it remembers, which bots it suits, which tags switch it on. */
function moduleTip(m) {
    return [m.name, m.desc && `จำ: ${m.desc}`, m.fit && `เหมาะกับ: ${m.fit}`, m.tags?.length && `แท็กที่เปิดเอง: ${m.tags.join(', ')}`].filter(Boolean).join('\n');
}

function activeModules() {
    const ids = new Set(resolveModules().ids);
    return moduleList().filter(m => ids.has(m.id));
}
function wordBudget({ boost } = {}) {
    const s = settings();
    const extra = s.autoWords ? extraWords(activeModules()) : { memory: 0, overview: 0 };
    // more messages per memory need longer memories; the default chunk is the baseline
    const per = s.autoWords ? Math.max(1, s.chunkSize / DEFAULTS.chunkSize) : 1;
    const scale = per * (boost ?? (Number(s.quotaBoost) || 1));
    const memory = Math.round((s.memoryWords + extra.memory) * scale);
    const overview = s.overviewWords + extra.overview;
    // Thai runs 3-5 tokens a word and "thinking" models spend part of the budget
    // on reasoning; the limit only caps the answer, it costs nothing unused
    const response = Math.max(s.responseLength, Math.ceil((memory + (s.overviewEnabled ? overview : 0)) * 5 + 400));
    // models cannot count Thai words, so the length is also given as a number of bullets
    const bullets = Math.min(Math.round(10 * Math.max(1, scale)), Math.max(4, Math.round(memory / 22)));
    // longer memories need a bigger recall budget to fit the same number of them
    const recall = Math.round(s.recallBudget * memory / Math.max(1, s.memoryWords));
    return { memory, overview, response, bullets, recall, per };
}

// ---------------------------------------------------------------- model calls (with fallback chain)

let lastApi = null; // { ok:boolean, label:string, error?:string, at:number, fallback?:boolean }
/** What is running now, for the top bar: { label, done, total, range?, api?, attempt? } */
let job = null;
let queued = 0;       // summary runs waiting behind the current one
let lastJob = null;   // { ok:boolean, text:string, at:number }

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
/** Set by callModel: the returned answer was cut off (every retry was, too). */
let lastCallPartial = false;

/**
 * Tries each API in order. An API "fails" when it throws, times out, or
 * answers without anything `accept` can use. `complete` tells a finished
 * answer from one cut off by the token limit: a cut-off answer is retried
 * once on the same API with twice the limit before moving on, and if every
 * API only gives cut-off answers, the longest one is used (flagged).
 */
async function callModel(system, user, maxTokens, accept = out => !!String(out ?? '').trim(), complete = () => true) {
    const s = settings();
    const order = activeSources();
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const errors = [];
    let partial = null;
    lastCallPartial = false;
    for (let i = 0; i < order.length; i++) {
        const src = order[i];
        if (job) { job.api = sourceLabel(src); job.attempt = i + 1; job.attempts = order.length; renderTopbar(); }
        let limit = maxTokens;
        for (let round = 0; round < 2; round++) {
            try {
                const out = await callOne(src, messages, limit, s.timeoutSec * 1000);
                if (!String(out ?? '').trim()) throw new Error('ได้คำตอบว่าง (อาจโดน safety filter หรือโควต้าหมด)');
                if (!accept(out)) throw new Error('คำตอบไม่อยู่ในรูปแบบที่ต้องการ');
                if (!complete(out)) {
                    if (!partial || out.length > partial.length) partial = out;
                    if (round === 0) { limit = Math.min(16000, limit * 2); console.warn(LOG, `answer cut off, retrying with ${limit} tokens`); continue; }
                    throw new Error(`คำตอบถูกตัดกลางคัน แม้ขยายเป็น ${limit} โทเคนแล้ว (โมเดลอาจใช้โทเคนไปกับการคิด)`);
                }
                if (i > 0) toast.warn(`${errors.join(' · ')}\n→ ใช้ ${sourceLabel(src)} แทนแล้ว`, { timeOut: 8000 });
                lastApi = { ok: true, label: sourceLabel(src), fallback: i > 0, at: Date.now() };
                return out;
            } catch (e) {
                console.warn(LOG, `API ${sourceLabel(src)} failed`, e);
                errors.push(`${sourceLabel(src)}: ${errText(e)}`);
                break;
            }
        }
    }
    if (partial) {
        lastCallPartial = true;
        lastApi = { ok: true, label: `${sourceLabel(order[0])} (คำตอบไม่ครบ)`, at: Date.now() };
        toast.warn(`ทุก API ตอบไม่จบ ใช้คำตอบที่ได้ไปก่อน ความจำก้อนนี้จะมี ⚠ — ลองเพิ่ม Response length แล้วกด 🔄 สรุปใหม่\n${errors.join(' · ')}`, { timeOut: 15000 });
        return partial;
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
    const w = wordBudget();
    const p = String(template)
        .replaceAll('{{overview_rule}}', withOverview ? buildOverviewRule(activeModules()) : '')
        .replaceAll('{{overview_format}}', withOverview ? OVERVIEW_FORMAT : '')
        .replaceAll('{{overview_words}}', String(w.overview))
        .replaceAll('{{memory_words}}', String(w.memory))
        .replaceAll('{{memory_bullets}}', String(w.bullets));
    return ctx().substituteParams(p);
}

function summaryTemplate() {
    const s = settings();
    if (s.style === 'custom' && String(s.prompt ?? '').trim()) return s.prompt;
    return buildPrompt(activeModules(), { group: isGroup() });
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

    const raw = await callModel(fill(summaryTemplate(), withOverview), ctx().substituteParams(parts.join("\n\n")), wordBudget().response,
        out => !!parseSummary(out).text, out => isComplete(out, { overview: withOverview }));
    // flag the memory only when the memory part itself was cut (a missing overview just keeps the old one)
    const partial = lastCallPartial && !isComplete(raw);
    if (ctx().chatId !== chatId) throw new Error('เปลี่ยนแชทระหว่างสรุป ผลลัพธ์ถูกทิ้ง');

    const parsed = parseSummary(raw);
    const keys = cleanKeys(parsed.keys, mainNames());
    const cur = state();
    let mem;
    if (replaceId) {
        mem = cur.memories.find(m => m.id === replaceId);
        if (mem) Object.assign(mem, { title: parsed.title || mem.title, keys: keys.length ? keys : mem.keys, text: parsed.text, ts: Date.now(), truncated: partial || undefined });
    }
    if (!mem) {
        mem = { id: uid(), start, end, title: parsed.title || `#${start}–#${end}`, keys, text: parsed.text, pinned: false, source: 'auto', ts: Date.now(), ...(partial ? { truncated: true } : {}) };
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
/** How many chunks a run would take right now. */
function plannedChunks(force, keepRaw) {
    const st = state();
    if (!st) return 0;
    const s = settings();
    let n = 0;
    let end = st.lastEnd;
    for (let c = nextChunk(end, ctx().chat.length, s.chunkSize, keepRaw ?? s.keepRaw, force); c && n < 10000; c = nextChunk(end, ctx().chat.length, s.chunkSize, keepRaw ?? s.keepRaw, force)) { n++; end = c.end; }
    return n;
}

function runSummaries({ force = false, quiet = false, keepRaw = null } = {}) {
    if (busy) {
        queued++; renderTopbar();
        return busy.then(() => { queued = Math.max(0, queued - 1); return runSummaries({ force, quiet, keepRaw }); });
    }
    cancelRequested = false;
    busy = (async () => {
        let made = 0;
        let failed = false;
        let progress = null;
        job = { label: 'สรุปข้อความ', done: 0, total: plannedChunks(force, keepRaw) };
        renderTopbar();
        try {
            for (;;) {
                if (cancelRequested) break;
                const st = state();
                if (!st) break;
                const s = settings();
                const chunk = nextChunk(st.lastEnd, ctx().chat.length, s.chunkSize, keepRaw ?? s.keepRaw, force);
                if (!chunk) break;
                // the top bar panel already shows progress; no toast on top of it
                if ((!quiet || made > 0) && !barPanel?.classList.contains('mh_open')) {
                    if (progress) globalThis.toastr?.clear(progress);
                    progress = toast.info(`กำลังสรุปข้อความ #${chunk.start}–#${chunk.end}…`, { timeOut: 0, extendedTimeOut: 0 });
                }
                job.range = `#${chunk.start}–#${chunk.end}`;
                renderTopbar();
                const mem = await summarizeRange(chunk.start, chunk.end);
                job.done++;
                if (!mem) { state().lastEnd = chunk.end; saveState(); continue; }
                made++;
                refreshUi();
            }
        } catch (e) {
            failed = true;
            console.error(LOG, e);
            autoPausedUntil = ctx().chat.length + 4;
            lastJob = { ok: false, text: `สรุป ${job?.range ?? ''} ไม่สำเร็จ: ${errText(e)}`, at: Date.now() };
            toast.err(`สรุปไม่สำเร็จ ลองครบทุก API แล้ว:\n${errText(e)}`, { timeOut: 15000 });
        } finally {
            if (progress) globalThis.toastr?.clear(progress);
            busy = null;
            job = null;
            if (made && !failed) lastJob = { ok: true, text: `สร้างความจำใหม่ ${made} ก้อน`, at: Date.now() };
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
    if (!s.enabled || type === 'quiet') return;
    const st = state();
    if (!st) return;
    const len = ctx().chat.length;
    if (s.mode === 'manual') return warnBacklog(st, len);
    if (len < autoPausedUntil) return;
    if (!nextChunk(st.lastEnd, len, s.chunkSize, s.keepRaw)) return;
    if (s.mode === 'semi') return askToSummarize(st, len);
    runSummaries({ quiet: true });
}

const MODE_TH = { auto: 'อัตโนมัติ', semi: 'กึ่งอัตโนมัติ', manual: 'สรุปเอง (Manual)' };
const pendingOf = (st, len) => Math.max(0, len - 1 - st.lastEnd);
/** Unsummarized messages worth a warning when nothing summarizes them on its own. */
const backlogAt = s => Math.max(40, s.chunkSize * 2);
function hasBacklog(s, st, len) {
    return s.enabled && s.mode !== 'auto' && pendingOf(st, len) >= backlogAt(s);
}

let backlogWarned = 0; // pending count at the last manual-mode warning
function warnBacklog(st, len) {
    const s = settings();
    const pending = pendingOf(st, len);
    if (pending < backlogWarned) backlogWarned = 0;
    if (!hasBacklog(s, st, len) || (backlogWarned && pending < backlogWarned + s.chunkSize)) return;
    backlogWarned = pending;
    toast.warn(`ยังไม่ได้สรุป ${pending} ข้อความ ข้อความเหล่านี้ถูกส่งเต็มทุกเทิร์น ยิ่งค้างยิ่งเปลืองโทเคน และถ้าเกิน context ข้อความเก่าสุดจะหลุดไปโดยยังไม่ถูกจำ\nแตะที่นี่เพื่อสรุปเลย`,
        { timeOut: 15000, onclick: () => summarizeNow() });
}

let asking = false;
/** Semi-auto: the chunk is due, ask before summarizing. */
async function askToSummarize(st, len) {
    if (asking || busy || len < (st.remindAt ?? 0)) return;
    asking = true;
    try {
        const s = settings();
        const c = ctx();
        const chatId = c.chatId;
        const box = document.createElement('div');
        box.className = 'mh_carry';
        box.innerHTML = `
          <h3>ถึงรอบสรุปแล้ว</h3>
          <p>ยังไม่สรุป <b>${pendingOf(st, len)}</b> ข้อความ สรุปตอนนี้จะได้ความจำ ${plannedChunks(false, null)} ก้อน (ก้อนละ ${s.chunkSize} ข้อความ) สรุปเลยไหม?</p>
          <label class="mh_row"><span>ถ้ายังไม่สรุป ถามอีกครั้งในอีก (ข้อความ)</span><input type="number" class="text_pole mh_snooze_in" min="1" max="200"></label>
          <small>ระหว่างที่ยังไม่สรุป ข้อความเหล่านี้ถูกส่งแบบเต็มทุกเทิร์น</small>`;
        const input = box.querySelector('.mh_snooze_in');
        input.value = s.semiSnooze;
        const ok = await c.callGenericPopup(box, c.POPUP_TYPE.CONFIRM, '', { okButton: 'สรุปเลย', cancelButton: 'ยังก่อน' });
        if (ctx().chatId !== chatId) return;
        if (ok) {
            delete st.remindAt; saveState();
            await runSummaries({});
        } else {
            s.semiSnooze = clampInt(input.value, 1, 200, DEFAULTS.semiSnooze); saveSettings();
            st.remindAt = ctx().chat.length + s.semiSnooze; saveState();
            toast.info(`จะถามอีกครั้งในอีก ${s.semiSnooze} ข้อความ หรือกด "สรุปเดี๋ยวนี้" เมื่อไหร่ก็ได้`);
        }
    } finally {
        asking = false;
        refreshUi();
    }
}

/** Switching to manual: explain what piling up messages costs, offer a bigger quota. */
async function confirmManual() {
    const s = settings();
    const c = ctx();
    const opts = [1, 1.5, 2, 3].map(b => {
        const w = wordBudget({ boost: b });
        return `<label class="checkbox_label"><input type="radio" name="mh_boost_pick" value="${b}"${b === (Number(s.quotaBoost) || 1) ? ' checked' : ''}>
          ${b === 1 ? 'คงเดิม' : `เพิ่ม ×${b}`} — ความจำก้อนละ ≤ ${w.memory} คำ · งบความจำที่ดึง ${w.recall} โทเคน</label>`;
    }).join('');
    const box = document.createElement('div');
    box.className = 'mh_carry';
    box.innerHTML = `
      <h3>โหมดสรุปเอง (Manual)</h3>
      <p>Memory Hub จะไม่สรุปเอง ต้องกด "สรุปเดี๋ยวนี้" เอง ถ้าปล่อยให้ค้างทีละเยอะ ๆ จะมีผลแบบนี้</p>
      <ul>
        <li>ข้อความที่ยังไม่สรุปถูกส่งแบบเต็มทุกเทิร์น ยิ่งค้างมาก ยิ่งเปลืองโทเคนต่อเทิร์น</li>
        <li>ถ้าค้างจนเกิน context ของโมเดล SillyTavern จะตัดข้อความเก่าสุดออกจาก prompt บอทจะลืมช่วงนั้นไปจนกว่าจะสรุป</li>
        <li>กดสรุปทีเดียวหลายร้อยข้อความ จะเรียก API หลายรอบติดกัน (ก้อนละ ${s.chunkSize} ข้อความ) ใช้เวลานาน และอาจชนโควต้าของ API ฟรี</li>
        <li>ถ้าตั้งให้ความจำหนึ่งก้อนครอบคลุมข้อความเยอะ รายละเอียดเล็ก ๆ จะหายมากขึ้น</li>
      </ul>
      <p><b>จะเพิ่มโควต้าโทเคนไหม?</b> ความจำแต่ละก้อนจะยาวและละเอียดขึ้น และงบความจำที่ดึงขยายตาม (ดึงได้จำนวนก้อนเท่าเดิม) แต่ prompt ทุกเทิร์นจะยาวขึ้น</p>
      ${opts}
      <small>เมื่อค้างเกิน ${backlogAt(s)} ข้อความ จะมีแจ้งเตือน เปลี่ยนตัวคูณได้ภายหลังในหัวข้อ "จังหวะการสรุป"</small>`;
    const ok = await c.callGenericPopup(box, c.POPUP_TYPE.CONFIRM, '', { okButton: 'ใช้โหมด Manual', cancelButton: 'ยกเลิก' });
    if (!ok) return false;
    const pick = Number(box.querySelector('input[name=mh_boost_pick]:checked')?.value);
    if (pick) s.quotaBoost = pick;
    return true;
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

    // budget: pinned first, then the latest, then by relevance;
    // pinned and the latest always go in, even over the budget
    const budget = wordBudget().recall;
    const picked = [];
    let tokens = 0;
    for (const m of chosen.values()) {
        const t = await countTokens(memoryBlock(m));
        const must = m.pinned || (s.includeLatest && m.id === latest?.id);
        if (!must && tokens + t > budget) continue;
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
    mergeForeign(other, id);
}

/** Adds another chat's (or an export file's) memories before this chat's own ones. */
function mergeForeign(other, id) {
    const st = state();
    const seen = new Set(st.memories.map(m => m.text));
    let n = 0;
    const incoming = (other.memories ?? []).filter(m => m?.text && !seen.has(m.text)).map(m => {
        const { overviewAfter: _drop, stats: _stats, sourceMessages: _src, ...rest } = m;
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
    const limit = wordBudget().memory * 3; // tokens; Thai runs ~2-3 tokens per word
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
    job = { label: 'จัดระเบียบที่นำเข้า', done: 0, total: batches.length };
    busy = (async () => {
        try {
            for (const [bi, batch] of batches.entries()) {
                if (cancelRequested) break;
                job.done = bi; job.range = `ชุด ${bi + 1}`; renderTopbar();
                if (progress) globalThis.toastr?.clear(progress);
                progress = toast.info(`จัดระเบียบความจำที่นำเข้า ชุด ${bi + 1}/${batches.length}…`, { timeOut: 0, extendedTimeOut: 0 });
                const user = batch.map((m, i) => `MEMORY id="${i}":\ntitle: ${m.title}\nkeys: ${(m.keys ?? []).join(', ')}\n${cleanText(m.text, 12000)}`).join('\n\n');
                const raw = await callModel(system, ctx().substituteParams(user), Math.min(4000, 350 * batch.length + 200), out => parseMany(out).size > 0, out => parseMany(out).size >= batch.length);
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
            lastJob = { ok: false, text: `จัดระเบียบไม่สำเร็จ: ${errText(e)}`, at: Date.now() };
        } finally {
            if (progress) globalThis.toastr?.clear(progress);
            busy = null;
            job = null;
            renderTopbar();
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
    job = { label: 'สร้างเรื่องย่อใหม่', done: 0, total: batches.length };
    busy = (async () => {
        try {
            for (const [bi, batch] of batches.entries()) {
                job.done = bi; job.range = `ชุด ${bi + 1}`; renderTopbar();
                if (progress) globalThis.toastr?.clear(progress);
                progress = toast.info(`สร้างเรื่องย่อใหม่ ${bi + 1}/${batches.length}…`, { timeOut: 0, extendedTimeOut: 0 });
                const user = `PREVIOUS OVERVIEW:\n${overview || '(none yet)'}\n\nMEMORIES:\n${batch.map(memoryBlock).join('\n')}`;
                const raw = await callModel(fill(PROMPT_REBUILD, true), ctx().substituteParams(user), wordBudget().response, out => !!parseSummary(out).overview, out => isComplete(out, { memory: false, overview: true }));
                overview = parseSummary(raw).overview || overview;
            }
            const now = state();
            now.overview = overview;
            if (!now.memories.some(m => m.source === 'auto')) now.baseOverview = overview;
            saveState();
            toast.ok('สร้างเรื่องย่อใหม่แล้ว');
        } catch (e) {
            toast.err(`สร้างเรื่องย่อไม่สำเร็จ: ${errText(e)}`, { timeOut: 15000 });
            lastJob = { ok: false, text: `สร้างเรื่องย่อไม่สำเร็จ: ${errText(e)}`, at: Date.now() };
        } finally {
            if (progress) globalThis.toastr?.clear(progress);
            busy = null;
            job = null;
            renderTopbar();
        }
    })();
    await busy;
    refreshUi();
}

// ---------------------------------------------------------------- export

function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const fileSafe = s => String(s ?? '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chat';

/**
 * Everything needed to judge the summary prompt: the memories with how many
 * tokens of chat each one replaced, the prompt and settings that made them,
 * and (optionally) the original messages next to each memory.
 */
async function buildExport({ withSource = false } = {}) {
    const c = ctx();
    const s = settings();
    const st = state();
    const r = resolveModules();
    const w = wordBudget();
    const memories = [];
    let srcTotal = 0;
    let memTotal = 0;
    for (const m of st.memories) {
        const memTokens = await countTokens(memoryBlock(m));
        let srcTokens = null;
        let sourceMessages;
        if (m.source === 'auto' && m.end >= 0) {
            const msgs = c.chat.slice(m.start, m.end + 1).filter(x => x && !x.is_system);
            srcTokens = await countTokens(msgs.map(x => cleanText(x.mes, s.maxMessageChars)).join('\n'));
            srcTotal += srcTokens;
            memTotal += memTokens;
            if (withSource) sourceMessages = msgs.map(x => ({ name: x.name, is_user: !!x.is_user, mes: cleanText(x.mes, s.maxMessageChars) }));
        }
        const { overviewAfter: _o, ...rest } = m;
        memories.push({ ...rest, stats: { memTokens, srcTokens, ratio: srcTokens ? +(memTokens / srcTokens).toFixed(3) : null }, ...(sourceMessages ? { sourceMessages } : {}) });
    }
    return {
        format: 'memory-hub-export',
        version: VERSION,
        exportedAt: new Date().toISOString(),
        chat: c.getCurrentChatId(),
        bot: botName(),
        messages: c.chat.length,
        summarizedUpTo: st.lastEnd,
        chain: st.chain ?? [],
        prompt: {
            style: s.style,
            modules: activeModules().map(m => ({ id: m.id, name: m.name })),
            modulesFrom: r.from,
            memoryWords: w.memory,
            overviewWords: w.overview,
            responseLength: w.response,
            chunkSize: s.chunkSize,
            keepRaw: s.keepRaw,
            mode: s.mode,
            quotaBoost: s.quotaBoost,
            text: fill(summaryTemplate(), s.overviewEnabled),
        },
        recall: { topK: s.topK, budget: wordBudget().recall, queryDepth: s.queryDepth, lastInjection },
        stats: {
            memories: st.memories.length,
            summarizedSourceTokens: srcTotal,
            summarizedMemoryTokens: memTotal,
            compression: srcTotal ? +(memTotal / srcTotal).toFixed(3) : null,
            overviewTokens: await countTokens(st.overview),
        },
        overview: st.overview,
        memories,
    };
}

function exportMarkdown(x) {
    const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
    const lines = [
        `# Memory Hub — ${x.bot}`,
        '',
        `- แชท: ${x.chat}`,
        `- ส่งออกเมื่อ: ${new Date(x.exportedAt).toLocaleString()} · Memory Hub v${x.version}`,
        `- ข้อความทั้งหมด ${x.messages} · สรุปแล้วถึง #${x.summarizedUpTo} · ความจำ ${x.stats.memories} ก้อน`,
        `- prompt: ${x.prompt.style === 'custom' ? 'เขียนเองทั้งหมด' : `โมดูล ${x.prompt.modules.map(m => m.name).join(', ') || '(พื้นฐาน)'} (${{ bot: 'เลือกเอง', tags: 'จากแท็ก', default: 'ค่าเริ่มต้น' }[x.prompt.modulesFrom] ?? x.prompt.modulesFrom})`} · ความจำ ≤ ${x.prompt.memoryWords} คำ · เรื่องย่อ ≤ ${x.prompt.overviewWords} คำ · สรุปทีละ ${x.prompt.chunkSize} ข้อความ`,
        `- ย่อข้อความ ${x.stats.summarizedSourceTokens} โทเคน เหลือ ${x.stats.summarizedMemoryTokens} โทเคน (${pct(x.stats.compression)}) · เรื่องย่อ ${x.stats.overviewTokens} โทเคน`,
        '',
        '## เรื่องย่อจนถึงตอนนี้',
        '',
        x.overview || '_(ยังไม่มี)_',
        '',
        `## ความจำ (${x.memories.length})`,
        '',
    ];
    x.memories.forEach((m, i) => {
        const where = m.end >= 0 ? `#${m.start}–#${m.end}` : m.source === 'carry' ? 'จากแชทก่อน' : m.source === 'import' ? 'นำเข้า' : 'เพิ่มเอง';
        const st = m.stats.srcTokens ? ` · ต้นฉบับ ${m.stats.srcTokens} → ${m.stats.memTokens} โทเคน (${pct(m.stats.ratio)})` : ` · ${m.stats.memTokens} โทเคน`;
        lines.push(`### ${i + 1}. ${m.title || '(ไม่มีชื่อ)'}${m.pinned ? ' 📌' : ''}${m.truncated ? ' ⚠ คำตอบถูกตัด' : ''}`, '', `_${where}${st}_  `, `คีย์: ${(m.keys ?? []).join(', ') || '—'}`, '', String(m.text ?? '').trim(), '');
        if (m.sourceMessages?.length) {
            lines.push('<details><summary>ข้อความต้นฉบับ</summary>', '');
            for (const s of m.sourceMessages) lines.push(`> **${s.name}:** ${s.mes.replace(/\n+/g, ' ')}`, '>');
            lines.push('', '</details>', '');
        }
    });
    lines.push('## Prompt สรุปที่ใช้อยู่ตอนนี้', '', '```', x.prompt.text, '```', '');
    return lines.join('\n');
}

async function exportDialog() {
    if (!state()) return toast.warn('เปิดแชทก่อน');
    const c = ctx();
    const box = document.createElement('div');
    box.className = 'mh_export';
    box.innerHTML = `
      <h3>ส่งออกคลังความจำ</h3>
      <p>ได้ทั้งความจำ เรื่องย่อ prompt สรุปที่ใช้ และสถิติว่าแต่ละก้อนย่อข้อความจากกี่โทเคนเหลือกี่โทเคน ใช้เช็กว่า prompt ทำงานดีแค่ไหน</p>
      <label class="checkbox_label"><input type="checkbox" class="mh_ex_src"> แนบข้อความต้นฉบับไว้ใต้ความจำแต่ละก้อน (ไฟล์ใหญ่ขึ้น แต่เทียบได้ว่าสรุปตกหล่นอะไร)</label>
      <div class="mh_btns">
        <div class="menu_button mh_ex_md"><i class="fa-brands fa-markdown"></i> Markdown (อ่านง่าย)</div>
        <div class="menu_button mh_ex_json"><i class="fa-solid fa-file-code"></i> JSON (นำเข้ากลับได้)</div>
      </div>`;
    box.addEventListener('click', async e => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const md = t.closest('.mh_ex_md');
        const js = t.closest('.mh_ex_json');
        if (!md && !js) return;
        const x = await buildExport({ withSource: box.querySelector('.mh_ex_src').checked });
        const base = `memory-hub - ${fileSafe(x.chat)}`;
        if (md) download(`${base}.md`, exportMarkdown(x), 'text/markdown;charset=utf-8');
        else download(`${base}.json`, JSON.stringify(x, null, 2), 'application/json');
        toast.ok('ส่งออกแล้ว');
    });
    await new c.Popup(box, c.POPUP_TYPE.TEXT, '', { okButton: 'ปิด' }).show();
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
            <div class="menu_button" id="mh_open"><span class="mh_icon_slot"></span> เปิดคลังความจำ</div>
            <div class="menu_button" id="mh_now"><i class="fa-solid fa-wand-magic-sparkles"></i> สรุปตอนนี้</div>
            <div class="menu_button" id="mh_last"><i class="fa-solid fa-eye"></i> ดูสิ่งที่ส่งล่าสุด</div>
            <div class="menu_button" id="mh_carry"><i class="fa-solid fa-forward"></i> เริ่มแชทใหม่ต่อเรื่อง</div>
          </div>
          <div id="mh_warn" class="mh_warn"></div>

          <label class="checkbox_label"><input type="checkbox" id="mh_enabled"> เปิดใช้งาน</label>
          <label class="mh_row"><span>การสรุป</span>
            <select id="mh_mode" class="text_pole">
              <option value="auto">อัตโนมัติ (Automatic)</option>
              <option value="semi">กึ่งอัตโนมัติ (Semi-auto) — ถามก่อน</option>
              <option value="manual">สรุปเอง (Manual)</option>
            </select></label>
          <small id="mh_mode_hint" class="mh_hint"></small>
          <label class="checkbox_label" title="ข้อความที่สรุปแล้วจะไม่ถูกส่งซ้ำ ประหยัดที่สุด แชทจริงไม่ถูกลบหรือซ่อน"><input type="checkbox" id="mh_trim"> ไม่ส่งข้อความที่สรุปแล้ว (ประหยัดโทเคนมากที่สุด)</label>
          <label class="checkbox_label"><input type="checkbox" id="mh_overview"> มี "เรื่องย่อจนถึงตอนนี้" หนึ่งก้อน</label>
          <label class="checkbox_label"><input type="checkbox" id="mh_latest"> ใส่ความจำก้อนล่าสุดเสมอ (ต่อเนื่องกับข้อความดิบ)</label>
          <label class="checkbox_label"><input type="checkbox" id="mh_notify"> แจ้งเตือนเมื่อสร้างความจำใหม่</label>
          <label class="checkbox_label" title="ปุ่มสมองบนแถบด้านบนของแชท: ดูคิวที่กำลังสรุป สรุปถึงข้อความไหนแล้ว และปุ่มสรุปทันที / สรุปแล้วขึ้นแชทใหม่"><input type="checkbox" id="mh_topbar"> ปุ่มบนแถบด้านบนของแชท (ใช้ร่วมกับ Top Info Bar)</label>
          <label class="checkbox_label mh_sub" title="ถ้าไม่ได้ติดตั้ง Top Info Bar จะสร้างแถบบาง ๆ ของ Memory Hub เองเหนือแชท"><input type="checkbox" id="mh_topbar_fb"> ถ้าไม่มี Top Info Bar ให้สร้างแถบเอง</label>
          <div class="mh_sub mh_iconrow"><span>ไอคอน</span><div id="mh_icons" class="mh_icons"></div></div>
          <div class="mh_sub">
            <label class="mh_row"><span>ป้ายตัวเลข</span>
              <select id="mh_bstyle" class="text_pole">
                <option value="badge">ป้ายมีขอบ</option>
                <option value="pill">ป้ายไม่มีขอบ</option>
                <option value="replace">ตัวเลขแทนไอคอน</option>
                <option value="none">ไม่แสดง</option>
              </select></label>
            <label class="mh_row"><span>ตำแหน่งป้าย</span>
              <select id="mh_bpos" class="text_pole">
                <option value="br">ขวาล่าง</option>
                <option value="tr">ขวาบน</option>
                <option value="bl">ซ้ายล่าง</option>
                <option value="center">ตรงกลาง (ทับไอคอน)</option>
              </select></label>
            <label class="mh_row"><span>สีป้าย</span>
              <select id="mh_bcolor" class="text_pole">
                <option value="theme">ตามธีม (สีตัวหนังสือหลัก)</option>
                <option value="quote">ตามธีม: สีคำพูด (Quote)</option>
                <option value="em">ตามธีม: สีตัวเอียง (Em)</option>
                <option value="underline">ตามธีม: สีขีดเส้นใต้</option>
                <option value="custom">เลือกเอง</option>
              </select></label>
            <div class="mh_row" id="mh_bcustom"><span>สีตัวเลข / สีพื้นป้าย</span>
              <span class="mh_colors"><input type="color" id="mh_bfg" title="สีตัวเลข (และขอบ)"><input type="color" id="mh_bbg" title="สีพื้นป้าย"></span></div>
            <label class="mh_row"><span>ขนาดตัวเลข</span>
              <select id="mh_bsize" class="text_pole"><option value="9">เล็ก</option><option value="11">กลาง</option><option value="13">ใหญ่</option></select></label>
          </div>

          <h4>Prompt สรุป</h4>
          <label class="mh_row"><span>แบบ</span>
            <select id="mh_style" class="text_pole">
              <option value="modules">ประกอบจากโมดูลตามบอท (แนะนำ)</option>
              <option value="custom">เขียนเองทั้งหมด</option>
            </select></label>
          <div id="mh_modbox" class="mh_modbox">
            <div class="mh_modhead"><b>โมดูลของบอทนี้:</b> <span id="mh_botname"></span></div>
            <small id="mh_modsrc" class="mh_hint"></small>
            <div id="mh_mods" class="mh_mods"></div>
            <div id="mh_modinfo" class="mh_modinfo">ชี้หรือแตะที่โมดูลเพื่อดูว่าเหมาะกับแนวไหน</div>
            <div class="mh_btns">
              <div class="menu_button" id="mh_mod_reset" title="เอาแท็กโมดูลออกจากการ์ด (แชทกลุ่ม: เลิกใช้ที่เลือกไว้) แล้วกลับไปใช้ค่าเริ่มต้น"><i class="fa-solid fa-rotate-left"></i> กลับไปใช้ค่าเริ่มต้น</div>
              <div class="menu_button" id="mh_mod_setdef" title="บอทที่ยังไม่ได้เลือกและไม่มีแท็กที่ตรง จะใช้ชุดนี้"><i class="fa-solid fa-star"></i> ตั้งชุดนี้เป็นค่าเริ่มต้น</div>
              <div class="menu_button" id="mh_mod_preview"><i class="fa-solid fa-eye"></i> ดู prompt ที่ประกอบแล้ว</div>
              <div class="menu_button" id="mh_mod_manage"><i class="fa-solid fa-puzzle-piece"></i> จัดการโมดูล / สร้างเอง</div>
            </div>
            <label class="checkbox_label"><input type="checkbox" id="mh_autowords"> ขยายความยาวความจำ เรื่องย่อ และงบความจำที่ดึง ตามโมดูลและจำนวนข้อความต่อก้อนอัตโนมัติ</label>
            <small id="mh_words_now" class="mh_hint"></small>
          </div>

          <h4>จังหวะการสรุป</h4>
          ${numberRow('mh_chunk', 'สรุปทุก ๆ (ข้อความ)', 'ข้อความต่อความจำหนึ่งก้อน ยิ่งมากยิ่งเรียก API น้อย ความจำแต่ละก้อนยาวขึ้นตาม', 4, 200)}
          ${numberRow('mh_snooze', 'ถ้ายังไม่สรุป ถามอีกครั้งในอีก (ข้อความ)', 'ค่าเริ่มต้นในหน้าต่างที่ถามก่อนสรุป', 1, 200)}
          <label class="mh_row" title="คูณความยาวความจำแต่ละก้อนและงบความจำที่ดึง ใช้เมื่อความจำก้อนหนึ่งครอบคลุมข้อความเยอะ หรืออยากได้ละเอียดขึ้น"><span>ตัวคูณโควต้าความจำ</span>
            <select id="mh_boost" class="text_pole"><option value="1">ปกติ ×1</option><option value="1.5">×1.5</option><option value="2">×2</option><option value="3">×3</option></select></label>
          ${numberRow('mh_keep', 'เก็บข้อความล่าสุดแบบเต็ม', 'ข้อความใหม่สุดกี่ข้อความที่จะยังไม่ถูกสรุป และส่งแบบเต็มเสมอ', 2, 200)}
          ${numberRow('mh_memwords', 'ความยาวความจำ (คำ)', 'ความยาวสูงสุดของความจำแต่ละก้อน', 30, 600)}
          ${numberRow('mh_ovwords', 'ความยาวเรื่องย่อ (คำ)', 'ความยาวสูงสุดของเรื่องย่อจนถึงตอนนี้', 50, 1500)}
          ${numberRow('mh_resp', 'Response length ตอนสรุป (โทเคน)', 'เพดานคำตอบของโมเดลตอนสรุป', 200, 8000)}

          <h4>การดึงความจำ</h4>
          ${numberRow('mh_topk', 'ดึงความจำที่เกี่ยวข้องสูงสุด (ก้อน)', 'ไม่นับก้อนล่าสุดและก้อนที่ปักหมุด', 0, 20)}
          ${numberRow('mh_budget', 'งบโทเคนของความจำที่ดึง', 'รวมทุกก้อนที่ดึงมา (ไม่นับเรื่องย่อ) ขยายตามโมดูลถ้าเปิดไว้ ก้อนที่ปักหมุดและก้อนล่าสุดใส่เสมอแม้เกินงบ', 100, 8000)}
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
                <label>Prompt ที่ใช้สรุป (แบบ "เขียนเองทั้งหมด" — ใช้กับทุกบอท)</label>
                <textarea id="mh_prompt" class="text_pole" rows="12"></textarea>
                <div class="mh_btns">
                  <div class="menu_button" id="mh_prompt_from_mods">เริ่มใหม่จากโมดูลของบอทนี้</div>
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
    $('#mh_mode').val(s.mode).on('change', async function () {
        const mode = this.value;
        if (mode === 'manual' && s.mode !== 'manual' && !(await confirmManual())) { this.value = s.mode; return; }
        s.mode = mode;
        saveSettings(); refreshUi();
    });
    $('#mh_boost').val(String(s.quotaBoost)).on('change', function () { s.quotaBoost = Number(this.value) || 1; saveSettings(); refreshUi(); });
    bindCheck('#mh_trim', 'trimSummarized');
    bindCheck('#mh_overview', 'overviewEnabled');
    bindCheck('#mh_latest', 'includeLatest');
    bindCheck('#mh_notify', 'notify');
    bindCheck('#mh_topbar', 'topbar');
    bindCheck('#mh_topbar_fb', 'topbarFallback');
    $('#mh_icons').html(ICONS.map(ic => `<div class="mh_iconpick" data-icon="${esc(ic)}" title="${esc(iconLabel(ic))}" tabindex="0">${iconHtml(ic)}</div>`).join(''))
        .on('click', '.mh_iconpick', function () { s.icon = this.dataset.icon; saveSettings(); applyIcon(); });
    const bindLook = (id, key, num) => $(id).val(String(s[key])).on('change input', function () { s[key] = num ? Number(this.value) || DEFAULTS[key] : this.value; saveSettings(); refreshUi(); });
    bindLook('#mh_bstyle', 'badgeStyle');
    bindLook('#mh_bpos', 'badgePos');
    bindLook('#mh_bcolor', 'badgeColor');
    bindLook('#mh_bfg', 'badgeFg');
    bindLook('#mh_bbg', 'badgeBg');
    bindLook('#mh_bsize', 'badgeSize', true);
    bindNum('#mh_chunk', 'chunkSize', 4, 200);
    bindNum('#mh_keep', 'keepRaw', 2, 200);
    bindNum('#mh_snooze', 'semiSnooze', 1, 200);
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
        s.style = this.value;
        // start the custom prompt from what this bot uses now
        if (s.style === 'custom' && !String(s.prompt ?? '').trim()) { s.prompt = buildPrompt(activeModules(), { group: isGroup() }); $('#mh_prompt').val(s.prompt); }
        saveSettings(); refreshUi();
    });
    $('#mh_prompt_from_mods').on('click', () => { s.prompt = buildPrompt(activeModules(), { group: isGroup() }); $('#mh_prompt').val(s.prompt); saveSettings(); });
    bindCheck('#mh_autowords', 'autoWords');
    $('#mh_mods').on('change', 'input[type=checkbox]', function () {
        const ids = new Set(resolveModules().ids);
        if (this.checked) ids.add(this.value); else ids.delete(this.value);
        setBotModules(ids);
        showModuleInfo(this.value);
        refreshUi();
    }).on('pointerenter focusin', '.mh_mod', function () {
        showModuleInfo(this.querySelector('input')?.value);
    });
    $('#mh_mod_reset').on('click', async () => {
        const key = botKey();
        if (!key) return;
        const ch = currentChar();
        if (ch) {
            const tags = resolveModules().tags ?? [];
            if (!tags.length) return;
            const ok = await ctx().callGenericPopup(`เอาแท็ก ${tags.join(', ')} ออกจากการ์ด ${ch.name}? บอทนี้จะกลับไปใช้โมดูลค่าเริ่มต้น`, ctx().POPUP_TYPE.CONFIRM);
            if (!ok) return;
            tagCard(ch, null);
        } else delete s.botModules[key];
        saveSettings(); refreshUi();
    });
    $('#mh_mod_setdef').on('click', () => { s.defaultModules = [...resolveModules().ids]; saveSettings(); refreshUi(); toast.ok('ตั้งเป็นค่าเริ่มต้นแล้ว'); });
    $('#mh_mod_preview').on('click', previewPrompt);
    $('#mh_mod_manage').on('click', manageModules);

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

function renderModulePicker() {
    const s = settings();
    $('#mh_modbox').toggle(s.style !== 'custom');
    const key = botKey();
    $('#mh_botname').text(key ? botName() : '(ยังไม่ได้เปิดแชท)');
    const r = resolveModules();
    const src = r.from === 'bot' ? 'เลือกเองสำหรับกลุ่มนี้ (เก็บในเครื่องนี้)'
        : r.from === 'tags' ? `จากแท็กของการ์ด: ${r.tags.join(', ')} — ติ๊กเพื่อเปลี่ยน แท็กบนการ์ดจะเปลี่ยนตาม`
            : `ค่าเริ่มต้น${Array.isArray(s.defaultModules) ? '' : (isGroup() ? ' (แชทกลุ่ม)' : ' (แชทเดี่ยว)')} — ${isGroup() ? 'ติ๊กเพื่อเลือกให้กลุ่มนี้' : 'ติ๊กเพื่อเลือก แล้ว Memory Hub จะแปะแท็กให้การ์ด ใช้ได้ทุกเครื่องที่เปิดการ์ดนี้'}`;
    $('#mh_modsrc').text(src);
    const on = new Set(r.ids);
    $('#mh_mods').html(moduleList().map(m => `
      <label class="mh_mod${on.has(m.id) ? ' mh_on' : ''}" title="${esc(moduleTip(m))}">
        <input type="checkbox" value="${esc(m.id)}"${on.has(m.id) ? ' checked' : ''}${key ? '' : ' disabled'}>
        <span>${esc(m.name)}${m.custom ? ' <i class="fa-solid fa-pen-nib" title="โมดูลของเรา"></i>' : ''}</span>
      </label>`).join(''));
    $('#mh_mod_reset').toggleClass('disabled', r.from === 'default');
    const w = wordBudget();
    $('#mh_words_now').text(`บอทนี้ (ก้อนละ ${settings().chunkSize} ข้อความ): ความจำ ≤ ${w.memory} คำ · เรื่องย่อ ≤ ${w.overview} คำ · response ${w.response} โทเคน · งบความจำที่ดึง ${w.recall} โทเคน`);
}

/** The line under the module chips: works on phones, where tooltips do not. */
function showModuleInfo(id) {
    const m = moduleList().find(x => x.id === id);
    const el = document.getElementById('mh_modinfo');
    if (!el) return;
    if (!m) { el.innerHTML = 'ชี้หรือแตะที่โมดูลเพื่อดูว่าเหมาะกับแนวไหน'; return; }
    el.innerHTML = `<b>${esc(m.name)}</b>${m.desc ? `<br>จำ: ${esc(m.desc)}` : ''}${m.fit ? `<br>เหมาะกับ: ${esc(m.fit)}` : ''}${m.tags?.length ? `<br><span class="mh_tp_dim">แท็กที่เปิดเอง: ${esc(m.tags.slice(0, 8).join(', '))}${m.tags.length > 8 ? ' …' : ''}</span>` : ''}`;
}

async function previewPrompt() {
    const s = settings();
    const { Popup, POPUP_TYPE } = ctx();
    const r = resolveModules();
    const names = activeModules().map(m => m.name).join(', ') || '(ไม่มี — ใช้แค่พื้นฐาน)';
    const text = fill(summaryTemplate(), s.overviewEnabled);
    const html = `<div class="mh_preview">
      <h3>Prompt สรุปของ ${esc(botName() || 'บอทนี้')}</h3>
      <p>${s.style === 'custom' ? 'แบบเขียนเองทั้งหมด' : `โมดูล: <b>${esc(names)}</b> (${r.from === 'bot' ? 'เลือกเอง' : r.from === 'tags' ? 'จากแท็ก' : 'ค่าเริ่มต้น'})`} · ${await countTokens(text)} โทเคน</p>
      <pre>${esc(text)}</pre></div>`;
    await new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true }).show();
}

const linesOf = v => String(v ?? '').split('\n').map(x => x.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);

async function manageModules() {
    const s = settings();
    const { Popup, POPUP_TYPE } = ctx();
    const root = document.createElement('div');
    root.className = 'mh_modmgr';
    const draw = () => {
        const customIds = new Set(s.customModules.map(m => m.id));
        root.innerHTML = `
          <h3><i class="fa-solid fa-puzzle-piece"></i> โมดูล prompt สรุป</h3>
          <p class="mh_hint">แต่ละโมดูลเพิ่มสิ่งที่ต้องจำเข้าไปใน prompt สรุป บอทจะได้โมดูลจาก (1) ที่เลือกเองในแผงตั้งค่า (2) แท็กของบอทใน SillyTavern ที่ตรงกับ "แท็ก" ของโมดูล (3) ค่าเริ่มต้น
          เขียนสิ่งที่ต้องจำเป็นภาษาอังกฤษจะได้ผลเสถียรที่สุด แต่ภาษาไทยก็ใช้ได้</p>
          <div class="mh_btns"><div class="menu_button mh_mod_new"><i class="fa-solid fa-plus"></i> สร้างโมดูลใหม่</div></div>
          ${s.customModules.map(m => moduleEditor(m, true)).join('')}
          <h4>โมดูลในตัว</h4>
          ${BUILTIN_MODULES.filter(m => !customIds.has(m.id)).map(m => moduleEditor(m, false)).join('')}`;
    };
    draw();
    const findCustom = el => s.customModules.find(m => m.id === el.closest('.mh_modcard')?.dataset.id);
    root.addEventListener('input', e => {
        const t = e.target;
        const m = findCustom(t);
        if (!m || !t.dataset.f) return;
        const f = t.dataset.f;
        if (f === 'keep' || f === 'skip') m[f] = linesOf(t.value);
        else if (f === 'tags') m.tags = t.value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
        else if (f === 'words' || f === 'overviewWords') m[f] = clampInt(t.value, 0, 1000, 0);
        else m[f] = t.value;
        saveSettings();
    });
    root.addEventListener('click', e => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest('.mh_mod_new')) {
            s.customModules.unshift({ id: `c_${uid()}`, name: 'โมดูลใหม่', desc: '', tags: [], keep: [], skip: [], keys: '', overview: '', words: 20, overviewWords: 40 });
            saveSettings(); draw(); refreshUi();
        } else if (t.closest('.mh_mod_copy')) {
            const id = t.closest('.mh_modcard').dataset.id;
            const b = moduleList().find(m => m.id === id);
            if (b) { s.customModules.unshift({ ...structuredClone(b), custom: undefined }); saveSettings(); draw(); refreshUi(); }
        } else if (t.closest('.mh_mod_del')) {
            const id = t.closest('.mh_modcard').dataset.id;
            s.customModules = s.customModules.filter(m => m.id !== id);
            saveSettings(); draw(); refreshUi();
        }
    });
    await new Popup(root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'ปิด' }).show();
    refreshUi();
}

function moduleEditor(m, editable) {
    const ro = editable ? '' : ' readonly';
    const builtinOverride = editable && !m.id.startsWith('c_');
    return `<div class="mh_modcard${editable ? ' mh_editable' : ''}" data-id="${esc(m.id)}">
      <div class="mh_card_head">
        <input class="text_pole mh_title" data-f="name" value="${esc(m.name)}"${ro}>
        ${editable
            ? `<i class="fa-solid fa-trash mh_icon mh_mod_del" title="${builtinOverride ? 'ลบฉบับที่แก้ แล้วกลับไปใช้ของในตัว' : 'ลบโมดูล'}"></i>`
            : '<div class="menu_button mh_mod_copy" title="ทำสำเนามาแก้ ฉบับของเราจะใช้แทนของในตัว">แก้ไข</div>'}
      </div>
      ${builtinOverride ? '<small class="mh_hint">ฉบับแก้ของโมดูลในตัว (ลบเพื่อกลับไปใช้ของเดิม)</small>' : ''}
      <label>จำอะไร (คำอธิบายสั้น ๆ)</label><input class="text_pole" data-f="desc" value="${esc(m.desc ?? '')}"${ro}>
      <label>เหมาะกับบอทแนวไหน</label><input class="text_pole" data-f="fit" value="${esc(m.fit ?? '')}"${ro}>
      <label>แท็กที่เปิดโมดูลนี้ (คั่นด้วย ,)</label><input class="text_pole" data-f="tags" value="${esc((m.tags ?? []).join(', '))}"${ro}>
      <label>สิ่งที่ต้องจำ (บรรทัดละข้อ)</label><textarea class="text_pole" data-f="keep" rows="3"${ro}>${esc((m.keep ?? []).join('\n'))}</textarea>
      <label>สิ่งที่ไม่ต้องจำ (บรรทัดละข้อ)</label><textarea class="text_pole" data-f="skip" rows="1"${ro}>${esc((m.skip ?? []).join('\n'))}</textarea>
      <label>คำแบบไหนควรเป็นคีย์</label><input class="text_pole" data-f="keys" value="${esc(m.keys ?? '')}"${ro}>
      <label>หัวข้อในเรื่องย่อ (เว้นว่างได้) เช่น <code>Clues: what is known and by whom</code></label><input class="text_pole" data-f="overview" value="${esc(m.overview ?? '')}"${ro}>
      <div class="mh_row"><span>คำเพิ่มต่อความจำ / เรื่องย่อ</span>
        <input type="number" class="text_pole" data-f="words" value="${Number(m.words) || 0}"${ro}>
        <input type="number" class="text_pole" data-f="overviewWords" value="${Number(m.overviewWords) || 0}"${ro}></div>
    </div>`;
}

function refreshUi() {
    const s = settings();
    const st = state();
    $('#mh_ovdepth').closest('.mh_row').toggle(s.overviewPosition === 'chat');
    $('#mh_recdepth').closest('.mh_row').toggle(s.recallPosition === 'chat');
    $('#mh_prompt_box').toggle(s.style === 'custom');
    $('#mh_mode').val(s.mode);
    $('#mh_boost').val(String(s.quotaBoost));
    $('#mh_mode_hint').text({
        auto: `สรุปเองทุก ๆ ${s.chunkSize} ข้อความ`,
        semi: `ทุก ๆ ${s.chunkSize} ข้อความจะขึ้นหน้าต่างถามก่อนสรุป`,
        manual: 'ไม่สรุปเอง กด "สรุปตอนนี้" เมื่อต้องการ (จะเตือนเมื่อค้างเยอะ)',
    }[s.mode] ?? '');
    $('#mh_chunk').siblings('span').text(s.mode === 'manual' ? 'ข้อความต่อความจำหนึ่งก้อน' : s.mode === 'semi' ? 'ถามทุก ๆ (ข้อความ)' : 'สรุปทุก ๆ (ข้อความ)');
    $('#mh_snooze').closest('.mh_row').toggle(s.mode === 'semi');
    $('#mh_bpos').closest('.mh_row').toggle(!['replace', 'none'].includes(s.badgeStyle));
    $('#mh_bcolor, #mh_bsize').closest('.mh_row').toggle(s.badgeStyle !== 'none');
    $('#mh_bcustom').toggle(s.badgeStyle !== 'none' && s.badgeColor === 'custom');
    renderModulePicker();

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
    if (st && hasBacklog(s, st, c.chat.length)) warns.push(`ยังไม่สรุป ${pendingOf(st, c.chat.length)} ข้อความ (โหมด${MODE_TH[s.mode]}) ข้อความเหล่านี้ถูกส่งเต็มทุกเทิร์น กด "สรุปตอนนี้" เพื่อประหยัดโทเคนและไม่ให้ข้อความเก่าหลุดจาก context`);
    $('#mh_warn').html(warns.map(w => `<div><i class="fa-solid fa-triangle-exclamation"></i> ${esc(w)}</div>`).join(''));

    if (managerEl?.isConnected) renderManagerHeader();
    renderTopbar();
    applyIcon();
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
        ${m.truncated ? '<span class="mh_trunc" title="คำตอบของโมเดลถูกตัดกลางคัน ความจำนี้อาจไม่ครบ — เพิ่ม Response length แล้วกด 🔄">⚠ ไม่ครบ</span>' : ''}
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
      <h3><span class="mh_icon_slot"></span> คลังความจำของแชทนี้</h3>
      <div class="mh_mgr_status"></div>
      <div class="mh_btns">
        <div class="menu_button mh_do_now"><i class="fa-solid fa-wand-magic-sparkles"></i> สรุปตอนนี้ / ย้อนหลัง</div>
        <div class="menu_button mh_do_add"><i class="fa-solid fa-plus"></i> เพิ่มความจำเอง</div>
        <div class="menu_button mh_do_import"><i class="fa-solid fa-file-import"></i> นำเข้า</div>
        <div class="menu_button mh_do_optimize"><i class="fa-solid fa-broom"></i> จัดระเบียบที่นำเข้า (AI)</div>
        <div class="menu_button mh_do_rebuild"><i class="fa-solid fa-book-open"></i> สร้างเรื่องย่อใหม่</div>
        <div class="menu_button mh_do_carry"><i class="fa-solid fa-forward"></i> เริ่มแชทใหม่ต่อเรื่อง</div>
        <div class="menu_button mh_do_export"><i class="fa-solid fa-file-export"></i> ส่งออก</div>
        <div class="menu_button mh_do_reset"><i class="fa-solid fa-eraser"></i> ล้างทั้งหมด</div>
      </div>
      <label><b>เรื่องย่อจนถึงตอนนี้</b> <small>(แก้ได้ · ถูกเขียนทับเมื่อสรุปก้อนถัดไป)</small></label>
      <textarea class="text_pole mh_overview_edit" rows="6" placeholder="ยังไม่มี"></textarea>
      <div class="mh_list_head"><b>ความจำ</b> <input class="text_pole mh_search" placeholder="ค้นหา…"></div>
      <div class="mh_list"></div>`;
    managerEl = root;
    renderManagerHeader();
    renderManagerList();
    applyIcon(root);

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
        if (t.closest('.mh_do_export')) { await exportDialog(); return; }
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
                job = { label: 'สรุปช่วงนี้ใหม่', done: 0, total: 1, range: `#${m.start}–#${m.end}` };
                busy = summarizeRange(m.start, m.end, { replaceId: m.id, updateOverview: false });
                await busy;
                toast.ok('สรุปช่วงนี้ใหม่แล้ว');
            } catch (err) { toast.err(`สรุปไม่สำเร็จ: ${errText(err)}`, { timeOut: 15000 }); } finally { busy = null; job = null; renderTopbar(); }
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
      <p><b>จากไฟล์ที่ส่งออกไว้</b> (.json ของ Memory Hub)</p>
      <label class="menu_button mh_file_btn"><i class="fa-solid fa-file-import"></i> เลือกไฟล์ .json<input type="file" class="mh_file" accept=".json,application/json" hidden></label>
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
    box.querySelector('.mh_file').addEventListener('change', async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (data?.format !== 'memory-hub-export' || !Array.isArray(data.memories)) throw new Error('ไม่ใช่ไฟล์ส่งออกของ Memory Hub');
            mergeForeign(data, data.chat || file.name);
        } catch (err) { toast.err(`นำเข้าไฟล์ไม่ได้: ${errText(err)}`); }
        e.target.value = '';
    });
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

// ---------------------------------------------------------------- chat top bar

const TOPBAR_ID = 'extensionTopBar';            // SillyTavern's "Top Info Bar" extension
const TOPBAR_NAME_ID = 'extensionTopBarChatName';
let barBtn = null;
let barPanel = null;
let ownBar = null;

function removeTopbar() {
    barBtn?.remove(); barPanel?.remove(); ownBar?.remove();
}

/** Puts the button in the top bar (before the chat name, like Memory Books) and the panel under it. */
function ensureTopbar() {
    const s = settings();
    if (!s.topbar) { removeTopbar(); return false; }
    let host = document.getElementById(TOPBAR_ID);
    if (host) {
        ownBar?.remove();
    } else {
        if (!s.topbarFallback) { removeTopbar(); return false; }
        const sheld = document.getElementById('sheld');
        const chat = document.getElementById('chat');
        if (!sheld || !chat) return false;
        if (!ownBar) {
            ownBar = document.createElement('div');
            ownBar.id = 'mh_ownbar';
            ownBar.innerHTML = '<span class="mh_ownbar_text"></span>';
        }
        if (ownBar.parentElement !== sheld) sheld.insertBefore(ownBar, chat);
        host = ownBar;
    }
    if (!barBtn) {
        barBtn = document.createElement('div');
        barBtn.id = 'mh_topbar_btn';
        barBtn.className = 'right_menu_button mh_topbtn';
        barBtn.tabIndex = 0;
        barBtn.setAttribute('role', 'button');
        barBtn.innerHTML = `<span class="mh_icon_slot"></span><span class="mh_topbadge"></span>`;
        const toggle = () => { barPanel?.classList.toggle('mh_open'); renderTopbar(); };
        barBtn.addEventListener('click', toggle);
        barBtn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
    const name = document.getElementById(TOPBAR_NAME_ID);
    if (barBtn.parentElement !== host) {
        if (host === ownBar) host.prepend(barBtn);
        else if (name?.parentElement === host) host.insertBefore(barBtn, name);
        else host.appendChild(barBtn);
    }
    if (!barPanel) {
        barPanel = document.createElement('div');
        barPanel.id = 'mh_topbar_panel';
        barPanel.addEventListener('click', onTopbarClick);
        barPanel.addEventListener('change', e => {
            const sel = e.target.closest?.('.mh_tp_add');
            if (!sel?.value) return;
            const id = sel.value;
            sel.blur(); // let the panel redraw (it waits while a list is open)
            if (setBotModules([...resolveModules().ids, id])) refreshUi();
        });
    }
    if (barPanel.parentElement !== host.parentElement) host.after(barPanel);
    return true;
}

async function onTopbarClick(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const a = t.closest('[data-mh]')?.dataset.mh;
    if (!a) return;
    e.preventDefault();
    if (a === 'close') barPanel.classList.remove('mh_open');
    else if (a === 'now') await summarizeNow();
    else if (a === 'carry') await continueInNewChat();
    else if (a === 'open') await openManager();
    else if (a === 'last') await showLastInjection();
    else if (a === 'stop') { cancelRequested = true; toast.info('จะหยุดหลังก้อนที่กำลังทำเสร็จ'); }
    else if (a === 'resume') { autoPausedUntil = 0; onMessageReceived(null, 'normal'); }
    else if (a === 'mod-del') {
        const id = t.closest('[data-id]')?.dataset.id;
        if (setBotModules(resolveModules().ids.filter(x => x !== id))) refreshUi();
    }
    renderTopbar();
}

function topbarModulesHtml() {
    const r = resolveModules();
    const on = new Set(r.ids);
    const mods = moduleList();
    const chips = mods.filter(m => on.has(m.id)).map(m => `<span class="mh_tp_chip" title="${esc(moduleTip(m))}">${esc(m.name)}<i class="fa-solid fa-xmark" data-mh="mod-del" data-id="${esc(m.id)}" title="เอาออก"></i></span>`).join('');
    const rest = mods.filter(m => !on.has(m.id));
    const add = rest.length ? `<select class="mh_tp_add" title="เพิ่มโมดูล"><option value="">＋ เพิ่ม</option>${rest.map(m => `<option value="${esc(m.id)}" title="${esc(moduleTip(m))}">${esc(m.name)}</option>`).join('')}</select>` : '';
    return `<div class="mh_tp_mods"><span class="mh_tp_dim">โมดูล (${MOD_FROM_TH[r.from] ?? r.from}):</span> ${chips || '<span class="mh_tp_dim">พื้นฐานอย่างเดียว</span>'} ${add}</div>`;
}

const ago = ts => {
    const m = Math.round((Date.now() - ts) / 60000);
    return m < 1 ? 'เมื่อกี้' : m < 60 ? `${m} นาทีที่แล้ว` : new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const BADGE_THEME = { quote: '--SmartThemeQuoteColor', em: '--SmartThemeEmColor', underline: '--SmartThemeUnderlineColor' };
/** Badge look from the settings: CSS variables + data attributes on the button. */
function applyBadgeLook(s) {
    const st = barBtn.style;
    barBtn.dataset.bstyle = s.badgeStyle;
    barBtn.dataset.bpos = s.badgePos;
    const fg = s.badgeColor === 'custom' ? s.badgeFg : BADGE_THEME[s.badgeColor] ? `var(${BADGE_THEME[s.badgeColor]})` : '';
    const bg = s.badgeColor === 'custom' ? s.badgeBg : '';
    const set = (k, v) => (v ? st.setProperty(k, v) : st.removeProperty(k));
    set('--mh-badge-fg', fg);
    set('--mh-badge-bd', fg);
    set('--mh-badge-bg', bg);
    set('--mh-badge-size', `${Number(s.badgeSize) || 9}px`);
    // in place of the icon: large makes the digits about as tall as the icon
    set('--mh-badge-em', `${{ 9: 1, 11: 1.25, 13: 1.6 }[s.badgeSize] ?? 1}em`);
}

function renderTopbar() {
    if (!ensureTopbar()) return;
    const s = settings();
    const st = state();
    const inChat = !!st;
    barBtn.classList.toggle('mh_busy', !!busy);
    barBtn.classList.toggle('mh_hidden', !inChat);
    const badge = barBtn.querySelector('.mh_topbadge');
    if (!inChat) { barPanel.classList.remove('mh_open'); if (ownBar) ownBar.classList.add('mh_hidden'); return; }
    ownBar?.classList.remove('mh_hidden');

    const len = ctx().chat.length;
    const pending = Math.max(0, len - 1 - st.lastEnd);
    const failed = lastJob && !lastJob.ok && !busy;
    const backlog = hasBacklog(s, st, len);
    applyBadgeLook(s);
    badge.textContent = s.badgeStyle === 'none' ? '' : busy && job ? `${Math.min(job.done + 1, job.total || 1)}/${job.total || 1}` : (st.lastEnd >= 0 ? `#${st.lastEnd}` : '');
    badge.classList.toggle('mh_bad', !!failed || backlog);
    barBtn.classList.toggle('mh_has_badge', !!badge.textContent);
    barBtn.title = busy ? `Memory Hub: ${job?.label ?? 'กำลังทำงาน'} ${job?.range ?? ''}` : `Memory Hub: สรุปแล้วถึงข้อความ #${st.lastEnd} · ยังไม่สรุป ${pending}`;
    if (ownBar) ownBar.querySelector('.mh_ownbar_text').textContent = busy ? `${job?.label ?? 'กำลังทำงาน'} ${job?.range ?? ''}` : `สรุปถึง #${st.lastEnd} · ค้าง ${pending}`;

    applyIcon(barBtn);
    if (!barPanel.classList.contains('mh_open')) return;
    // A rebuild while the module list is open closes it (iOS shows the picker
    // natively and drops it the moment its <select> is replaced).
    const focused = document.activeElement;
    if (focused?.tagName === 'SELECT' && barPanel.contains(focused)) return;
    const nextAt = st.lastEnd + s.chunkSize + s.keepRaw;
    let jobHtml;
    if (busy && job) {
        jobHtml = `<div class="mh_tp_job"><i class="fa-solid fa-spinner fa-spin"></i>
          <b>${esc(job.label)}</b> ${esc(job.range ?? '')} <span class="mh_tp_dim">(${Math.min(job.done + 1, job.total || 1)}/${job.total || 1})</span>
          ${job.api ? `<br><span class="mh_tp_dim">ใช้ ${esc(job.api)}${job.attempts > 1 ? ` · API ลำดับ ${job.attempt}/${job.attempts}` : ''}</span>` : ''}
          <a href="#" data-mh="stop" class="mh_tp_stop">หยุด</a></div>`;
    } else {
        jobHtml = '<div class="mh_tp_job mh_tp_dim">ไม่มีงานที่กำลังทำ</div>';
    }
    if (queued) jobHtml += `<div class="mh_tp_dim">รอคิวอีก ${queued} รอบ</div>`;
    if (lastJob && !busy) jobHtml += `<div class="${lastJob.ok ? 'mh_ok' : 'mh_bad'}">${lastJob.ok ? '✔' : '✖'} ${esc(lastJob.text)} <span class="mh_tp_dim">· ${ago(lastJob.at)}</span></div>`;
    const paused = !busy && s.mode !== 'manual' && autoPausedUntil > len;
    const modeLine = !s.enabled ? 'Memory Hub ปิดอยู่'
        : paused ? `สรุปอัตโนมัติพักไว้หลังล้มเหลว จนถึงข้อความ #${autoPausedUntil - 1} <a href="#" data-mh="resume">ลองตอนนี้</a>`
        : s.mode === 'manual' ? 'โหมดสรุปเอง: กด "สรุปเดี๋ยวนี้" เมื่อต้องการ'
        : s.mode === 'semi' ? `กึ่งอัตโนมัติ: จะถามก่อนสรุปเมื่อแชทถึงข้อความ #${Math.max(nextAt, (st.remindAt ?? 0) - 1)}`
        : `สรุปอัตโนมัติรอบถัดไปเมื่อแชทถึงข้อความ #${nextAt}`;
    const html = `
      <div class="mh_tp_head"><b><span class="mh_icon_slot"></span> Memory Hub</b> <span class="mh_tp_dim">${esc(botName())}</span>
        <i class="fa-solid fa-xmark mh_tp_close" data-mh="close" title="ปิด"></i></div>
      <div class="mh_tp_stat">สรุปแล้วถึงข้อความ <b>#${st.lastEnd}</b> จากทั้งหมด ${len} · ยังไม่สรุป <b>${pending}</b> · ความจำ ${st.memories.length} ก้อน</div>
      ${s.style === 'custom' ? '<div class="mh_tp_dim">Prompt สรุป: เขียนเองทั้งหมด</div>' : topbarModulesHtml()}
      <div class="mh_tp_dim">${modeLine}</div>
      ${backlog ? `<div class="mh_bad">⚠ ค้าง ${pending} ข้อความ ถูกส่งเต็มทุกเทิร์น และข้อความเก่าอาจหลุดจาก context ก่อนถูกจำ <a href="#" data-mh="now">สรุปเลย</a></div>` : ''}
      ${jobHtml}
      <div class="mh_tp_btns">
        <div class="menu_button${busy ? ' disabled' : ''}" data-mh="now"><i class="fa-solid fa-wand-magic-sparkles"></i> สรุปเดี๋ยวนี้</div>
        <div class="menu_button${busy ? ' disabled' : ''}" data-mh="carry"><i class="fa-solid fa-forward"></i> สรุป + ขึ้นแชทใหม่</div>
        <div class="menu_button" data-mh="open"><i class="fa-solid fa-book-open"></i> คลังความจำ</div>
        <div class="menu_button" data-mh="last"><i class="fa-solid fa-eye"></i> ส่งอะไรไปล่าสุด</div>
      </div>`;
    // only touch the DOM when something changed (this runs every 2 s)
    if (barPanel.dataset.html !== html) { barPanel.innerHTML = html; barPanel.dataset.html = html; }
    applyIcon(barPanel);
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
        name: 'memhub-export',
        callback: async () => { await exportDialog(); return ''; },
        helpString: 'Memory Hub: ส่งออกคลังความจำของแชทนี้ (Markdown / JSON)',
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
        eventSource.on(E.MESSAGE_RECEIVED, () => renderTopbar());
        eventSource.on(E.MESSAGE_SENT, () => renderTopbar());
        if (E.APP_READY) eventSource.on(E.APP_READY, () => renderTopbar());
        // the Top Info Bar may load after us, or be switched on/off later
        setInterval(() => { if (settings().topbar) renderTopbar(); }, 2000);
        eventSource.on(E.MESSAGE_DELETED, () => reconcile({ announce: true }));
        eventSource.on(E.CHAT_CHANGED, () => {
            clearPrompts();
            lastInjection = null;
            cancelRequested = true;
            autoPausedUntil = 0;
            backlogWarned = 0;
            migrateBotModules();
            reconcile({ announce: true });
            refreshUi();
        });
        console.log(LOG, `v${VERSION} loaded`);
    } catch (e) {
        console.error(LOG, 'init failed', e);
    }
});
