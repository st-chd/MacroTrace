import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { oai_settings, openai_settings, openai_setting_names } from '../../../../openai.js';
import { simulate } from './simulate.js';
import { applyPalette, themePalette } from './theme.js';
import { findComments, pickedProfile, profiles, rememberProfile, translateTexts } from './translate.js';

const FOLD_KEY = 'macrotrace-path-folded';
const narrow = () => window.matchMedia('(max-width: 800px)').matches;

function readFolded() {
    try {
        return localStorage.getItem(FOLD_KEY) === '1';
    } catch {
        return false;
    }
}

function writeFolded(on) {
    try {
        localStorage.setItem(FOLD_KEY, on ? '1' : '0');
    } catch {
        // per-browser convenience only
    }
}

/** Phone layout shows one column at a time. */
function showTab(root, tab) {
    root.dataset.tab = tab;
    root.querySelectorAll('.mt-tab').forEach(b => b.classList.toggle('mt-on', b.dataset.tab === tab));
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
}

function short(s, max = 80) {
    s = String(s ?? '');
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function presetNames() {
    return Object.entries(openai_setting_names ?? {})
        .sort((a, b) => a[1] - b[1])
        .map(([name]) => name);
}

function loadPreset(name) {
    const preset = openai_settings?.[openai_setting_names?.[name]];
    return preset ? structuredClone(preset) : null;
}

function valueText(v) {
    if (v === undefined) return '없음';
    if (v === '') return '빈칸';
    return short(typeof v === 'object' ? JSON.stringify(v) : v, 40);
}

const WRITES = ['set', 'add', 'inc', 'dec', 'del'];
const isWrite = ev => ev.ops.some(o => WRITES.includes(o.op));
/** A macro that read a variable without writing one. */
const isRead = ev => ev.from !== undefined && !isWrite(ev);

function varLabel(v) {
    return `${v?.scope === 'global' ? '전역 변수' : '채팅 변수'} ${v?.name ?? ''}`;
}

/** Where a read value came from, back to the first write (or a variable that was already there). */
function valueChain(read) {
    const out = [];
    const seen = new Set();
    const nestedReads = w => w.doc.events.filter(r => r !== w && r.start != null && w.start != null && r.start >= w.start && r.end <= (w.scopeEnd ?? w.end) && isRead(r));
    const up = (r) => {
        if (r.from) step(r.from);
        else out.push({ root: r.readVar });
    };
    const step = (w) => {
        if (seen.has(w)) return;
        seen.add(w);
        out.push(w);
        nestedReads(w).forEach(up);
        if (w.prevWrite) step(w.prevWrite);
        else if (w.prevVar) out.push({ root: w.prevVar });
    };
    up(read);
    return out;
}

/** `mood: 없음 → 평온` for every variable the macro changed. */
function writeTitle(ev) {
    return ev.ops
        .filter(o => WRITES.includes(o.op))
        .map(o => `${o.scope === 'global' ? '$' : ''}${o.name}: ${valueText(o.existed ? o.before : undefined)} → ${valueText(o.op === 'del' ? undefined : o.after)}`)
        .join('\n');
}

/** Parts of {{if}}-like blocks that were never run. */
function skippedRanges(doc) {
    const out = [];
    for (const b of doc.lazyBlocks ?? []) {
        const ran = (doc.ran ?? []).filter(r => r.from >= b.from && r.to <= b.to).sort((x, y) => x.from - y.from);
        let cur = b.from;
        for (const r of ran) {
            if (r.from > cur) out.push({ from: cur, to: r.from - 1 });
            cur = Math.max(cur, r.to + 1);
        }
        if (cur <= b.to) out.push({ from: cur, to: b.to });
    }
    return out;
}

/** Source text with every macro marked; `tr` swaps comment text for its translation. */
function renderSource(doc, titleFor, tr) {
    const text = doc.text ?? doc.input ?? '';
    const skipped = skippedRanges(doc);
    const swaps = tr ? findComments(doc).filter(c => tr.get(c.text)) : [];
    const byStart = new Map();
    for (const ev of doc.events) {
        if (ev.start != null && !ev.synthetic && !byStart.has(ev.start)) byStart.set(ev.start, ev);
    }
    const shade = (from, to) => {
        let html = '';
        let cur = from;
        for (const s of skipped) {
            const a = Math.max(s.from, cur);
            const b = Math.min(s.to + 1, to);
            if (a >= b) continue;
            html += esc(text.slice(cur, a)) + `<span class="mt-src-off">${esc(text.slice(a, b))}</span>`;
            cur = b;
        }
        return html + esc(text.slice(cur, to));
    };
    const plain = (from, to) => {
        let html = '';
        let cur = from;
        for (const c of swaps) {
            if (c.from < cur || c.to > to) continue;
            html += shade(cur, c.from) + `<span class="mt-tr" title="${esc(c.text)}">${esc(tr.get(c.text))}</span>`;
            cur = c.to;
        }
        return html + shade(cur, to);
    };
    // {{x}}…{{/x}} gets one wrapper from the opening tag to the closing one, so it can be marked as a whole
    const blocks = [...byStart.values()].filter(ev => ev.scopeEnd != null).map(ev => ({ start: ev.start, end: ev.scopeEnd, block: ev }));
    const blockStarts = new Set(blocks.map(b => b.start));
    const nodes = [...(doc.nodes ?? []), ...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
    const walk = (from, to, list) => {
        let html = '';
        let cur = from;
        let i = 0;
        while (i < list.length) {
            const node = list[i];
            const inner = [];
            let j = i + 1;
            while (j < list.length && list[j].start <= node.end) inner.push(list[j++]);
            html += plain(cur, node.start);
            if (!node.block && blockStarts.has(node.start)) {
                // the opening tag inside its block wrapper
                html += `<span class="mt-src-hit">${walk(node.start, node.end + 1, inner)}</span>`;
                cur = node.end + 1;
                i = j;
                continue;
            }
            const ev = node.block ?? byStart.get(node.start);
            const cls = node.block
                ? 'mt-src-block'
                : ev?.n != null
                    ? `mt-src-hit${isRead(ev) ? ' mt-src-read' : ''}`
                    : (ev ? 'mt-src-hit mt-unknown' : (node.syntax ? 'mt-src-syntax' : 'mt-src-skip'));
            const title = ev ? titleFor(ev) : '';
            const attrs = `${ev?.n != null ? ` data-ev="${ev.n}"` : ''}${title ? ` title="${esc(title)}"` : ''}`;
            html += `<span class="${cls}"${attrs}>${walk(node.start, node.end + 1, inner)}</span>`;
            cur = node.end + 1;
            i = j;
        }
        return html + plain(cur, to);
    };
    return walk(0, text.length, nodes);
}

function renderCards(result, titleFor, tr) {
    const box = el('<div class="mt-cards"></div>');
    for (const card of result.cards) {
        const names = [...new Set(card.docs.flatMap(d => d.events).filter(ev => ev.name && !ev.synthetic).map(ev => ev.name))].slice(0, 6);
        const body = card.docs.length
            ? card.docs.map(doc => {
                const cap = doc.source?.key === `prompt.${card.id}` ? '' : `<div class="mt-cap">${esc(doc.source?.label ?? '')}</div>`;
                return `${cap}<div class="mt-src">${renderSource(doc, titleFor, tr)}</div>`;
            }).join('')
            : (card.content ? `<div class="mt-src">${esc(card.content)}</div>` : '');
        box.append(el(`
            <div class="mt-card${card.enabled ? '' : ' mt-off'}" data-card="${esc(card.id)}">
                <div class="mt-card-head">
                    <span class="mt-n">${card.n}</span>
                    <span class="mt-card-name">${esc(card.name)}</span>
                    ${names.map(n => `<span class="mt-chip">${esc(n)}</span>`).join('')}
                </div>
                ${body ? `<div class="mt-card-body">${body}</div>` : ''}
            </div>`));
    }
    return box;
}

/** Output text of one part with marks where top-level macro results landed. */
function renderPartText(p, titleOf) {
    if (!p.doc) return esc(p.text);
    const start = p.offset;
    const end = p.offset + p.text.length;
    const spans = p.doc.events
        .filter(ev => ev.outStart != null && ev.n != null && ev.outEnd > ev.outStart && ev.outStart >= start && ev.outEnd <= end)
        .sort((a, b) => a.outStart - b.outStart || a.outEnd - b.outEnd);
    let html = '';
    let cur = start;
    for (const ev of spans) {
        if (ev.outStart < cur) continue;
        html += esc(p.doc.output.slice(cur, ev.outStart));
        const title = titleOf(ev);
        html += `<mark class="mt-hit" data-ev="${ev.n}"${title ? ` title="${esc(title)}"` : ''}>${esc(p.doc.output.slice(ev.outStart, ev.outEnd))}</mark>`;
        cur = ev.outEnd;
    }
    html += esc(p.doc.output.slice(cur, end));
    return html;
}

function renderPrompt(result, titleOf) {
    const box = el('<div class="mt-msgs"></div>');
    const msgs = result.messages;
    const collapsed = new Set();
    for (let i = 0; i < msgs.length;) {
        let j = i;
        while (j < msgs.length && msgs[j].kind === 'chat') j++;
        if (j - i > 4) for (let k = i; k < j - 2; k++) collapsed.add(k);
        i = Math.max(j, i + 1);
    }

    let fold = null;
    msgs.forEach((m, i) => {
        const node = el(`
            <div class="mt-msg mt-role-${esc(m.role)}${m.kind === 'wi' ? ' mt-wi' : ''}"${m.card ? ` data-card="${esc(m.card)}"` : ''}>
                <div class="mt-msg-head">
                    <span class="mt-role">${esc(m.role)}</span>
                    ${m.label ? `<span class="mt-label">${esc(m.label)}</span>` : ''}
                    ${m.name ? `<span class="mt-name">${esc(m.name)}</span>` : ''}
                </div>
                ${m.kind === 'wi' ? '' : `<div class="mt-text">${m.parts.map(p => renderPartText(p, titleOf)).join('')}</div>`}
            </div>`);
        if (collapsed.has(i)) {
            node.hidden = true;
            if (!fold) {
                fold = { count: 0, nodes: [], row: el('<div class="mt-fold menu_button"></div>') };
                const f = fold;
                f.row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    f.nodes.forEach(n => { n.hidden = false; });
                    f.row.remove();
                });
                box.append(f.row);
            }
            fold.count++;
            fold.nodes.push(node);
            fold.row.textContent = `메시지 ${fold.count}개`;
        } else {
            fold = null;
        }
        box.append(node);
    });
    return box;
}

function flash(hit, behavior = 'smooth') {
    hit.scrollIntoView({ block: 'center', behavior });
    hit.classList.remove('mt-flash');
    void hit.offsetWidth;
    hit.classList.add('mt-flash');
}

function render(root, name) {
    const state = root.mtState;
    const left = root.querySelector('.mt-cards-box');
    const right = root.querySelector('.mt-prompt');
    const path = root.querySelector('.mt-path');
    left.replaceChildren();
    right.replaceChildren();
    path.replaceChildren();
    path.hidden = true;
    state.result = null;

    const preset = loadPreset(name);
    if (!preset) {
        right.append(el('<div class="mt-dim">프리셋을 찾을 수 없습니다.</div>'));
        return;
    }
    let result;
    try {
        result = simulate(preset);
    } catch (error) {
        console.error('[MacroTrace]', error);
        right.append(el(`<div class="mt-failed">${esc(error?.message || error)}</div>`));
        return;
    }
    state.result = result;

    const cardOf = id => result.cards.find(c => c.id === id) ?? null;
    // a value read from a variable belongs to the macro that wrote it
    const origin = ev => ev.from ?? ev;
    const titleOf = (ev) => {
        const card = cardOf(result.docCard.get(origin(ev).doc));
        return card ? `#${card.n} ${card.name}` : '';
    };

    const titleFor = (ev) => {
        if (isWrite(ev)) return writeTitle(ev);
        if (isRead(ev)) return ev.from ? titleOf(ev) : varLabel(ev.readVar);
        return '';
    };

    left.append(renderCards(result, titleFor, state.tr));
    const msgs = renderPrompt(result, titleOf);
    right.append(msgs);

    const byN = n => result.events.find(x => x.n === Number(n)) ?? null;
    const cardEl = id => (id ? left.querySelector(`.mt-card[data-card="${CSS.escape(id)}"]`) : null);
    const macroEl = ev => cardEl(result.docCard.get(ev.doc))?.querySelector(`[data-ev="${ev.n}"]`) ?? null;
    // what was clicked and where it led stay marked until the next click
    const pick = (...els) => {
        root.querySelectorAll('.mt-picked').forEach(x => x.classList.remove('mt-picked'));
        els.forEach(x => x?.classList.add('mt-picked'));
    };
    const go = (target) => {
        if (!target) return;
        if (narrow() && root.dataset.tab !== 'cards') {
            // the column was hidden until now, so a smooth scroll would not start; jump instead
            showTab(root, 'cards');
            flash(target, 'auto');
            return;
        }
        flash(target);
    };
    const showPath = (from, chain) => {
        path.replaceChildren();
        path.hidden = !chain.length;
        if (!chain.length) return;
        path.classList.toggle('mt-folded', readFolded());
        const last = chain.length - 1;
        // folded: value ← first step ⋯ +n ← last step
        const mid = i => (i > 0 && i < last ? ' mt-path-mid' : '');
        path.append(el(`<span class="mt-path-from">${esc(short(from, 30))}</span>`));
        chain.forEach((step, i) => {
            if (i === last && last > 1) {
                const more = el(`<span class="mt-path-more">⋯ +${last - 1}</span>`);
                more.addEventListener('click', () => {
                    path.classList.remove('mt-folded');
                    writeFolded(false);
                });
                path.append(more);
            }
            path.append(el(`<i class="fa-solid fa-arrow-left-long mt-path-arrow${mid(i)}"></i>`));
            if (step.root) {
                path.append(el(`<span class="mt-path-root${mid(i)}">${esc(varLabel(step.root))}</span>`));
                return;
            }
            const card = cardOf(result.docCard.get(step.doc));
            const chip = el(`<span class="mt-path-step${mid(i)}">${card ? `<span class="mt-n">${card.n}</span>` : ''}<code>${esc(short(step.raw, 48))}${step.scopeEnd != null ? '…' : ''}</code></span>`);
            chip.addEventListener('click', () => go(macroEl(step)));
            path.append(chip);
        });
        if (last > 1) {
            const toggle = el('<span class="mt-path-toggle fa-solid fa-chevron-up"></span>');
            toggle.addEventListener('click', () => writeFolded(path.classList.toggle('mt-folded')));
            path.append(toggle);
        }
    };
    /** Follow a read value back up; the first step is where it was written. */
    const trace = (clicked, ev, from) => {
        const chain = valueChain(ev);
        const steps = chain.filter(s => !s.root);
        pick(clicked, ...steps.map(macroEl));
        showPath(from, chain);
        go(steps[0] ? macroEl(steps[0]) : null);
    };

    msgs.addEventListener('click', (e) => {
        const mark = e.target.closest('.mt-hit');
        const ev = mark ? byN(mark.dataset.ev) : null;
        if (ev && isRead(ev)) {
            trace(mark, ev, mark.innerText);
            return;
        }
        showPath('', []);
        const macro = ev ? macroEl(ev) : null;
        if (macro) {
            pick(mark, macro);
            go(macro);
            return;
        }
        const card = cardEl(e.target.closest('.mt-msg')?.dataset.card);
        if (card) {
            pick(card);
            go(card);
        }
    });

    // a read inside a card climbs one more step
    left.addEventListener('click', (e) => {
        const span = e.target.closest('.mt-src-read');
        const ev = span ? byN(span.dataset.ev) : null;
        if (ev) trace(span, ev, ev.raw);
    });
}

export async function openTracePopup() {
    const names = presetNames();
    const current = oai_settings.preset_settings_openai;
    const profileList = profiles();
    const profileOptions = profileList.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const root = el(`
        <div class="mt-root" data-tab="preview">
            <div class="mt-bar">
                <select class="text_pole mt-preset">
                    ${names.map(n => `<option value="${esc(n)}"${n === current ? ' selected' : ''}>${esc(n)}</option>`).join('')}
                </select>
                <div class="menu_button fa-solid fa-rotate-right mt-rerun" title="다시 계산"></div>
                ${profileList.length ? `<select class="text_pole mt-profile" title="번역에 쓸 연결 프로필">${profileOptions}</select>` : ''}
                ${profileList.length ? '<div class="menu_button fa-solid fa-language mt-translate" title="주석 번역"></div>' : ''}
            </div>
            <div class="mt-tabs">
                <div class="mt-tab" data-tab="cards">프롬프트</div>
                <div class="mt-tab mt-on" data-tab="preview">미리보기</div>
            </div>
            <div class="mt-body">
                <div class="mt-col mt-col-cards">
                    <h4><i class="fa-solid fa-table-cells-large"></i>프롬프트</h4>
                    <div class="mt-path" hidden></div>
                    <div class="mt-cards-box"></div>
                </div>
                <div class="mt-col mt-col-preview">
                    <h4><i class="fa-solid fa-wand-magic-sparkles"></i>미리보기</h4>
                    <div class="mt-prompt"></div>
                </div>
            </div>
        </div>`);
    const palette = themePalette();
    applyPalette(root, palette);
    root.mtState = { result: null, tr: null };
    const select = root.querySelector('.mt-preset');
    const trButton = root.querySelector('.mt-translate');
    const rerun = () => render(root, select.value);
    select.addEventListener('change', () => {
        // a new preset has other comments; translate again when asked
        root.mtState.tr = null;
        trButton?.classList.remove('mt-on');
        rerun();
    });
    root.querySelector('.mt-rerun').addEventListener('click', rerun);
    root.querySelectorAll('.mt-tab').forEach(t => t.addEventListener('click', () => showTab(root, t.dataset.tab)));

    const profileSelect = root.querySelector('.mt-profile');
    if (profileSelect) {
        profileSelect.value = pickedProfile() ?? '';
        profileSelect.addEventListener('change', () => rememberProfile(profileSelect.value));
    }
    trButton?.addEventListener('click', async () => {
        const state = root.mtState;
        if (state.tr) {
            state.tr = null;
            trButton.classList.remove('mt-on');
            rerun();
            return;
        }
        const docs = state.result?.cards.flatMap(c => c.docs) ?? [];
        const texts = [...new Set(docs.flatMap(findComments).map(c => c.text))];
        if (!texts.length) {
            toastr.info('주석이 없습니다.');
            return;
        }
        const profileId = profileSelect?.value || pickedProfile();
        trButton.classList.add('mt-busy');
        try {
            state.tr = await translateTexts(texts, profileId);
            trButton.classList.add('mt-on');
            rerun();
        } catch (error) {
            console.error('[MacroTrace]', error);
            toastr.error(error?.message || String(error));
        } finally {
            trButton.classList.remove('mt-busy');
        }
    });

    rerun();
    const shown = callGenericPopup(root, POPUP_TYPE.DISPLAY, '', { large: true, wide: true, allowVerticalScrolling: false });
    // a dark theme still gets a light window
    if (palette.darkBg) root.closest('.popup')?.classList.add('mt-light-popup');
    await shown;
}
