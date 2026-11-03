import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';

// Translations stay in this browser only (user's choice), keyed by the original comment text.
export const CACHE_KEY = 'macrotrace-translations';
const COMMENT_HEAD = /^\{\{\s*(?:\/\/|comment\b)(?:\s*::)?/i;

function loadCache() {
    try {
        return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') ?? {};
    } catch {
        return {};
    }
}

function saveCache(cache) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
        // storage blocked or full: translations just are not kept
    }
}

/** Text ranges of `{{// …}}` and `{{//}}…{{///}}` comments in a doc's source. */
export function findComments(doc) {
    const text = doc.text ?? '';
    const out = [];
    for (const ev of doc.events) {
        const name = (ev.name || '').toLowerCase();
        if ((name !== '//' && name !== 'comment') || ev.start == null || ev.synthetic) continue;
        const blockEnd = doc.blockEnd?.get(ev.start);
        let from;
        let to;
        if (blockEnd != null) {
            from = ev.end + 1;
            to = text.lastIndexOf('{{', blockEnd);
        } else {
            const raw = text.slice(ev.start, ev.end + 1);
            from = ev.start + (raw.match(COMMENT_HEAD)?.[0].length ?? 2);
            to = ev.end - 1;
        }
        let body = text.slice(from, to);
        from += body.length - body.trimStart().length;
        body = body.trimStart();
        to -= body.length - body.trimEnd().length;
        body = body.trimEnd();
        // comments holding macros would need the marks inside them; leave those as they are
        if (!body || body.includes('{{')) continue;
        out.push({ from, to, text: body });
    }
    return out;
}

export function profiles() {
    try {
        return SillyTavern.getContext().ConnectionManagerRequestService.getSupportedProfiles();
    } catch {
        return [];
    }
}

export function pickedProfile() {
    const list = profiles();
    const saved = extension_settings.macroTrace?.profile;
    return list.find(p => p.id === saved)?.id ?? list[0]?.id ?? null;
}

export function rememberProfile(id) {
    extension_settings.macroTrace ??= {};
    extension_settings.macroTrace.profile = id;
    saveSettingsDebounced();
}

function parseArray(text) {
    const match = String(text ?? '').match(/\[[\s\S]*\]/);
    try {
        const arr = match ? JSON.parse(match[0]) : null;
        return Array.isArray(arr) ? arr : null;
    } catch {
        return null;
    }
}

/** Korean for each text; only texts not translated before are sent, in one request. */
export async function translateTexts(texts, profileId) {
    const cache = loadCache();
    const todo = [...new Set(texts)].filter(t => !Object.hasOwn(cache, t));
    if (todo.length) {
        const prompt = [
            'Translate each string in the JSON array into natural Korean.',
            'Keep anything written inside {{ }} exactly as it is.',
            'Reply with only a JSON array of the translations, in the same order.',
            '',
            JSON.stringify(todo),
        ].join('\n');
        const service = SillyTavern.getContext().ConnectionManagerRequestService;
        const res = await service.sendRequest(profileId, [{ role: 'user', content: prompt }], 4096);
        const arr = parseArray(typeof res === 'string' ? res : res?.content);
        if (!arr || arr.length !== todo.length) throw new Error('번역 결과를 읽지 못했습니다.');
        todo.forEach((t, i) => { cache[t] = String(arr[i]); });
        saveCache(cache);
    }
    return new Map(texts.map(t => [t, cache[t]]));
}
