/*
 * Memory Hub — summary prompt modules (pure, unit-testable in Node).
 *
 * The summarizer prompt is a small base plus the modules picked for the bot.
 * Each module adds what to remember ("keep"), what to leave out ("skip"),
 * what makes a good key, and optionally one heading in the story-so-far. A
 * bot's modules come from, in order: its explicit choice in Memory Hub, its
 * SillyTavern tags matching a module's tags, then the default.
 */

/**
 * @typedef {Object} PromptModule
 * @property {string} id
 * @property {string} name        Thai label for the UI
 * @property {string} [desc]      Thai one-liner for the UI
 * @property {string[]} [tags]    SillyTavern tag names that switch the module on (case-insensitive)
 * @property {string[]} [keep]    bullet lines: what to remember
 * @property {string[]} [skip]    what to leave out
 * @property {string} [keys]      extra kinds of key words
 * @property {string} [overview]  one heading line for the story-so-far ("Heading: what goes there")
 * @property {number} [words]     extra words per memory
 * @property {number} [overviewWords] extra words for the story-so-far
 * @property {boolean} [custom]
 */

/** @type {PromptModule[]} */
export const BUILTIN_MODULES = Object.freeze([
    {
        id: 'relationship',
        name: 'ความสัมพันธ์ / โรแมนซ์',
        desc: 'ความรู้สึก ความไว้ใจ จุดเปลี่ยนของความสัมพันธ์ สิ่งที่รู้เกี่ยวกับกัน',
        tags: ['romance', 'relationship', 'love', 'โรแมนซ์', 'ความรัก', 'รัก', 'จีบ', 'dating', 'bl', 'gl', 'yaoi', 'yuri', 'otome'],
        keep: [
            'how the relationship changed: feelings, trust, attraction, jealousy, conflicts, apologies, milestones (first date, confession, first kiss…), boundaries',
            'what {{char}} learned about {{user}} (likes, dislikes, habits, past, wounds) and the other way round',
            'nicknames, inside jokes, gifts, songs, places that became meaningful to them',
        ],
        keys: 'meaningful places, gifts, nicknames, milestones',
        overview: 'Relationship: where things stand between the characters and {{user}} right now, and what they have been through',
        words: 20,
        overviewWords: 60,
    },
    {
        id: 'ensemble',
        name: 'หลายตัวละคร',
        desc: 'จำแยกทีละตัว ใครรู้สึกยังไงกับใคร ใครอยู่ที่ไหน',
        tags: ['multiple characters', 'multi', 'ensemble', 'group', 'หลายตัวละคร', 'หลายคาร์', 'multichar', 'harem', 'ฮาเร็ม', 'narrator', 'ผู้เล่าเรื่อง'],
        keep: [
            'for EACH character who appears: what they did, what they now feel or want, how they changed',
            'relationships between characters, not only with {{user}}: alliances, rivalries, crushes, grudges, debts',
            'where each character is and what they are doing when they leave the scene',
        ],
        keys: 'secondary characters',
        overview: 'Characters: one line each (role, current state and mood, how they feel about {{user}} and the others)',
        words: 60,
        overviewWords: 150,
    },
    {
        id: 'story',
        name: 'เนื้อเรื่อง / ดราม่า',
        desc: 'จุดหักมุม แรงจูงใจ ปมที่ยังค้าง การปูเรื่อง',
        tags: ['story', 'plot', 'drama', 'angst', 'เนื้อเรื่อง', 'ดราม่า', 'พล็อต', 'fantasy', 'แฟนตาซี', 'adventure', 'ผจญภัย'],
        keep: [
            'turning points and their consequences; choices that cannot be undone',
            'motives and goals of the important characters, and when they change',
            'foreshadowing, prophecies, warnings and plot threads that are still open',
        ],
        overview: 'Plot: the main conflict, where it stands, and the threads still open',
        words: 20,
        overviewWords: 60,
    },
    {
        id: 'mystery',
        name: 'ปริศนา / ความลับ',
        desc: 'เบาะแส ผู้ต้องสงสัย ใครรู้อะไร ใครโกหก',
        tags: ['mystery', 'detective', 'secret', 'thriller', 'ปริศนา', 'สืบสวน', 'ความลับ', 'ระทึกขวัญ', 'investigation'],
        keep: [
            'clues found, by whom, and what they seem to point to',
            'who knows what: secrets revealed, lies told, and things a character does NOT know yet',
            'suspects, alibis, contradictions and open questions the story itself raised (never invent suspects or theories)',
        ],
        keys: 'clues, suspects, evidence',
        overview: 'Secrets & clues: what has been revealed, who knows it, and the questions still unanswered',
        words: 30,
        overviewWords: 80,
    },
    {
        id: 'rpg',
        name: 'ระบบเกม / RPG',
        desc: 'เควส ไอเท็ม เงิน สเตตัส สกิล ปาร์ตี้',
        tags: ['rpg', 'game', 'dnd', 'd&d', 'dungeon', 'isekai', 'เกม', 'อิเซไก', 'ต่างโลก', 'trpg', 'litrpg', 'system'],
        keep: [
            'quests and goals: started, advanced, completed, failed, and their rewards',
            'items, money, stats, levels and abilities gained or lost (final values only)',
            'party members joining or leaving; locations reached or unlocked',
        ],
        skip: ['blow-by-blow combat (keep only the outcome)'],
        keys: 'quest names, items, abilities, monsters',
        overview: 'Quests & inventory: active quests, party, important items and numbers',
        words: 40,
        overviewWords: 100,
    },
    {
        id: 'world',
        name: 'โลก / การเมือง / ฝ่าย',
        desc: 'ฝ่ายต่าง ๆ การเมือง กฎของเวทมนตร์หรือเทคโนโลยี ประวัติศาสตร์',
        tags: ['worldbuilding', 'world', 'politics', 'kingdom', 'faction', 'war', 'โลก', 'การเมือง', 'อาณาจักร', 'สงคราม', 'sci-fi', 'ไซไฟ', 'magic', 'เวทมนตร์'],
        keep: [
            'factions, rulers and organisations: who they are, what they want, how they stand towards {{user}}',
            'rules of the world that were revealed (magic, technology, laws, customs) and history or legends that matter',
            'places visited and what is special about them',
        ],
        keys: 'factions, places, titles, spells, technologies',
        overview: 'World: factions and established facts about the world that matter for what comes next',
        words: 30,
        overviewWords: 100,
    },
    {
        id: 'daily',
        name: 'ชีวิตประจำวัน',
        desc: 'กิจวัตร ตารางเวลา นัดหมาย ความชอบเล็ก ๆ น้อย ๆ',
        tags: ['slice of life', 'slice-of-life', 'daily', 'sol', 'school', 'office', 'ชีวิตประจำวัน', 'โรงเรียน', 'ออฟฟิศ', 'ครอบครัว', 'family', 'roommate', 'รูมเมท'],
        keep: [
            'routines, schedules, appointments and plans for later',
            'small preferences and habits (food, clothes, hobbies) and recurring jokes',
        ],
        skip: ['ordinary chores unless something changed'],
        overview: 'Daily life: routines and upcoming plans or appointments',
        words: 10,
        overviewWords: 40,
    },
    {
        id: 'survival',
        name: 'เอาชีวิตรอด / สยองขวัญ',
        desc: 'บาดแผล ทรัพยากร ภัยคุกคาม ใครตาย ใครหาย',
        tags: ['horror', 'survival', 'zombie', 'apocalypse', 'สยองขวัญ', 'เอาชีวิตรอด', 'ซอมบี้', 'วันสิ้นโลก', 'ผี'],
        keep: [
            'injuries, illness and physical or mental state of each character',
            'supplies and resources (food, water, weapons, ammo) and where the safe places are',
            'threats encountered, rules of the danger that were learned, who died, who is missing',
        ],
        keys: 'threats, safe places, supplies',
        overview: 'Situation: condition of each survivor, resources, current threat and shelter',
        words: 30,
        overviewWords: 80,
    },
    {
        id: 'time',
        name: 'เวลาในเรื่อง',
        desc: 'วัน เวลา ฤดู การข้ามเวลา เส้นตาย อายุ',
        tags: ['timeline', 'time', 'เวลา', 'ไทม์ไลน์', 'time travel', 'ย้อนเวลา'],
        keep: ['in-story date and time, time skips, deadlines and countdowns, ages'],
        keys: 'dates, deadlines, events on the calendar',
        overview: 'Time: current in-story date/time and upcoming deadlines',
        words: 10,
        overviewWords: 20,
    },
    {
        id: 'stats',
        name: 'แผงสเตตัส / ค่าความชอบ',
        desc: 'บอทที่มีแผงสถานะ ค่าความชอบ ค่าความสัมพันธ์ในข้อความ',
        tags: ['status', 'stat', 'status panel', 'affection', 'สเตตัส', 'ค่าความชอบ', 'แผงสถานะ', 'dating sim'],
        keep: ['numbers shown in status panels (affection, trust, HP, money…): only the final values at the end of these messages and what made them change a lot'],
        skip: ['the status panels themselves and their decoration'],
        overview: 'Status: latest important values from the status panel',
        words: 10,
        overviewWords: 30,
    },
]);

const BASE_KEEP = [
    'events, decisions and their consequences; promises and plans; unresolved threads',
    'who a character is when first revealed: role, origin, occupation, family ties (e.g. "X is Y\'s uncle")',
    'agreements, codes, signals and cover stories the characters set up between themselves',
    'injuries, important items, changes of place and time',
];

/** Merges built-ins with the user's own modules (a custom module may override a built-in id). */
export function allModules(custom = []) {
    const map = new Map(BUILTIN_MODULES.map(m => [m.id, m]));
    for (const m of custom ?? []) if (m?.id) map.set(m.id, { ...m, custom: true });
    return [...map.values()];
}

/** Module ids whose tags match any of the bot's SillyTavern tag names. */
export function modulesFromTags(tagNames, modules) {
    const names = new Set((tagNames ?? []).map(t => String(t).trim().toLowerCase()).filter(Boolean));
    if (!names.size) return [];
    return modules.filter(m => (m.tags ?? []).some(t => names.has(String(t).trim().toLowerCase()))).map(m => m.id);
}

const bullets = (lines, indent = '  • ') => lines.map(l => indent + l).join('\n');

/**
 * Builds the summarizer prompt for a set of modules.
 * The result still contains {{memory_words}}, {{overview_rule}}, {{overview_format}},
 * {{char}} and {{user}}, which are filled at call time.
 * @param {PromptModule[]} mods
 * @param {{group?: boolean}} opt
 */
export function buildPrompt(mods, { group = false } = {}) {
    const keep = [...BASE_KEEP, ...mods.flatMap(m => m.keep ?? [])];
    const skip = ['flavour text', 'repeated description', ...mods.flatMap(m => m.skip ?? [])];
    if (!mods.some(m => m.id === 'stats')) skip.push('status panels');
    const keyKinds = ['places', 'objects', 'events', 'nicknames', ...mods.map(m => m.keys).filter(Boolean)];
    const who = group || mods.some(m => m.id === 'ensemble')
        ? 'an ongoing story with {{user}} and several characters'
        : 'an ongoing roleplay between {{user}} and {{char}}';

    return `You are the memory keeper of ${who}.
Read NEW MESSAGES and write one compact memory of them.

Rules:
- Write in the same language the story is written in.
- Keep what will matter later:
${bullets(keep)}
- Skip ${[...new Set(skip)].join(', ')}.
- Always write names in full instead of "he/she": memories are read out of order.
- Be concrete. No commentary, no guessing.
- summary: at most {{memory_bullets}} bullets, one short sentence each (about {{memory_words}} words in total). One bullet per story beat; merge small beats. Keep a detail only if it would still matter 50 messages later; leave out teasing and banter unless it changed something.
- keys: 3-8 names of concrete things someone would say when this memory becomes relevant again (${[...new Set(keyKinds.join(', ').split(/,\s*/))].join(', ')}). Not adjectives, jokes or body parts. Never use {{user}} or {{char}} alone as a key.
{{overview_rule}}
Answer in exactly this format and nothing else:
<memory>
title: <short title>
keys: <comma separated>
facts: <who-is-who and agreements first revealed in NEW MESSAGES: family ties, occupations, origins, titles, codes or signals agreed on — or "none">
summary:
- ...
</memory>{{overview_format}}`;
}

/** The story-so-far instruction: free prose, or fixed headings when modules ask for them. */
export function buildOverviewRule(mods) {
    const heads = mods.map(m => m.overview).filter(Boolean);
    if (!heads.length) {
        return '- overview: rewrite PREVIOUS OVERVIEW so it also covers the new memory. It is the story so far in at most {{overview_words}} words: who is who, where things stand, what happened that still matters, where they are now, open threads. Drop details that no longer matter, but never drop who is who (identities, disguises, who is in which body) or a secret that is still hidden.';
    }
    const who = mods.some(m => m.id === 'ensemble') ? [] : ['Who is who: one line per important character (role, origin, occupation, family ties, current body or disguise)'];
    const all = [...who, ...heads, 'Now: where everyone is and what is happening at this moment', 'Open threads: promises, plans and unresolved matters'];
    return `- overview: rewrite PREVIOUS OVERVIEW as the CURRENT STATE of the story, at most {{overview_words}} words in total, under these headings (skip a heading if there is nothing for it):
${all.map(h => `  ${h}`).join('\n')}
  Write the headings in the story's language. Drop what is resolved and no longer matters, but never drop who is who (identities, disguises, who is in which body) or a secret that is still hidden.`;
}

/** Extra room the chosen modules need on top of the base settings. */
export function extraWords(mods) {
    return {
        memory: mods.reduce((a, m) => a + (Number(m.words) || 0), 0),
        overview: mods.reduce((a, m) => a + (Number(m.overviewWords) || 0), 0),
    };
}
