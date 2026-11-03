// Plain-text search marks for the two columns.

/** Wraps every match of `query` in text under `root` with <span class="mt-find">; returns them in order. */
export function markText(root, query, accept = () => true) {
    const q = query.toLowerCase();
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: n => (n.nodeValue.toLowerCase().includes(q) && accept(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const found = [];
    for (const node of nodes) {
        const text = node.nodeValue;
        const lower = text.toLowerCase();
        const frag = document.createDocumentFragment();
        let cur = 0;
        let i;
        while ((i = lower.indexOf(q, cur)) !== -1) {
            if (i > cur) frag.append(text.slice(cur, i));
            const span = document.createElement('span');
            span.className = 'mt-find';
            span.textContent = text.slice(i, i + q.length);
            frag.append(span);
            found.push(span);
            cur = i + q.length;
        }
        frag.append(text.slice(cur));
        node.replaceWith(frag);
    }
    return found;
}

export function clearMarks(root) {
    root.querySelectorAll('.mt-find').forEach(s => s.replaceWith(s.textContent));
    root.normalize();
}

/**
 * Wires a search row (input, count, ↑ ↓). `apply(query)` marks the current content and returns
 * the marks; it is looked up on every search so it can change with each render.
 */
export function searchRow(bar, apply) {
    const input = bar.querySelector('.mt-search-input');
    const count = bar.querySelector('.mt-search-count');
    let marks = [];
    let at = -1;
    const show = () => {
        count.textContent = input.value.trim() ? `${marks.length ? at + 1 : 0}/${marks.length}` : '';
    };
    const focus = (i, scroll) => {
        marks[at]?.classList.remove('mt-find-cur');
        at = i;
        const m = marks[at];
        if (m) {
            m.classList.add('mt-find-cur');
            if (scroll) m.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
        show();
    };
    const refresh = (scroll) => {
        marks = apply()(input.value.trim()) ?? [];
        at = -1;
        if (marks.length) focus(0, scroll);
        else show();
    };
    const step = (d) => {
        if (marks.length) focus((at + d + marks.length) % marks.length, true);
    };
    input.addEventListener('input', () => refresh(true));
    input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
    });
    bar.querySelector('.mt-search-prev').addEventListener('click', () => step(-1));
    bar.querySelector('.mt-search-next').addEventListener('click', () => step(1));
    return { refresh };
}
