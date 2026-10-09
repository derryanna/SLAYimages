// NovelAI V4.5 comics for SLAY Images: structured instruction parsing, prompt
// composition for the nai-vibe plugin, and Russian speech-bubble typesetting.
//
// Pure functions only (no DOM access except inside renderBubbles, which takes a
// 2D context). index.js imports this file lazily; node unit tests import it directly.

export const BUBBLE_FONT_FAMILY = '"Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif';
export const BUBBLE_FONT_WEIGHT = '600';

// Tags that fight a multi-panel page. Stripped from the settings negative when the request is a comic.
const ANTI_COMIC_NEGATIVES = ['multiple views', 'split screen', 'comic', 'speech bubble'];
// Appended to the negative when bubbles are typeset later — NAI must leave them blank.
export const BLANK_BUBBLE_NEGATIVES = ['text', 'english text', 'letters', 'writing', 'signature'];

const VALID_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'];
const CYRILLIC_RE = /[Ѐ-ӿԀ-ԯ]+/g;

// ─────────────────────────── per-image model / look ───────────────────────────

export const NAI_MODEL_45 = 'nai-diffusion-4-5-full';
export const NAI_MODEL_V5 = 'nai-diffusion-5-full';

// What the block may write into "model" (or "look"). Anything else → null → the UI setting wins.
const MODEL_ALIASES = {
    '4.5': NAI_MODEL_45, 'v4.5': NAI_MODEL_45, '45': NAI_MODEL_45, 'v45': NAI_MODEL_45, 'hot': NAI_MODEL_45,
    'nai-diffusion-4-5-full': NAI_MODEL_45, 'nai-diffusion-4-5-curated': 'nai-diffusion-4-5-curated',
    'v5': NAI_MODEL_V5, '5': NAI_MODEL_V5, 'clean': NAI_MODEL_V5, 'nai-diffusion-5-full': NAI_MODEL_V5,
};

export function normalizeNaiModel(v) {
    const s = String(v ?? '').trim().toLowerCase();
    return MODEL_ALIASES[s] || null;
}

export function isNaiV5(model) {
    return /^nai-diffusion-5/.test(String(model || ''));
}

// House vibes for 4.5 (names of .naiv4vibe files on the server; see README).
// violet = s3 (painterly skin, muted colours), red = s1 (warmth; 0.2 — above that it tints the hair),
// dan = the Danone panel crop for night/intimate scenes.
export const NAI_HOUSE_VIBES = {
    // Anna's pick 8 Oct 2026: the vibe made from her own Aurora reference, alone (sheet «1 E3, глаза»)
    day: [{ name: 'aur10', strength: 0.6 }],
    night: [{ name: 'aur10', strength: 0.6 }],
};

// V5 has no vibes; this phrase at the end of the base does the same job there.
export const NAI_V5_SUFFIX = 'soft painterly shading, faces close and large in frame';

/**
 * Model, vibes and base suffix for one image.
 *   blockModel true: instr.model (from the block) beats settingsModel; absent → settingsModel.
 *   blockModel false (Anna's choice 8 Oct 2026, the default): the UI model always wins, the block's model is ignored.
 *   V5: vibes always off (V5 rejects 4.5 vibes) + NAI_V5_SUFFIX.
 *   4.5: the vibes ticked in the UI; none ticked → house set (night when the base is nsfw),
 *        limited to the vibe names the server actually has when serverVibes is given.
 */
export function resolveNaiLook(instr, { settingsModel, uiVibes = [], serverVibes = null, blockModel = false } = {}) {
    const useBlock = blockModel && !!instr?.model;
    const model = (useBlock ? instr.model : settingsModel) || instr?.model || NAI_MODEL_V5;
    const v5 = isNaiV5(model);
    let vibes = [];
    let missing = [];
    if (!v5) {
        if (uiVibes.length) {
            vibes = uiVibes.map(v => ({ name: v.name, strength: v.strength }));
        } else {
            const house = instr?.nsfw ? NAI_HOUSE_VIBES.night : NAI_HOUSE_VIBES.day;
            if (Array.isArray(serverVibes)) {
                const have = new Set(serverVibes.map(n => String(n).toLowerCase()));
                vibes = house.filter(v => have.has(v.name));
                missing = house.filter(v => !have.has(v.name)).map(v => v.name);
            } else {
                vibes = house.slice();
            }
        }
    }
    return { model, v5, vibes, styleSuffix: v5 ? NAI_V5_SUFFIX : '', fromBlock: useBlock, missing };
}

// ─────────────────────────── instruction parsing ───────────────────────────

// ST can entity-encode non-ASCII inside the data-iig-instruction attribute ("&#1040;…").
export function decodeEntities(str) {
    if (typeof str !== 'string' || str.indexOf('&') === -1) return str;
    return str
        .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } })
        .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return m; } })
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function cleanTags(s) {
    return String(s || '')
        .replace(/\s+/g, ' ')
        .replace(/\s*,\s*/g, ', ')
        .replace(/(, )+/g, ', ')
        .replace(/^[,\s]+|[,\s]+$/g, '')
        .trim();
}

function parseCenter(c) {
    if (!c || typeof c !== 'object') return null;
    const x = Number(c.x), y = Number(c.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function normalizeRatio(r) {
    const s = String(r || '').trim();
    return VALID_RATIOS.includes(s) ? s : null;
}

// Old naicom block format: "base | boy Kakashi ... Text: Реплика | girl Aurora ...".
// Also pulls «quoted» Russian lines out of "NAME has a speech bubble saying «…»".
function parseLegacyPrompt(prompt) {
    const bubbles = [];
    let text = String(prompt || '');
    text = text.replace(/\b([\p{L}][\p{L}\-]*) has a (speech|thought) bubble saying «([^»]*)»/gu, (m, who, kind, line) => {
        if (line.trim()) bubbles.push({ speaker: who, text: line.trim() });
        return `${who} has an empty ${kind} bubble`;
    });
    const sections = text.split(/\s\|\s/).map(s => s.trim()).filter(Boolean);
    const base = sections.shift() || '';
    const characters = sections.map(sec => {
        let body = sec;
        const nameMatch = body.match(/^(?:boy|girl|man|woman|other)\s+([\p{L}][\p{L}\-]*)/iu);
        const name = nameMatch ? nameMatch[1] : '';
        const textAt = body.search(/\bText:\s*/);
        if (textAt >= 0) {
            const line = body.slice(textAt).replace(/^Text:\s*/, '').trim();
            body = body.slice(0, textAt);
            if (line && !bubbles.some(b => b.text === line)) bubbles.push({ speaker: name, text: line });
        }
        return { name, prompt: body, uc: '', center: null };
    });
    return { base, characters, bubbles };
}

function stripCyrillic(s) {
    return cleanTags(String(s || '').replace(/«[^»]*»/g, '').replace(CYRILLIC_RE, ''));
}

/**
 * Normalise a data-iig-instruction object into one shape.
 * Accepts the new structured form { base, characters, bubbles, aspect_ratio }
 * and the plain { prompt } form (including the old "|"-sectioned naicom prompts).
 */
export function parseNaiInstruction(data) {
    let d = data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = { prompt: d }; } }
    if (!d || typeof d !== 'object') d = {};

    const structured = typeof d.base === 'string' || Array.isArray(d.characters) || Array.isArray(d.bubbles);
    const str = (v) => decodeEntities(String(v ?? ''));
    let base, characters, bubbles;
    if (structured) {
        base = str(d.base ?? d.prompt);
        characters = (Array.isArray(d.characters) ? d.characters : []).map(c => ({
            name: str(c?.name).trim(),
            prompt: str(c?.prompt),
            uc: str(c?.uc || c?.negative),
            center: parseCenter(c?.center),
        }));
        bubbles = (Array.isArray(d.bubbles) ? d.bubbles : []).map(b => ({
            speaker: str(b?.speaker).trim(),
            text: str(b?.text).trim(),
        }));
    } else {
        ({ base, characters, bubbles } = parseLegacyPrompt(str(d.prompt)));
    }
    characters = characters
        .map(c => ({ ...c, prompt: stripCyrillic(c.prompt), uc: stripCyrillic(c.uc) }))
        .filter(c => c.prompt)
        .slice(0, 6);
    bubbles = bubbles.filter(b => b.text).slice(0, 6);
    base = stripCyrillic(base);
    const comic = /\bcomic\b|\bpanels?\b|\b4koma\b/i.test(base);
    return {
        structured,
        base,
        characters,
        bubbles,
        aspectRatio: normalizeRatio(d.aspect_ratio ?? d.aspectRatio),
        comic,
        negative: cleanTags(d.negative || d.uc || ''),
        // Block-chosen model ("4.5" | "v5", or a "look"); null = UI setting.
        model: normalizeNaiModel(d.model ?? d.look),
        nsfw: /\bnsfw\b|\bexplicit\b/i.test(base),
    };
}

// ─────────────────────────── prompt composition ───────────────────────────

// SLAY styles are prose for prompt-following models ("[STYLE: … Avoid: …]").
// NovelAI only wants tags: keep what is before "Avoid:", drop brackets and labels.
export function naiStyleTags(styleValue) {
    let s = String(styleValue || '');
    s = s.replace(/\[\s*style\s*:/gi, ' ').replace(/[\[\]]/g, ' ');
    const avoidAt = s.search(/\bavoid\s*:/i);
    if (avoidAt >= 0) s = s.slice(0, avoidAt);
    s = s.replace(/\b(style|art style)\s*:/gi, ' ');
    s = s.replace(/[.;]+/g, ',');
    return cleanTags(s);
}

// Split a tag list on commas, keeping NovelAI weight groups whole:
// "1.5::anime coloring, anime, anime style::, 1.4::nekido::" → two tokens, not four.
const TAG_TOKEN_RE = /\s*(-?\d*\.?\d+::[\s\S]*?::|[^,]+)/g;
function splitTags(s) {
    const out = [];
    for (const m of cleanTags(s).matchAll(TAG_TOKEN_RE)) {
        const t = m[1].trim();
        if (t) out.push(t);
    }
    return out;
}

function dedupeTags(list) {
    const seen = new Set();
    const out = [];
    for (const t of list) {
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(t);
    }
    return out;
}

/**
 * Negative for this request: the settings negative minus the tags that fight a
 * comic page, plus "no lettering" tags when bubbles are typeset afterwards.
 */
export function composeNaiNegative(settingsNegative, instr) {
    let tags = splitTags(settingsNegative);
    if (instr?.comic || instr?.bubbles?.length) {
        tags = tags.filter(t => !ANTI_COMIC_NEGATIVES.includes(t.toLowerCase()));
    }
    if (instr?.negative) tags = tags.concat(splitTags(instr.negative));
    if (instr?.bubbles?.length) tags = tags.concat(BLANK_BUBBLE_NEGATIVES);
    return dedupeTags(tags).join(', ');
}

/** Base caption: style tags first, then the scene, then the per-model suffix (V5 phrase). */
export function composeNaiPrompt(instr, styleTags, styleSuffix = '') {
    const parts = [];
    const style = cleanTags(styleTags);
    if (style) parts.push(style);
    if (instr.base) parts.push(instr.base);
    const suffix = cleanTags(styleSuffix);
    if (suffix) parts.push(suffix);
    let prompt = dedupeTags(splitTags(parts.join(', '))).join(', ');
    if (instr.bubbles?.length && !/speech bubble/i.test(prompt)) prompt += ', speech bubble, blank speech bubble';
    return prompt;
}

/** Body for POST /api/plugins/nai-vibe/generate. */
export function buildNaiPluginBody(instr, opts = {}) {
    const characters = (instr.characters || []).map(c => {
        const out = { prompt: c.prompt, uc: c.uc || '' };
        if (c.center) out.center = { x: c.center.x, y: c.center.y };
        return out;
    });
    const body = {
        prompt: composeNaiPrompt(instr, opts.styleTags, opts.styleSuffix),
        characters,
        negative_prompt: composeNaiNegative(opts.negative, instr),
        model: opts.model,
        sampler: opts.sampler || 'k_euler_ancestral',
        scheduler: opts.scheduler || 'karras',
        steps: opts.steps || 28,
        scale: opts.scale ?? 5,
        width: opts.width,
        height: opts.height,
        quality: opts.quality !== false,
        vibes: opts.vibes || [],
    };
    // Knobs from the settings panel; absent → the plugin's defaults (0 / random / off).
    if (Number.isFinite(Number(opts.cfgRescale))) body.cfg_rescale = Number(opts.cfgRescale);
    if (Number.isFinite(Number(opts.seed)) && Number(opts.seed) >= 0) body.seed = Math.floor(Number(opts.seed));
    if (Number(opts.skipCfgAboveSigma) > 0) body.skip_cfg_above_sigma = Number(opts.skipCfgAboveSigma);
    if (opts.allowAnlas === true) body.allow_anlas = true;
    return body;
}

// ─────────────────────────── bubble detection ───────────────────────────

// Dilate then erode a binary mask (square element of radius r), in place.
// Pixels outside the mask bounds count as empty, so the outer boundary does not grow.
function closeMask(mask, w, h, r) {
    if (r <= 0) return;
    const pass = (src, keep) => {
        const dst = new Uint8Array(src.length);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let v = keep ? 1 : 0;
            for (let dy = -r; dy <= r && v === (keep ? 1 : 0); dy++) for (let dx = -r; dx <= r; dx++) {
                const xx = x + dx, yy = y + dy;
                const s = (xx >= 0 && yy >= 0 && xx < w && yy < h) ? src[yy * w + xx] : 0;
                if (keep ? !s : s) { v = keep ? 0 : 1; break; }
            }
            dst[y * w + x] = v;
        }
        return dst;
    };
    const dilated = pass(mask, false);
    const eroded = pass(dilated, true);
    for (let k = 0; k < mask.length; k++) mask[k] = mask[k] || eroded[k] ? 1 : 0;
}

/**
 * Find white speech-bubble regions in an RGBA buffer (use a downscaled copy, ~300 px wide).
 * Returns regions with normalised bbox/centre plus a hole-filled pixel mask in buffer coords.
 */
export function findBubbleRegions(img, opts = {}) {
    const { width: W, height: H, data } = img;
    const o = {
        white: 222,          // min channel value for "white"
        chroma: 30,          // max (max-min) channel spread
        minArea: 0.003,      // of the image (small NovelAI bubbles sit near 0.005)
        maxArea: 0.16,
        minFill: 0.6,        // filled area / bbox area
        minEllipse: 0.7,     // IoU of the filled shape with the ellipse inscribed in its bbox
        minW: 0.11, minH: 0.06,
        maxAspect: 3.0,
        maxBorderRun: 0.25,  // reject when the region hugs an image edge for longer than this share of it
        minEdgeDark: 0.3,    // share of dark pixels in the ring just outside the region (the outline)
        darkLum: 150,
        minMeanWhite: 238,   // bubbles are paper-white inside; pale walls, curtains and skin are not
        ...opts,
    };
    const n = W * H;
    const white = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mn >= o.white && mx - mn <= o.chroma) white[i] = 1;
    }
    const label = new Int32Array(n).fill(-1);
    const regions = [];
    const stack = new Int32Array(n);
    for (let start = 0; start < n; start++) {
        if (!white[start] || label[start] !== -1) continue;
        const id = regions.length;
        let sp = 0, area = 0, sumMin = 0;
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        stack[sp++] = start; label[start] = id;
        while (sp > 0) {
            const i = stack[--sp];
            const x = i % W, y = (i - x) / W;
            area++;
            sumMin += Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            if (x > 0 && white[i - 1] && label[i - 1] === -1) { label[i - 1] = id; stack[sp++] = i - 1; }
            if (x < W - 1 && white[i + 1] && label[i + 1] === -1) { label[i + 1] = id; stack[sp++] = i + 1; }
            if (y > 0 && white[i - W] && label[i - W] === -1) { label[i - W] = id; stack[sp++] = i - W; }
            if (y < H - 1 && white[i + W] && label[i + W] === -1) { label[i + W] = id; stack[sp++] = i + W; }
        }
        regions.push({ id, area, x0, y0, x1, y1, meanWhite: sumMin / area });
    }

    const out = [];
    for (const r of regions) {
        const bw = r.x1 - r.x0 + 1, bh = r.y1 - r.y0 + 1;
        const areaFrac = r.area / n;
        if (areaFrac < o.minArea || areaFrac > o.maxArea) continue;
        if (r.meanWhite < o.minMeanWhite) continue;
        if (bw < o.minW * W || bh < o.minH * H) continue;
        const aspect = bw / bh;
        if (aspect > o.maxAspect || aspect < 1 / o.maxAspect) continue;
        // Fill the holes (lettering NAI drew inside): flood the non-member pixels from the bbox border;
        // whatever is not reached is enclosed and belongs to the bubble.
        const mask = new Uint8Array(bw * bh);
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
            mask[y * bw + x] = label[(r.y0 + y) * W + r.x0 + x] === r.id ? 1 : 0;
        }
        const reach = new Uint8Array(bw * bh);
        const st = [];
        const push = (x, y) => { const k = y * bw + x; if (!mask[k] && !reach[k]) { reach[k] = 1; st.push(k); } };
        for (let x = 0; x < bw; x++) { push(x, 0); push(x, bh - 1); }
        for (let y = 0; y < bh; y++) { push(0, y); push(bw - 1, y); }
        while (st.length) {
            const k = st.pop();
            const x = k % bw, y = (k - x) / bw;
            if (x > 0) push(x - 1, y); if (x < bw - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < bh - 1) push(x, y + 1);
        }
        for (let k = 0; k < mask.length; k++) if (!mask[k] && !reach[k]) mask[k] = 1;
        // Morphological closing: lettering that touches the outline is a bay, not a hole; close it too.
        closeMask(mask, bw, bh, o.closeRadius ?? 2);
        let filledArea = 0;
        for (let k = 0; k < mask.length; k++) if (mask[k]) filledArea++;
        const fill = filledArea / (bw * bh);
        if (fill < o.minFill) continue;
        // Shape check: a bubble is a blob close to the ellipse inscribed in its bbox;
        // collars, wall strips and window panes are not.
        let inter = 0, ell = 0;
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
            const ex = (x + 0.5 - bw / 2) / (bw / 2), ey = (y + 0.5 - bh / 2) / (bh / 2);
            const inEll = ex * ex + ey * ey <= 1;
            if (inEll) ell++;
            if (inEll && mask[y * bw + x]) inter++;
        }
        const ellipseIou = inter / (ell + filledArea - inter);
        if (ellipseIou < o.minEllipse) continue;
        // Walls and skies run along an image edge; bubbles only touch it briefly.
        const runs = [
            r.x0 === 0 ? bh : 0, r.x1 === W - 1 ? bh : 0,
            r.y0 === 0 ? bw : 0, r.y1 === H - 1 ? bw : 0,
        ];
        if (runs[0] / H > o.maxBorderRun || runs[1] / H > o.maxBorderRun || runs[2] / W > o.maxBorderRun || runs[3] / W > o.maxBorderRun) continue;
        // Outline check: dark pixels in a 2 px ring around the filled shape.
        let ring = 0, dark = 0;
        for (let y = -2; y < bh + 2; y++) for (let x = -2; x < bw + 2; x++) {
            const inside = x >= 0 && y >= 0 && x < bw && y < bh && mask[y * bw + x];
            if (inside) continue;
            let nearMember = false;
            for (let dy = -2; dy <= 2 && !nearMember; dy++) for (let dx = -2; dx <= 2; dx++) {
                const xx = x + dx, yy = y + dy;
                if (xx >= 0 && yy >= 0 && xx < bw && yy < bh && mask[yy * bw + xx]) { nearMember = true; break; }
            }
            if (!nearMember) continue;
            const px = r.x0 + x, py = r.y0 + y;
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            const p = (py * W + px) * 4;
            const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
            ring++;
            if (lum < o.darkLum) dark++;
        }
        const edgeDark = ring ? dark / ring : 0;
        if (edgeDark < o.minEdgeDark) continue;
        out.push({
            x: r.x0 / W, y: r.y0 / H, w: bw / W, h: bh / H,
            cx: (r.x0 + bw / 2) / W, cy: (r.y0 + bh / 2) / H,
            areaFrac, fill, edgeDark, ellipseIou,
            mask: { x0: r.x0, y0: r.y0, w: bw, h: bh, bits: mask },
        });
    }
    out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return out;
}

// ─────────────────────────── text fitting ───────────────────────────

/** Greedy word wrap; words longer than the line are broken by characters. */
export function wrapText(text, maxWidth, measure) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
        const probe = line ? `${line} ${w}` : w;
        if (measure(probe) <= maxWidth) { line = probe; continue; }
        if (line) { lines.push(line); line = ''; }
        if (measure(w) <= maxWidth) { line = w; continue; }
        // The word alone is wider than the line: break it by characters.
        let chunk = '';
        for (const ch of w) {
            if (chunk && measure(chunk + ch) > maxWidth) { lines.push(chunk); chunk = ch; } else chunk += ch;
        }
        line = chunk;
    }
    if (line) lines.push(line);
    return lines;
}

/**
 * Largest font size in [minSize, maxSize] at which the wrapped text fits the box.
 * measure(text, fontSize) → width in px. Returns null when it does not fit at minSize.
 */
export function fitText(text, boxW, boxH, measure, opts = {}) {
    const { minSize = 10, maxSize = 40, lineHeight = 1.22 } = opts;
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    for (let size = Math.floor(maxSize); size >= minSize; size--) {
        // Never split a word inside a bubble: a smaller size or another bubble instead.
        if (words.some(w => measure(w, size) > boxW)) continue;
        const lines = wrapText(text, boxW, t => measure(t, size));
        const widest = Math.max(...lines.map(l => measure(l, size)), 0);
        if (lines.length * size * lineHeight <= boxH && widest <= boxW) {
            return { fontSize: size, lines, lineHeight };
        }
    }
    return null;
}

// ─────────────────────────── bubble layout ───────────────────────────

function nameMatches(speaker, name) {
    const a = String(speaker || '').toLowerCase().trim();
    const b = String(name || '').toLowerCase().trim();
    if (!a || !b) return false;
    return a === b || a.startsWith(b) || b.startsWith(a);
}

function overlaps(a, b, pad = 0) {
    return !(a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x || a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y);
}

/**
 * Decide where each bubble's text goes.
 * @param {object} p
 *   bubbles     [{ speaker, text }]
 *   characters  [{ name, center: {x,y}|null }]  (normalised centers)
 *   regions     output of findBubbleRegions (normalised)
 *   width,height  output image size in px
 *   measure(text, fontSize) → px
 * @returns placements: [{ kind: 'region'|'drawn', text, speaker, fontSize, lines, lineHeight, box:{x,y,w,h}, region?, shape? }]
 */
// Reading order of detected bubbles: top to bottom by row, left to right inside a row.
export function readingOrder(regions, rowTol = 0.08) {
    const idx = regions.map((r, i) => i).sort((a, b) => regions[a].cy - regions[b].cy);
    const rows = [];
    for (const i of idx) {
        const row = rows.find(rw => Math.abs(regions[rw[0]].cy - regions[i].cy) < rowTol);
        if (row) row.push(i); else rows.push([i]);
    }
    const rank = new Array(regions.length);
    let k = 0;
    for (const rw of rows) for (const i of rw.sort((a, b) => regions[a].cx - regions[b].cx)) rank[i] = k++;
    return rank;
}

// Pick which detected bubble gets which line. NovelAI places characters freely on comic
// pages, so the planned centers are a weak hint. Comic convention is stronger: lines go
// into bubbles in reading order, and no bubble NovelAI drew should stay empty.
// Score: lines placed (200 each) > speaker distance (-100 × share of the diagonal) vs reading-order inversions (-15 each).
export function assignBubblesToRegions(bubbles, regions, ctx) {
    const { W, H, measure, minSize, maxSize, centerOf } = ctx;
    const n = bubbles.length, m = regions.length;
    const result = new Array(n).fill(null);
    if (!n || !m) return result;
    const rank = readingOrder(regions);
    const diag = Math.hypot(W, H);
    const fits = bubbles.map(b => regions.map(r => {
        const boxW = r.w * W * 0.74, boxH = r.h * H * 0.74;
        const fit = fitText(b.text, boxW, boxH, measure, { minSize, maxSize });
        return fit ? { r, fit, boxW, boxH } : null;
    }));
    const dist = bubbles.map(b => {
        const a = centerOf(b.speaker);
        return regions.map(r => (a ? Math.hypot(r.cx * W - a.x, r.cy * H - a.y) / diag : 0));
    });
    let best = null, bestScore = -Infinity;
    const pick = new Array(n).fill(-1);
    const used = new Array(m).fill(false);
    const score = () => {
        let s = 0;
        for (let i = 0; i < n; i++) {
            if (pick[i] < 0) continue;
            s += 200 - 100 * dist[i][pick[i]] - 0.01 * i; // ties: earlier lines first
            for (let j = i + 1; j < n; j++) if (pick[j] >= 0 && rank[pick[i]] > rank[pick[j]]) s -= 15;
        }
        return s;
    };
    const exhaustive = Math.pow(m + 1, n) <= 20000;
    const walk = (i) => {
        if (i === n) {
            const s = score();
            if (s > bestScore) { bestScore = s; best = pick.slice(); }
            return;
        }
        for (let j = -1; j < m; j++) {
            if (j >= 0 && (used[j] || !fits[i][j])) continue;
            pick[i] = j; if (j >= 0) used[j] = true;
            walk(i + 1);
            if (j >= 0) used[j] = false; pick[i] = -1;
        }
    };
    if (exhaustive) walk(0);
    else {
        // Too many combinations: lines in order into the first free bubble (reading order) that fits.
        const order = regions.map((r, i) => i).sort((a, b) => rank[a] - rank[b]);
        best = bubbles.map((b, i) => {
            const j = order.find(j => !used[j] && fits[i][j]);
            if (j === undefined) return -1;
            used[j] = true; return j;
        });
    }
    best.forEach((j, i) => { if (j >= 0) result[i] = fits[i][j]; });
    return result;
}

export function layoutBubbles(p) {
    const { bubbles = [], characters = [], regions = [], width: W, height: H, measure } = p;
    const o = {
        baseSize: Math.round(Math.min(W, H) * 0.03),
        margin: Math.round(Math.min(W, H) * 0.02),
        maxDrawnLineW: W * 0.30,
        ...p.opts,
    };
    const base = Math.max(12, Math.min(44, o.baseSize));
    const minSize = Math.max(10, Math.round(base * 0.62));
    const maxSize = Math.round(base * 1.35);

    const centerOf = (speaker) => {
        const c = characters.find(ch => nameMatches(speaker, ch.name)) || null;
        return c?.center ? { x: c.center.x * W, y: c.center.y * H } : null;
    };

    const assign = assignBubblesToRegions(bubbles, regions, { W, H, measure, minSize, maxSize, centerOf });
    const placements = [];
    const occupied = []; // boxes already taken (px)

    bubbles.forEach((b, idx) => {
        const anchor = centerOf(b.speaker);
        const asg = assign[idx];
        if (asg) {
            const { r, fit, boxW, boxH } = asg;
            const bw = r.w * W, bh = r.h * H;
            const box = { x: r.x * W + (bw - boxW) / 2, y: r.y * H + (bh - boxH) / 2, w: boxW, h: boxH };
            placements.push({ kind: 'region', text: b.text, speaker: b.speaker, ...fit, box, region: r });
            occupied.push({ x: r.x * W, y: r.y * H, w: bw, h: bh });
            return;
        }
        // Fallback: draw our own bubble. We do not know where the face is, so the bubble goes
        // into the top strip (hair/background in nearly every crop), pushed toward the image
        // edge on the speaker's side — the way the reference pages place them.
        let size = Math.round(base * 0.9), lineW = o.maxDrawnLineW;
        let lines = wrapText(b.text, lineW, t => measure(t, size));
        if (lines.length > 3) { size = Math.max(minSize, Math.round(base * 0.8)); lineW = W * 0.34; lines = wrapText(b.text, lineW, t => measure(t, size)); }
        const lh = 1.22;
        const tw = Math.max(...lines.map(l => measure(l, size)), size);
        const th = lines.length * size * lh;
        const pad = size * 0.7;
        const rx = Math.max(tw * 0.66 + pad, size * 2), ry = Math.max(th * 0.78 + pad, size * 1.7);
        const a = anchor || { x: idx % 2 === 0 ? W * 0.3 : W * 0.7, y: H * 0.45 };
        const leftSide = a.x < W / 2;
        let cx = leftSide ? Math.min(a.x - 0.2 * W, o.margin + rx) : Math.max(a.x + 0.2 * W, W - o.margin - rx);
        cx = Math.min(W - o.margin - rx, Math.max(o.margin + rx, cx));
        let cy = o.margin + ry;
        let box = { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry };
        for (let tries = 0; tries < 4; tries++) {
            const hit = occupied.find(q => overlaps(box, q, o.margin));
            if (!hit) break;
            // slide down past the obstacle
            cy = Math.min(H - o.margin - ry, hit.y + hit.h + o.margin + ry);
            box = { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry };
        }
        // Tail: short, aimed at head height on the speaker's side; never longer than 5% of the image.
        const target = { x: a.x, y: Math.max(cy + ry, a.y - 0.26 * H) };
        const dx = target.x - cx, dy = target.y - cy;
        const dist = Math.hypot(dx, dy) || 1;
        const edgeT = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));  // scale factor to the ellipse edge
        const edgeDist = dist * edgeT;
        const tailLen = Math.min(dist - edgeDist, 0.05 * H);
        const head = tailLen > size * 0.4 ? { x: cx + dx / dist * (edgeDist + tailLen), y: cy + dy / dist * (edgeDist + tailLen) } : null;
        const inside = !head;
        placements.push({
            kind: 'drawn', text: b.text, speaker: b.speaker, fontSize: size, lines, lineHeight: lh,
            box: { x: cx - tw / 2, y: cy - th / 2, w: tw, h: th },
            shape: { cx, cy, rx, ry, tail: inside ? null : head },
        });
        occupied.push(box);
    });
    // NovelAI drew more bubbles than there are lines (or a line fit nowhere): an empty
    // bubble looks broken, so it gets the comic ellipsis.
    const usedRegions = new Set(assign.filter(Boolean).map(x => x.r));
    for (const r of regions) {
        if (usedRegions.has(r)) continue;
        const bw = r.w * W, bh = r.h * H, boxW = bw * 0.74, boxH = bh * 0.74;
        const fit = fitText('…', boxW, boxH, measure, { minSize: 10, maxSize });
        if (!fit) continue;
        const box = { x: r.x * W + (bw - boxW) / 2, y: r.y * H + (bh - boxH) / 2, w: boxW, h: boxH };
        placements.push({ kind: 'region', text: '…', speaker: '', ...fit, box, region: r, filler: true });
        occupied.push({ x: r.x * W, y: r.y * H, w: bw, h: bh });
    }

    return placements;
}

// ─────────────────────────── rendering ───────────────────────────

export function bubbleFont(size) {
    return `${BUBBLE_FONT_WEIGHT} ${size}px ${BUBBLE_FONT_FAMILY}`;
}

/**
 * Paint placements onto a 2D context whose canvas is the full-size image.
 * maskCanvasFor(region) → a canvas/ImageBitmap of the region mask (optional; used to
 * whiten lettering NAI drew inside a detected bubble).
 */
export function renderBubbles(ctx, placements, p = {}) {
    const { width: W, height: H, maskCanvasFor } = p;
    const stroke = Math.max(2, Math.round(Math.min(W, H) / 350));
    for (const pl of placements) {
        ctx.save();
        if (pl.kind === 'region' && pl.region) {
            const r = pl.region;
            const mc = maskCanvasFor ? maskCanvasFor(r) : null;
            if (mc) {
                // Paint white through the filled mask, slightly shrunk so the dark outline survives.
                ctx.globalCompositeOperation = 'source-over';
                ctx.drawImage(mc, r.x * W + stroke * 0.5, r.y * H + stroke * 0.5, r.w * W - stroke, r.h * H - stroke);
            } else {
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.ellipse((r.x + r.w / 2) * W, (r.y + r.h / 2) * H, r.w * W / 2 - stroke, r.h * H / 2 - stroke, 0, 0, Math.PI * 2);
                ctx.fill();
            }
        } else if (pl.shape) {
            const s = pl.shape;
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#111';
            ctx.lineWidth = stroke;
            ctx.lineJoin = 'round';
            if (s.tail) {
                // Tail: a triangle from the ellipse edge toward the head.
                const ang = Math.atan2(s.tail.y - s.cy, s.tail.x - s.cx);
                const spread = 0.2;
                const p1 = { x: s.cx + s.rx * Math.cos(ang - spread) * 0.92, y: s.cy + s.ry * Math.sin(ang - spread) * 0.92 };
                const p2 = { x: s.cx + s.rx * Math.cos(ang + spread) * 0.92, y: s.cy + s.ry * Math.sin(ang + spread) * 0.92 };
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y); ctx.lineTo(s.tail.x, s.tail.y); ctx.lineTo(p2.x, p2.y); ctx.closePath();
                ctx.fill(); ctx.stroke();
            }
            ctx.beginPath();
            ctx.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();
            if (s.tail) {
                // hide the stroke segment where the tail joins the ellipse
                const ang = Math.atan2(s.tail.y - s.cy, s.tail.x - s.cx);
                const spread = 0.18;
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.moveTo(s.cx, s.cy);
                ctx.lineTo(s.cx + s.rx * Math.cos(ang - spread) * 0.95, s.cy + s.ry * Math.sin(ang - spread) * 0.95);
                ctx.lineTo(s.tail.x * 0.15 + s.cx * 0.85, s.tail.y * 0.15 + s.cy * 0.85);
                ctx.lineTo(s.cx + s.rx * Math.cos(ang + spread) * 0.95, s.cy + s.ry * Math.sin(ang + spread) * 0.95);
                ctx.closePath();
                ctx.fill();
            }
        }
        // Text
        ctx.fillStyle = '#111';
        ctx.font = bubbleFont(pl.fontSize);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lh = pl.fontSize * pl.lineHeight;
        const total = pl.lines.length * lh;
        const cx = pl.box.x + pl.box.w / 2;
        let y = pl.box.y + pl.box.h / 2 - total / 2 + lh / 2;
        for (const line of pl.lines) { ctx.fillText(line, cx, y); y += lh; }
        ctx.restore();
    }
}

/** Convenience for the browser: measure with a canvas context. */
export function makeMeasure(ctx) {
    return (text, size) => { ctx.font = bubbleFont(size); return ctx.measureText(text).width; };
}
