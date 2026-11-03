import { chat, chat_metadata, characters, this_chid, getCharacterCardFieldsLazy, substituteParams } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { oai_settings, setOpenAIMessageExamples } from '../../../../openai.js';
import { power_user, persona_description_positions } from '../../../../power-user.js';
import { IGNORE_SYMBOL } from '../../../../constants.js';
import { createTrace } from './trace.js';
import { alignDoc } from './align.js';

// Same order as getCharacterCardFields() reads them during a generation.
const CARD_FIELDS = {
    system: '캐릭터 메인 프롬프트',
    mesExamples: '예시 대화',
    description: '캐릭터 설명',
    personality: '성격',
    persona: '페르소나',
    scenario: '시나리오',
    jailbreak: '캐릭터 PHI',
    version: '버전',
    charDepthPrompt: '캐릭터 노트',
    creatorNotes: '제작자 노트',
    firstMessage: '첫 메시지',
    alternateGreetings: '다른 첫 메시지',
};

const MARKER_FIELD = {
    charDescription: 'description',
    charPersonality: 'personality',
    scenario: 'scenario',
    personaDescription: 'persona',
};

const ABSOLUTE = 1;
const NAMES = { NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 };

function pickOrder(promptOrder) {
    if (!Array.isArray(promptOrder)) return [];
    const entry = promptOrder.find(x => String(x.character_id) === '100001')
        ?? promptOrder.find(x => String(x.character_id) === '100000')
        ?? promptOrder[0];
    return Array.isArray(entry?.order) ? entry.order : [];
}

function part(text, doc = null, offset = 0) {
    return { text, doc, offset };
}

/** Parts for a doc's whole output, following unchanged second passes back to the doc that had the macros. */
function docParts(doc) {
    if (!doc) return [];
    let d = doc;
    while (d.prev && d.output === d.input && d.prev.output === d.input) d = d.prev;
    return d.output ? [part(d.output, d, 0)] : [];
}

function partsText(parts) {
    return parts.map(p => p.text).join('');
}

function trimParts(parts) {
    const out = parts.map(p => ({ ...p }));
    while (out.length) {
        const p = out[0];
        const t = p.text.replace(/^\s+/, '');
        p.offset += p.text.length - t.length;
        p.text = t;
        if (t) break;
        out.shift();
    }
    while (out.length) {
        const p = out.at(-1);
        p.text = p.text.replace(/\s+$/, '');
        if (p.text) break;
        out.pop();
    }
    return out;
}

function joinParts(list, sep) {
    const out = [];
    list.forEach((parts, i) => {
        if (i > 0) out.push(part(sep));
        out.push(...parts);
    });
    return out;
}

/** Parts for a piece of text known to sit somewhere in a doc's output. */
function searchParts(doc, text) {
    const d = docParts(doc)[0]?.doc ?? null;
    const idx = d ? d.output.indexOf(text) : -1;
    return [part(text, idx >= 0 ? d : null, Math.max(idx, 0))];
}

function chatMessages(namesBehavior) {
    const list = [];
    for (const m of chat) {
        if (m.is_system || m.extra?.[IGNORE_SYMBOL]) continue;
        let role = m.is_user ? 'user' : 'assistant';
        if (m.extra?.type === 'narrator') role = 'system';
        let content = String(m.mes ?? '');
        const named = m.force_avatar && !m.is_user && m.extra?.type !== 'narrator';
        if (namesBehavior === NAMES.CONTENT && m.extra?.type !== 'narrator') content = `${m.name}: ${content}`;
        if (namesBehavior === NAMES.DEFAULT && named) content = `${m.name}: ${content}`;
        list.push({ role, name: namesBehavior === NAMES.COMPLETION ? m.name : undefined, kind: 'chat', card: 'chatHistory', parts: [part(content.replace(/\r/gm, ''))] });
    }
    return list;
}

/** Mirrors populationInjectionPrompts(): newest-first list in, oldest-first out. */
function injectInChat(newestFirst, absolutes, extPrompts) {
    const messages = [...newestFirst];
    const maxDepth = Math.max(0, ...absolutes.map(p => p.depth), ...extPrompts.map(p => p.depth));
    let inserted = 0;
    for (let i = 0; i <= maxDepth; i++) {
        const groups = { 100: [] };
        for (const p of absolutes.filter(x => x.depth === i && partsText(x.parts))) {
            (groups[p.order] ??= []).push(p);
        }
        const roleMessages = [];
        for (const order of Object.keys(groups).sort((a, b) => +b - +a)) {
            for (const role of ['system', 'user', 'assistant']) {
                const own = groups[order].filter(p => p.role === role);
                const ext = String(order) === '100' ? extPrompts.filter(p => p.depth === i && p.role === role) : [];
                const pieces = [];
                if (own.length) pieces.push(joinParts(own.map(p => p.parts), '\n'));
                if (ext.length) pieces.push(joinParts(ext.map(p => p.parts), '\n'));
                const joint = joinParts(pieces.map(trimParts).filter(x => x.length), '\n');
                if (joint.length) {
                    roleMessages.push({ role, kind: 'inject', card: [...own, ...ext].map(p => p.id).find(Boolean) ?? 'chatHistory', label: [...own, ...ext].map(p => p.label).join(', '), parts: joint });
                }
            }
        }
        if (roleMessages.length) {
            messages.splice(i + inserted, 0, ...roleMessages);
            inserted += roleMessages.length;
        }
    }
    return messages.reverse();
}

function squash(messages) {
    const exclude = ['newMainChat', 'newChat', 'groupNudge'];
    const can = m => m.role === 'system' && !m.name && !exclude.includes(m.id) && m.kind !== 'wi';
    const out = [];
    for (const m of messages) {
        if (m.role === 'system' && !partsText(m.parts) && m.kind !== 'wi') continue;
        const last = out.at(-1);
        if (last && can(m) && can(last)) {
            last.parts = [...last.parts, part('\n'), ...m.parts];
            last.label = [last.label, m.label].filter(Boolean).join(' + ');
        } else {
            out.push({ ...m });
        }
    }
    return out;
}

/**
 * Builds the Chat Completion prompt for a preset the way a normal generation would,
 * with every macro running against a copy of the variables.
 */
export function simulate(preset) {
    const P = key => preset[key] ?? oai_settings[key];
    const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
    const order = pickOrder(preset.prompt_order);
    const byId = id => prompts.find(p => p.identifier === id);
    const enabled = order.filter(e => e.enabled && byId(e.identifier) && !(byId(e.identifier).injection_trigger?.length && !byId(e.identifier).injection_trigger.includes('normal')));
    const isOn = id => enabled.some(e => e.identifier === id);

    const trace = createTrace({
        local: structuredClone(chat_metadata.variables ?? {}),
        global: structuredClone(extension_settings.variables?.global ?? {}),
    });

    const fields = {};
    const fieldDocs = {};
    const prepared = new Map();
    let newChat = null;
    let newExampleChat = null;

    // prompt identifier → docs shown in that prompt's card; doc → identifier for every doc
    const cardDocs = new Map();
    const docCard = new Map();
    const addDoc = (id, doc, show = true) => {
        if (!doc) return;
        docCard.set(doc, id);
        if (!show) return;
        const list = cardDocs.get(id) ?? [];
        if (!list.includes(doc)) list.push(doc);
        cardDocs.set(id, list);
    };

    function run(source, text, options, prev = null) {
        if (!text) return { out: '', doc: null };
        trace.setSource(source);
        const n = trace.docs.length;
        const out = substituteParams(text, options);
        const doc = trace.docs[n] ?? null;
        if (doc) doc.prev = prev;
        return { out, doc };
    }

    trace.run(() => {
        // 1. character card fields
        const lazy = getCharacterCardFieldsLazy();
        for (const [key, label] of Object.entries(CARD_FIELDS)) {
            trace.setSource({ key: `card.${key}`, label });
            const n = trace.docs.length;
            try {
                fields[key] = lazy[key];
            } catch {
                fields[key] = '';
            }
            fieldDocs[key] = trace.docs.slice(n).at(-1) ?? null;
        }

        // 2. format strings, evaluated before the prompt list
        const fmt = (key, label, field) => {
            if (!fields[field] || !P(key)) return { out: fields[field] || '', doc: fieldDocs[field] };
            return run({ key: `fmt.${key}`, label }, P(key));
        };
        const scenario = fmt('scenario_format', '시나리오 형식', 'scenario');
        const personality = fmt('personality_format', '성격 형식', 'personality');
        run({ key: 'fmt.group_nudge_prompt', label: '그룹 넛지' }, P('group_nudge_prompt'));
        if (P('impersonation_prompt')) run({ key: 'fmt.impersonation_prompt', label: '사칭 프롬프트' }, P('impersonation_prompt'));

        // 3. preset prompts, top to bottom
        for (const entry of order) {
            const prompt = byId(entry.identifier);
            if (!prompt) continue;
            if (isOn(entry.identifier)) {
                const r = run({ key: `prompt.${prompt.identifier}`, label: prompt.name || prompt.identifier, preset: true }, prompt.content ?? '');
                prepared.set(prompt.identifier, { prompt, ...r });
                addDoc(prompt.identifier, r.doc);
            } else if (prompt.identifier === 'main') {
                prepared.set('main', { prompt, out: '', doc: null });
            }
        }

        // character fields show up in the card of the prompt that carries them
        addDoc('main', fieldDocs.system);
        addDoc('jailbreak', fieldDocs.jailbreak);
        addDoc('charDescription', fieldDocs.description);
        addDoc('charPersonality', fieldDocs.personality);
        addDoc('charPersonality', personality.doc);
        addDoc('scenario', fieldDocs.scenario);
        addDoc('scenario', scenario.doc);
        addDoc('dialogueExamples', fieldDocs.mesExamples);

        // 4. markers get their content and go through the macros again
        const second = (id, text, prev) => run({ key: `marker.${id}`, label: `${byId(id)?.name || id}` }, text, undefined, prev);
        const markers = {
            charDescription: second('charDescription', fields.description, fieldDocs.description),
            charPersonality: second('charPersonality', personality.out, personality.doc),
            scenario: second('scenario', scenario.out, scenario.doc),
        };
        if (power_user.persona_description && power_user.persona_description_position === persona_description_positions.IN_PROMPT) {
            markers.personaDescription = second('personaDescription', power_user.persona_description);
        }
        for (const [id, r] of Object.entries(markers)) {
            if (prepared.has(id)) prepared.set(id, { ...prepared.get(id), ...r });
            addDoc(id, r.doc, id === 'personaDescription');
        }

        // 5. character overrides of main / post-history
        const override = (id, text) => {
            const target = prepared.get(id);
            if (!text || !target || target.prompt.forbid_overrides || !isOn(id)) return;
            const r = run({ key: `override.${id}`, label: `${target.prompt.name || id} (캐릭터)` }, text, { original: target.out });
            prepared.set(id, { ...target, ...r });
            addDoc(id, r.doc);
        };
        override('main', fields.system);
        override('jailbreak', fields.jailbreak);

        // 6. chat history and examples add their own lines last
        const chatFirst = !power_user.pin_examples;
        const doChat = () => { if (isOn('chatHistory')) newChat = run({ key: 'fmt.new_chat_prompt', label: '새 채팅' }, P('new_chat_prompt')); };
        const doExamples = () => { if (isOn('dialogueExamples') && fields.mesExamples) newExampleChat = run({ key: 'fmt.new_example_chat_prompt', label: '새 예시 채팅' }, P('new_example_chat_prompt')); };
        if (chatFirst) { doChat(); doExamples(); } else { doExamples(); doChat(); }
        addDoc('chatHistory', newChat?.doc);
        addDoc('dialogueExamples', newExampleChat?.doc);
    });

    for (const doc of trace.docs) alignDoc(doc);

    // assemble
    const absolutes = [];
    const blocks = [];
    for (const entry of enabled) {
        const id = entry.identifier;
        const p = prepared.get(id);
        const prompt = byId(id);
        const label = prompt.name || id;
        if (id === 'worldInfoBefore' || id === 'worldInfoAfter') {
            blocks.push([{ role: 'system', id, card: id, label, kind: 'wi', parts: [] }]);
            continue;
        }
        if (id === 'chatHistory' || id === 'dialogueExamples') {
            blocks.push(id);
            continue;
        }
        if (!p) continue;
        const parts = docParts(p.doc);
        if (prompt.injection_position === ABSOLUTE) {
            absolutes.push({ id, role: prompt.role || 'system', depth: Number(prompt.injection_depth ?? 4), order: prompt.injection_order ?? 100, label, parts });
            continue;
        }
        blocks.push([{ role: prompt.role || 'system', id, card: id, label, kind: 'prompt', parts }]);
    }

    const extPrompts = [];
    const character = characters[this_chid];
    if (fields.charDepthPrompt && fieldDocs.charDepthPrompt) {
        const dp = character?.data?.extensions?.depth_prompt;
        extPrompts.push({ role: dp?.role || 'system', depth: Number(dp?.depth ?? 4), label: CARD_FIELDS.charDepthPrompt, parts: docParts(fieldDocs.charDepthPrompt) });
    }

    const history = [];
    if (newChat?.out) history.push({ role: 'system', id: 'newMainChat', card: 'chatHistory', label: '새 채팅', kind: 'prompt', parts: docParts(newChat.doc) });
    const chatList = injectInChat(chatMessages(Number(P('names_behavior') ?? 0)).reverse(), absolutes, extPrompts);
    history.push(...chatList);
    if (chatList.at(-1)?.role === 'assistant' && P('send_if_empty')) {
        history.push({ role: 'user', id: 'emptyUserMessageReplacement', card: 'chatHistory', label: 'send_if_empty', kind: 'prompt', parts: [part(P('send_if_empty'))] });
    }

    const examples = [];
    if (fields.mesExamples) {
        let ex = fields.mesExamples;
        if (!ex.startsWith('<START>')) ex = '<START>\n' + ex.trim();
        const raw = ex === '<START>' ? [] : ex.split(/<START>/gi).slice(1).map(b => `<START>\n${b.trim()}\n`);
        for (const dialogue of setOpenAIMessageExamples(raw)) {
            if (newExampleChat?.out) examples.push({ role: 'system', id: 'newChat', card: 'dialogueExamples', label: '새 예시 채팅', kind: 'prompt', parts: docParts(newExampleChat.doc) });
            for (const m of dialogue) {
                examples.push({ role: 'system', name: m.name, card: 'dialogueExamples', label: CARD_FIELDS.mesExamples, kind: 'example', parts: searchParts(fieldDocs.mesExamples, m.content || '') });
            }
        }
    }

    let messages = [];
    for (const b of blocks) {
        if (b === 'chatHistory') messages.push(...history);
        else if (b === 'dialogueExamples') messages.push(...examples);
        else messages.push(...b);
    }
    messages = messages.filter(m => m.kind === 'wi' || partsText(m.parts));
    if (P('squash_system_messages')) messages = squash(messages);

    const cards = order.map(e => byId(e.identifier)).filter(Boolean).map((prompt, i) => ({
        n: i + 1,
        id: prompt.identifier,
        name: prompt.name || prompt.identifier,
        enabled: isOn(prompt.identifier),
        content: prompt.content ?? '',
        docs: cardDocs.get(prompt.identifier) ?? [],
    }));

    return {
        cards,
        docCard,
        messages,
        events: trace.events,
        docs: trace.docs,
    };
}
