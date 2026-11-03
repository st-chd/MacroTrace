// Colors taken from the active ST theme, kept light whatever the theme is.

function toRgb(value) {
    if (!value) return null;
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
}

function hsl({ r, g, b }) {
    const [R, G, B] = [r / 255, g / 255, b / 255];
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return { s, l };
}

const rgbText = c => `rgb(${c.r}, ${c.g}, ${c.b})`;

/**
 * The theme's accent is whichever of its italics / quote / underline colors is the most
 * vivid without being near black or white; themes put it in different slots.
 */
export function themePalette() {
    const css = getComputedStyle(document.body);
    const read = name => toRgb(css.getPropertyValue(name).trim());

    let best = null;
    for (const name of ['--SmartThemeEmColor', '--SmartThemeQuoteColor', '--SmartThemeUnderlineColor']) {
        const c = read(name);
        if (!c || c.a < 0.3) continue;
        const { s, l } = hsl(c);
        if (l < 0.18 || l > 0.85 || s < 0.25) continue;
        const score = s * (1 - Math.abs(l - 0.5));
        if (!best || score > best.score) best = { score, c, l };
    }
    const accent = best ? rgbText(best.c) : '#64748b';
    // badges carry white text, so a light accent is taken darker there
    const strong = best && best.l > 0.55 ? `color-mix(in srgb, ${accent} 68%, #000)` : accent;

    const text = read('--SmartThemeBodyColor');
    const bg = read('--SmartThemeBlurTintColor');
    return {
        accent,
        strong,
        text: text && hsl(text).l < 0.45 ? rgbText(text) : '#2b2b30',
        darkBg: !!bg && bg.a > 0.3 && hsl(bg).l < 0.6,
    };
}

export function applyPalette(root, palette) {
    root.style.setProperty('--mt-accent', palette.accent);
    root.style.setProperty('--mt-accent-strong', palette.strong);
    root.style.setProperty('--mt-text', palette.text);
}
