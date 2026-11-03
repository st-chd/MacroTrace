import { macros } from '../../../../macros/macro-system.js';
import { createScope } from './sandbox.js';

const { engine, registry, cstWalker, parser } = macros;

// Appended to a shorthand variable name while it is evaluated, so the sandbox
// knows which {{.x}} in the text is touching it. Removed again right after.
const TAG = '\u0001';

const WRITE_OPS = ['set', 'add', 'inc', 'dec', 'del'];

const VAR_HANDLERS = {
    setvar: (V) => ({ unnamedArgs: [n, v] }) => { V.local.set(n, v); return ''; },
    addvar: (V) => ({ unnamedArgs: [n, v] }) => { V.local.add(n, v); return ''; },
    incvar: (V) => ({ unnamedArgs: [n], normalize }) => normalize(V.local.inc(n)),
    decvar: (V) => ({ unnamedArgs: [n], normalize }) => normalize(V.local.dec(n)),
    getvar: (V) => ({ unnamedArgs: [n], normalize }) => normalize(V.local.get(n)),
    hasvar: (V) => ({ unnamedArgs: [n] }) => (V.local.has(n) ? 'true' : 'false'),
    deletevar: (V) => ({ unnamedArgs: [n] }) => { V.local.del(n); return ''; },
    setvarkey: (V) => ({ unnamedArgs: [n, k, v] }) => { V.local.set(n, v, { index: k }); return ''; },
    getvarkey: (V) => ({ unnamedArgs: [n, k], normalize }) => normalize(V.local.get(n, { index: k })),
    setglobalvar: (V) => ({ unnamedArgs: [n, v] }) => { V.global.set(n, v); return ''; },
    addglobalvar: (V) => ({ unnamedArgs: [n, v] }) => { V.global.add(n, v); return ''; },
    incglobalvar: (V) => ({ unnamedArgs: [n], normalize }) => normalize(V.global.inc(n)),
    decglobalvar: (V) => ({ unnamedArgs: [n], normalize }) => normalize(V.global.dec(n)),
    getglobalvar: (V) => ({ unnamedArgs: [n], normalize }) => normalize(V.global.get(n)),
    hasglobalvar: (V) => ({ unnamedArgs: [n] }) => (V.global.has(n) ? 'true' : 'false'),
    deleteglobalvar: (V) => ({ unnamedArgs: [n] }) => { V.global.del(n); return ''; },
    setglobalvarkey: (V) => ({ unnamedArgs: [n, k, v] }) => { V.global.set(n, v, { index: k }); return ''; },
    getglobalvarkey: (V) => ({ unnamedArgs: [n, k], normalize }) => normalize(V.global.get(n, { index: k })),
};

function patch(obj, key, value) {
    const own = Object.prototype.hasOwnProperty.call(obj, key);
    const prev = obj[key];
    obj[key] = value;
    return () => {
        if (own) obj[key] = prev;
        else delete obj[key];
    };
}

function nodeRange(node) {
    const start = node.children?.['Macro.Start']?.[0]?.startOffset;
    const end = node.children?.['Macro.End']?.[0]?.endOffset;
    return Number.isInteger(start) && Number.isInteger(end) ? { start, end } : null;
}

function walkNodes(node, fn) {
    if (!node?.children) return;
    for (const list of Object.values(node.children)) {
        for (const child of list) {
            if (child?.children) {
                fn(child);
                walkNodes(child, fn);
            }
        }
    }
}

/**
 * Top-level items of a document, with {{x}}…{{/x}} merged into one item,
 * the way MacroCstWalker pairs them.
 */
function topItems(cst) {
    const nodes = (cst?.children?.macro || [])
        .map(node => ({ node, range: nodeRange(node) }))
        .filter(x => x.range)
        .sort((a, b) => a.range.start - b.range.start);
    const stack = [];
    const items = [];
    for (const x of nodes) {
        const info = cstWalker.extractMacroInfo(x.node);
        const item = { node: x.node, start: x.range.start, end: x.range.end, openStart: x.range.start, openEnd: x.range.end, name: info?.name ?? null, isVar: !info };
        if (info?.isClosing) {
            const i = stack.findLastIndex(s => s.name?.toLowerCase() === info.name.toLowerCase());
            if (i !== -1) {
                const opener = stack[i];
                stack.splice(i);
                opener.end = item.end;
                opener.closeStart = item.start;
                opener.scoped = true;
                // drop everything that now sits inside the opener's block
                while (items.length && items.at(-1) !== opener) items.pop();
                continue;
            }
            item.keepRaw = true;
        } else if (info) {
            stack.push(item);
        }
        items.push(item);
    }
    return items;
}

export function createTrace({ local, global }) {
    const initial = { local: structuredClone(local), global: structuredClone(global) };
    const store = { local, global };
    const plain = { local: createScope(store.local), global: createScope(store.global) };

    const t = {
        docs: [],
        events: [],
        seq: 0,
        source: null,
        doc: null,
        callStack: [],
        tags: [],
        untag: [],
    };

    function place(ev, frame, relStart, relEnd) {
        const doc = frame.doc;
        if (frame.base != null) {
            ev.start = frame.base + relStart;
            ev.end = frame.base + relEnd;
            doc.claimed.add(ev.start);
            return;
        }
        const parent = frame.parent;
        const from = parent?.start ?? 0;
        const limit = parent ? (doc.blockEnd.get(parent.start) ?? parent.end) : doc.text.length - 1;
        let idx = doc.text.indexOf(ev.raw, from);
        while (idx >= 0 && doc.claimed.has(idx)) idx = doc.text.indexOf(ev.raw, idx + 1);
        if (idx >= 0 && idx + ev.raw.length - 1 <= limit) {
            ev.start = idx;
            ev.end = idx + ev.raw.length - 1;
            doc.claimed.add(idx);
            return;
        }
        ev.start = parent?.start ?? null;
        ev.end = parent?.end ?? null;
        ev.synthetic = true;
    }

    function addEvent(ev, frame, relStart, relEnd) {
        ev.doc = frame.doc;
        ev.top = frame === frame.doc.topFrame && t.callStack.length === 0;
        ev.depth = t.callStack.length;
        ev.ops = [];
        place(ev, frame, relStart, relEnd);
        t.events.push(ev);
        frame.doc.events.push(ev);
        return ev;
    }

    function tagEvent(tag) {
        if (!tag.ev) {
            // tags from re-parsed arguments have no frame; they are placed by searching their text
            const frame = tag.frame ?? { doc: t.doc, text: null, parent: t.callStack.at(-1) ?? null, base: null };
            tag.ev = addEvent({ kind: 'var', n: ++t.seq, name: tag.name, raw: tag.raw, op: tag.op, scope: tag.scope }, frame, tag.start, tag.end);
        }
        return tag.ev;
    }

    // variable → the macro that wrote it last, so a read can point back to it
    const lastWrite = new Map();

    function wrapScope(kind) {
        const s = plain[kind];
        const out = {};
        for (const op of Object.keys(s)) {
            out[op] = (name, ...args) => {
                let tag = null;
                if (typeof name === 'string' && name.includes(TAG)) {
                    const i = name.indexOf(TAG);
                    tag = t.tags[Number(name.slice(i + 1))] ?? null;
                    name = name.slice(0, i);
                }
                const existed = s.has(name);
                const before = existed ? store[kind][name] : undefined;
                const owner = tag ? tagEvent(tag) : (t.callStack.at(-1) ?? null);
                const result = s[op](name, ...args);
                owner?.ops.push({ scope: kind, op, name, args, result, existed, before, after: store[kind][name] });
                const key = `${kind}:${name}`;
                if (WRITE_OPS.includes(op)) {
                    // adding builds on the earlier value, so remember where that came from
                    if (owner && ['add', 'inc', 'dec'].includes(op) && owner.prevWrite === undefined) {
                        owner.prevWrite = lastWrite.get(key) ?? null;
                        if (!owner.prevWrite && existed) owner.prevVar = { scope: kind, name };
                    }
                    lastWrite.set(key, owner);
                } else if (op === 'get' && owner && owner.from === undefined) {
                    owner.from = lastWrite.get(key) ?? null;
                    owner.readVar = { scope: kind, name };
                }
                return result;
            };
        }
        return out;
    }

    const sandbox = { local: wrapScope('local'), global: wrapScope('global') };

    function locate(doc, frame) {
        const p = frame.parent;
        if (!p || p.start == null) return null;
        const limit = doc.blockEnd.get(p.start) ?? p.end;
        const idx = doc.text.indexOf(frame.text, p.start);
        return idx >= 0 && idx + frame.text.length - 1 <= limit ? idx : null;
    }

    // Tags stay on the tokens until the top-level evaluation ends (see the evaluate patch).
    function tagCst(cst, text) {
        walkNodes(cst, (node) => {
            const expr = node.children?.variableExpr?.[0];
            if (!expr || node.name !== 'macro') return;
            const range = nodeRange(node);
            const token = expr.children?.['Var.identifier']?.[0];
            if (!range || !token) return;
            const isGlobal = !(expr.children['Var.scope'] || []).some(x => x.tokenType?.name === 'Var.LocalPrefix');
            const opToken = expr.children.variableOperator?.[0]?.children?.['Var.operator']?.[0];
            const id = t.tags.length;
            t.tags.push({
                cst,
                frame: null,
                start: range.start,
                end: range.end,
                raw: text.slice(range.start, range.end + 1),
                name: (isGlobal ? '$' : '.') + token.image,
                scope: isGlobal ? 'global' : 'local',
                op: opToken?.image ?? '',
                ev: null,
            });
            t.untag.push([token, token.image]);
            token.image = token.image + TAG + id;
        });
    }

    function noteBlocks(cst, frame) {
        if (frame.base == null) return;
        const items = topItems(cst);
        for (const item of items) {
            if (!item.scoped) continue;
            frame.doc.blockEnd.set(frame.base + item.openStart, frame.base + item.end);
            // {{if}}-like blocks only run the part they pick; the rest is shown as skipped.
            if (registry.getMacro(item.name)?.delayArgResolution) {
                frame.doc.lazyBlocks.push({ from: frame.base + item.openEnd + 1, to: frame.base + item.closeStart - 1 });
            }
        }
        if (frame === frame.doc.topFrame) {
            frame.doc.items = items;
            const nodes = [];
            walkNodes(cst, (node) => {
                const range = node.name === 'macro' ? nodeRange(node) : null;
                if (!range) return;
                const info = cstWalker.extractMacroInfo(node);
                nodes.push({ ...range, syntax: !!info && (info.isClosing || info.name.toLowerCase() === 'else') });
            });
            frame.doc.nodes = nodes;
        }
    }

    function resolveWrap(call, frame, resolveMacro) {
        const lower = (call.name || '').toLowerCase();
        const known = !!call.name && (registry.hasMacro(call.name) || Object.hasOwn(call.env?.dynamicMacros ?? {}, lower));
        // macros inside arguments are re-parsed, so their range is relative to the argument; globalOffset is not
        const rel = Number.isInteger(call.globalOffset) ? call.globalOffset - frame.ctx : call.range.startOffset;
        const ev = addEvent({ kind: known ? 'macro' : 'unknown', n: known ? ++t.seq : null, name: call.name, raw: call.rawWithBraces }, frame, rel, rel + call.range.endOffset - call.range.startOffset);
        // {{setvar::x}}…{{/setvar}}: the range given is only the opening tag; the value runs to the closing one
        if (call.isScoped && ev.start != null) ev.scopeEnd = frame.doc.blockEnd.get(ev.start) ?? null;
        t.callStack.push(ev);
        try {
            const value = resolveMacro(call);
            ev.result = value;
            ev.failed = known && value === `{{${call.rawInner}}}` && lower !== 'trim';
            return value;
        } finally {
            t.callStack.pop();
        }
    }

    function run(fn) {
        const origEvaluate = engine.evaluate;
        const origEvaluateDocument = cstWalker.evaluateDocument;
        const origParse = parser.parseDocument;
        const origGetContext = SillyTavern.getContext;
        const restores = [];

        restores.push(patch(engine, 'evaluate', function (input, env, opts) {
            if (t.doc || !input) return origEvaluate.call(engine, input, env, opts);
            const doc = {
                id: t.docs.length,
                source: t.source,
                input,
                text: null,
                output: null,
                items: [],
                nodes: [],
                events: [],
                claimed: new Set(),
                blockEnd: new Map(),
                lazyBlocks: [],
                ran: [],
                topFrame: null,
            };
            t.docs.push(doc);
            t.doc = doc;
            try {
                doc.output = origEvaluate.call(engine, input, env, opts);
                return doc.output;
            } finally {
                t.doc = null;
                t.untag.forEach(([token, image]) => { token.image = image; });
                t.untag.length = 0;
            }
        }));

        restores.push(patch(parser, 'parseDocument', function (input) {
            const res = origParse.call(parser, input);
            if (t.doc && res?.cst) tagCst(res.cst, input);
            return res;
        }));

        restores.push(patch(cstWalker, 'evaluateDocument', function (options) {
            const doc = t.doc;
            if (!doc) return origEvaluateDocument.call(cstWalker, options);
            const frame = { doc, text: options.text, ctx: options.contextOffset ?? 0, parent: t.callStack.at(-1) ?? null, base: null };
            if (!doc.topFrame) {
                doc.topFrame = frame;
                doc.text = options.text;
                frame.base = 0;
            } else {
                frame.base = locate(doc, frame);
                if (frame.base != null) doc.ran.push({ from: frame.base, to: frame.base + frame.text.length - 1 });
            }
            noteBlocks(options.cst, frame);
            for (const tag of t.tags) {
                if (tag.cst === options.cst && !tag.frame) tag.frame = frame;
            }
            const resolveMacro = options.resolveMacro;
            return origEvaluateDocument.call(cstWalker, { ...options, resolveMacro: call => resolveWrap(call, frame, resolveMacro) });
        }));

        for (const def of registry.getAllMacros()) {
            const key = String(def.aliasOf ?? def.name).toLowerCase();
            if (VAR_HANDLERS[key]) {
                restores.push(patch(def, 'handler', VAR_HANDLERS[key](sandbox)));
            } else if (def.category === macros.category.VARIABLE) {
                // A variable macro this tool does not know: never let it reach the real variables.
                restores.push(patch(def, 'handler', ({ rawOriginal }) => rawOriginal));
            }
        }

        restores.push(patch(SillyTavern, 'getContext', function (...args) {
            const ctx = origGetContext.apply(this, args);
            ctx.variables = sandbox;
            return ctx;
        }));

        try {
            return fn();
        } finally {
            t.doc = null;
            t.callStack.length = 0;
            t.untag.forEach(([token, image]) => { token.image = image; });
            t.untag.length = 0;
            restores.reverse().forEach(r => r());
        }
    }

    return {
        run,
        setSource(source) { t.source = source; },
        docs: t.docs,
        events: t.events,
        initial,
        store,
    };
}
