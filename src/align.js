import { macros } from '../../../../macros/macro-system.js';
import { isFalseBoolean } from '../../../../utils.js';

const normalize = value => macros.engine.normalizeMacroResult(value);

/** What a {{.x …}} shorthand left in the text, when it can be told from the variable calls alone. */
function varResult(ev) {
    const first = ev.ops[0];
    const get = ev.ops.find(o => o.op === 'get');
    const set = ev.ops.find(o => o.op === 'set');
    // same rules as MacroCstWalker #executeVariableOperation
    switch (ev.op) {
        case '':
        case '++':
        case '--':
            return first ? normalize(first.result) : null;
        case '=':
        case '+=':
        case '-=':
            return '';
        case '??=':
        case '||=':
            if (set) return normalize(set.args[0]);
            return get ? normalize(get.result) : null;
        case '??':
            return get ? normalize(get.result) : null;
        case '||': {
            if (!get) return null;
            const falsy = !get.result || isFalseBoolean(normalize(get.result));
            return falsy ? null : normalize(get.result);
        }
        default:
            return null;
    }
}

function setSpan(it, start, end) {
    if (!it.ev) return;
    it.ev.outStart = start;
    it.ev.outEnd = end;
}

/**
 * Finds where each top-level macro's result sits in the doc's output, by walking the
 * plain text between macros. Stops quietly at the first place the texts disagree.
 */
export function alignDoc(doc) {
    if (doc.text == null || doc.output == null) return;
    const text = doc.text;
    const out = doc.output;

    const tops = new Map();
    for (const ev of doc.events) {
        if (ev.top && ev.start != null && !ev.synthetic && !tops.has(ev.start)) tops.set(ev.start, ev);
    }

    const items = doc.items.map((item) => {
        const ev = tops.get(item.start) ?? null;
        const isTrim = !item.isVar && item.name?.toLowerCase() === 'trim';
        let value = null;
        if (item.keepRaw) value = text.slice(item.start, item.end + 1);
        else if (isTrim) value = '';
        else if (ev?.kind === 'var') value = varResult(ev);
        else if (ev) value = ev.result ?? null;
        return { item, ev, value, isTrim };
    });

    const lits = [];
    let prev = 0;
    for (const it of items) {
        lits.push(text.slice(prev, it.item.start));
        prev = it.item.end + 1;
    }
    lits.push(text.slice(prev));
    items.forEach((it, i) => {
        if (!it.isTrim) return;
        lits[i] = lits[i].replace(/(?:\r?\n)*$/, '');
        lits[i + 1] = lits[i + 1].replace(/^(?:\r?\n)*/, '');
    });

    const unescape = s => s.replace(/\\([{}])/g, '$1');
    let cur = 0;
    let pending = null;
    for (let i = 0; i <= items.length; i++) {
        const lit = unescape(lits[i]);
        if (pending) {
            let idx = -1;
            if (lit) idx = out.indexOf(lit, cur);
            else if (i === items.length) idx = out.length;
            if (idx < 0) break;
            setSpan(pending, cur, idx);
            cur = idx;
            pending = null;
        }
        if (!out.startsWith(lit, cur)) break;
        cur += lit.length;
        if (i === items.length) break;
        const it = items[i];
        if (it.value == null) {
            pending = it;
            continue;
        }
        if (!out.startsWith(it.value, cur)) break;
        setSpan(it, cur, cur + it.value.length);
        cur += it.value.length;
    }

    // Macros nested inside a top-level one point at their outer macro's result.
    for (const ev of doc.events) {
        if (ev.outStart != null || ev.start == null) continue;
        const outer = items.find(it => it.ev && it.item.start <= ev.start && ev.end <= it.item.end);
        if (outer?.ev && outer.ev !== ev) ev.outer = outer.ev;
    }
}
