// NovelAI knobs and the style / negative library for SLAY Images.
//
// Pure functions over the settings object (no DOM, no SillyTavern): parameter
// tables and validation, the free-tier (Opus) cost check, and the library of
// style / negative entries with one active style per model. index.js imports
// this file lazily; node unit tests import it directly.

import { isNaiV5 } from './nai-comics.js';

// ─────────────────────────── parameter tables ───────────────────────────

export const NAI_SAMPLERS = Object.freeze({
    k_euler_ancestral: 'Euler Ancestral',
    k_euler: 'Euler',
    k_dpmpp_2m: 'DPM++ 2M',
    k_dpmpp_2m_sde: 'DPM++ 2M SDE',
    k_dpmpp_2s_ancestral: 'DPM++ 2S Ancestral',
    k_dpmpp_sde: 'DPM++ SDE',
});

export const NAI_NOISE_SCHEDULES = Object.freeze(['karras', 'native', 'exponential', 'polyexponential']);

// Size presets. The first three are the «Normal» sizes of the NovelAI site (free on Opus).
export const NAI_SIZE_PRESETS = Object.freeze([
    { value: 'auto', label: 'Из промпта (бесплатный размер)', width: 0, height: 0 },
    { value: '2:3', label: '832×1216 портрет', width: 832, height: 1216 },
    { value: '3:2', label: '1216×832 альбом', width: 1216, height: 832 },
    { value: '1:1', label: '1024×1024 квадрат', width: 1024, height: 1024 },
    { value: '1024x1536', label: '1024×1536 портрет (Anlas)', width: 1024, height: 1536 },
    { value: '1536x1024', label: '1536×1024 альбом (Anlas)', width: 1536, height: 1024 },
    { value: '1536x1536', label: '1536×1536 квадрат (Anlas)', width: 1536, height: 1536 },
    { value: 'custom', label: 'Своё (шаг 64)', width: 0, height: 0 },
]);

export const NAI_FREE_PIXELS = 1024 * 1024;   // Opus: free up to 1 MP …
export const NAI_FREE_STEPS = 28;             // … and 28 steps
export const NAI_MAX_PIXELS = 3145728;        // 3 MP, the API ceiling
export const NAI_MAX_STEPS = 50;

// key = settings key, id = the plugin body field.
export const NAI_NUMERIC_FIELDS = Object.freeze([
    { key: 'novelaiWidth', id: 'width', label: 'Ширина', min: 64, max: 2048, step: 64, def: 832 },
    { key: 'novelaiHeight', id: 'height', label: 'Высота', min: 64, max: 2048, step: 64, def: 1216 },
    { key: 'novelaiSteps', id: 'steps', label: 'Шаги', min: 1, max: NAI_MAX_STEPS, step: 1, def: 28 },
    { key: 'novelaiCfgScale', id: 'scale', label: 'CFG', min: 0, max: 10, step: 0.1, def: 5 },
    { key: 'novelaiCfgRescale', id: 'cfg_rescale', label: 'CFG rescale', min: 0, max: 1, step: 0.01, def: 0 },
    { key: 'novelaiSkipCfgAboveSigma', id: 'skip_cfg_above_sigma', label: 'Skip CFG above sigma', min: 0, max: 100, step: 0.1, def: 0 },
    { key: 'novelaiSeed', id: 'seed', label: 'Seed', min: -1, max: 4294967295, step: 1, def: -1 },
]);

export const NAI_PARAM_DEFAULTS = Object.freeze({
    novelaiAspectRatio: 'auto',
    novelaiWidth: 832,
    novelaiHeight: 1216,
    novelaiSteps: 28,
    novelaiCfgScale: 5,
    novelaiCfgRescale: 0,
    novelaiSampler: 'k_euler_ancestral',
    novelaiNoiseSchedule: 'karras',
    novelaiSkipCfgAboveSigma: 0,
    novelaiSeed: -1,
    novelaiAllowAnlas: false,
});

// Settings keys that travel with a connection profile.
export const NAI_PROFILE_KEYS = Object.freeze([
    'novelaiModel', 'novelaiAspectRatio', 'novelaiWidth', 'novelaiHeight', 'novelaiSteps', 'novelaiCfgScale',
    'novelaiCfgRescale', 'novelaiSampler', 'novelaiNoiseSchedule', 'novelaiSkipCfgAboveSigma', 'novelaiSeed',
    'novelaiAllowAnlas', 'novelaiModelFromBlock', 'naiActiveStyle', 'naiActiveNegative',
]);

function snap(n, f) {
    if (!Number.isFinite(n)) return f.def;
    let v = Math.min(f.max, Math.max(f.min, n));
    if (f.id === 'seed') return v < 0 ? -1 : Math.floor(v);
    if (f.step >= 1) v = Math.round(v / f.step) * f.step;
    return v;
}

/** Numeric knobs read from the settings, clamped to their ranges; invalid → default. */
export function normalizeNaiParams(settings = {}) {
    const out = {};
    for (const f of NAI_NUMERIC_FIELDS) {
        const raw = settings[f.key];
        out[f.id] = snap(raw === '' || raw == null ? NaN : Number(raw), f);
    }
    out.sampler = Object.hasOwn(NAI_SAMPLERS, settings.novelaiSampler) ? settings.novelaiSampler : 'k_euler_ancestral';
    out.scheduler = NAI_NOISE_SCHEDULES.includes(settings.novelaiNoiseSchedule) ? settings.novelaiNoiseSchedule : 'karras';
    out.allowAnlas = settings.novelaiAllowAnlas === true;
    return out;
}

function sizeForRatio(ratio) {
    const m = String(ratio || '1:1').match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
    if (!m) return [1024, 1024];
    const w = parseFloat(m[1]), h = parseFloat(m[2]);
    if (w > h) return [1216, 832];
    if (h > w) return [832, 1216];
    return [1024, 1024];
}

/**
 * Width/height for a request.
 *   preset 'auto' → the free size closest to the block's aspect ratio (fallbackRatio when the block has none);
 *   '2:3' | '3:2' | '1:1' → free sizes; 'WxH' presets → as written; 'custom' → novelaiWidth × novelaiHeight.
 */
export function resolveNaiSize(settings = {}, blockRatio = null, fallbackRatio = '1:1') {
    const preset = settings.novelaiAspectRatio || 'auto';
    if (preset === 'auto') return sizeForRatio(blockRatio || fallbackRatio);
    if (preset === 'custom') {
        const p = normalizeNaiParams(settings);
        return [p.width, p.height];
    }
    const found = NAI_SIZE_PRESETS.find(p => p.value === preset);
    if (found && found.width) return [found.width, found.height];
    return sizeForRatio(preset);
}

/** Free-tier check: { free, reasons: ['>1 МП', '>28 шагов'] }. */
export function naiCost({ width, height, steps }) {
    const reasons = [];
    if (Number(width) * Number(height) > NAI_FREE_PIXELS) reasons.push('>1 МП');
    if (Number(steps) > NAI_FREE_STEPS) reasons.push(`>${NAI_FREE_STEPS} шагов`);
    return { free: reasons.length === 0, reasons };
}

/** Shrink to the free tier when Anlas is not allowed (keeps the aspect, multiples of 64). */
export function enforceFreeTier(width, height, steps, allowAnlas) {
    let w = Number(width) || 832, h = Number(height) || 1216, s = Number(steps) || NAI_FREE_STEPS;
    if (allowAnlas) {
        if (w * h > NAI_MAX_PIXELS) { const k = Math.sqrt(NAI_MAX_PIXELS / (w * h)); w = Math.floor(w * k / 64) * 64; h = Math.floor(h * k / 64) * 64; }
        return { width: w, height: h, steps: Math.min(s, NAI_MAX_STEPS), clamped: false };
    }
    let clamped = false;
    if (w * h > NAI_FREE_PIXELS) {
        const k = Math.sqrt(NAI_FREE_PIXELS / (w * h));
        w = Math.floor(w * k / 64) * 64; h = Math.floor(h * k / 64) * 64;
        clamped = true;
    }
    if (s > NAI_FREE_STEPS) { s = NAI_FREE_STEPS; clamped = true; }
    return { width: w, height: h, steps: s, clamped };
}

// ─────────────────────────── library: constants and seed ───────────────────────────

// House look (rounds 1–5 of nai-style). These remain the seed and the fallback for an empty / broken library.
export const NAI_DEFAULT_STYLE_V5 = 'muted colors, dim lighting, low key, detailed skin, glossy skin';
// 4.5 house style: the «Эйден» artist mix (pairs with the aur10 vibe).
export const NAI_DEFAULT_STYLE_45 = '0.8::lart_art1 ::, 1.6::zero_q_0q::, 0.7::etceteraart::, 1.3::dang0_23 ::, 0.9::lesly_oh::, 0.5::sasha_khmel::, -2::multiple images::, intricate details, perfect anatomy, realistic, highres_quality, ultra_detail, sidelighting, volumetric_shadow, chiaroscuro, photorealistic_background, depth_of_field, masterpiece, best quality, very aesthetic, absurdres, highly detailed, sharp focus';
export const NAI_DEFAULT_NEGATIVE = 'lowres, artistic error, worst quality, bad quality, jpeg artifacts, very displeasing, watermark, logo, signature, text, speech bubble, chibi, bad anatomy, bad hands, extra digits, fewer digits, animal ears, tattoo, flat color, flat shading, plastic skin, airbrushed';

// Styles found on the NovelAI site, inactive until picked.
const FOUND_STYLES = [
    { id: 'found-f1', name: 'f1 Jotaro (фото-аниме, контраст)', model: '4.5', value: 'year 2025, fuyao (kafeiwww), 0.6::artist:fumio_(snnmfmw)::, 1.1::artist:haiki_(tegusu)::, artist:penguin_frontier, 1.4::artist:luminous_slime::, shadow skg, 1.2::zanki::, 0.8::isa (babeyxiao)::, 0.6::luoman19921 ::, kukumomo, kshbjb3bppui9om, 1::vlfdus 0 ::, masterpiece, best quality, very aesthetic, absurdres, realistic, photorealistic, anime style, anime coloring, 1.2::high contrast::, muted colors, dramatic lighting, warm lighting' },
    { id: 'found-f3', name: 'f3 Kitchen (аниме-колор, реализм)', model: '4.5', value: '1.5::anime coloring, anime, anime style::, 1.4::nekido::, 0.7::gomoro (nsfwgomoro)::, 0.6::bludwing::, 1.4::shiba yuuji::, 1.1::vlfdus 0 ::, haiki (tegusu), 1.2::alterinku::, 96yottea, 1.3::xbsx::, very aesthetic, masterpiece, best quality, highly detailed, 2::year 2025 ::, zero q 0q, 1.3::oro9 ::, 1.5::realistic, photorealistic::' },
    { id: 'found-f4', name: 'f4 Painterly (живопись)', model: '4.5', value: 'high complexity, masterpiece, best quality, amazing quality, highres, very aesthetic, painterly, detailed face, 0.7::artist:ramsrar::, 0.3::artist:m_m_pb::, 0.8::artist:denpa0304 ::, 0.6::artist:en_(e898n)::, artist:dang0_23, 0.8::artist:suzumi (ccroquette)::, 0.5::artist:zero q 0q ::, year 2025, oekaki, -2::unfinished::, 1.7::artist:suzumi_(ccroquette)::, 0.2::artist:n_sol::, absurdres, year 2026, 1.2::artist:faxparduo::, 0.8::artist:aransmind::, artist:east_100, artist:angrymiloras' },
];

export const NAI_SEED_STYLES = Object.freeze([
    { id: 'house-45', name: 'Эйден (домашний 4.5)', model: '4.5', value: NAI_DEFAULT_STYLE_45 },
    { id: 'house-v5', name: 'Домашний V5', model: 'v5', value: NAI_DEFAULT_STYLE_V5 },
    ...FOUND_STYLES,
]);
export const NAI_SEED_NEGATIVES = Object.freeze([
    { id: 'house-neg', name: 'Домашний негатив', value: NAI_DEFAULT_NEGATIVE },
]);

export const NAI_STYLE_MODELS = Object.freeze({ '4.5': 'NAI 4.5', v5: 'NAI V5', any: 'любая' });

/** '4.5' | 'v5' — the library key for a model id. */
export function naiModelKey(model) {
    return isNaiV5(model) ? 'v5' : '4.5';
}

export function newNaiId(prefix = 'nai') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function cleanEntry(e, kind) {
    if (!e || typeof e !== 'object') return null;
    const out = {
        id: String(e.id || '').trim() || newNaiId(kind === 'negatives' ? 'neg' : 'sty'),
        name: String(e.name ?? '').trim(),
        value: String(e.value ?? '').trim(),
    };
    if (kind === 'styles') out.model = ['4.5', 'v5', 'any'].includes(e.model) ? e.model : 'any';
    return out;
}

function listKey(kind) { return kind === 'negatives' ? 'naiNegatives' : 'naiStyles'; }

/**
 * Make sure the library exists in the settings (seed on first run, migrate the old
 * single-line negative into an entry «Своё»). Mutates settings; returns true when something changed.
 */
export function ensureNaiLibrary(settings) {
    let changed = false;
    const fresh = !Array.isArray(settings.naiStyles) && !Array.isArray(settings.naiNegatives);
    if (!Array.isArray(settings.naiStyles)) { settings.naiStyles = NAI_SEED_STYLES.map(s => ({ ...s })); changed = true; }
    if (!Array.isArray(settings.naiNegatives)) { settings.naiNegatives = NAI_SEED_NEGATIVES.map(s => ({ ...s })); changed = true; }
    settings.naiStyles = settings.naiStyles.map(e => cleanEntry(e, 'styles')).filter(Boolean);
    settings.naiNegatives = settings.naiNegatives.map(e => cleanEntry(e, 'negatives')).filter(Boolean);
    if (!settings.naiActiveStyle || typeof settings.naiActiveStyle !== 'object') {
        settings.naiActiveStyle = fresh ? { '4.5': 'house-45', v5: 'house-v5' } : {};
        changed = true;
    }
    if (typeof settings.naiActiveNegative !== 'string') {
        settings.naiActiveNegative = fresh ? 'house-neg' : '';
        changed = true;
    }
    // Old single-line negative → its own entry, active (the field is retired).
    const legacy = String(settings.novelaiNegativePrompt || '').trim();
    if (legacy) {
        const entry = migrateNaiNegative(settings, legacy, 'Своё');
        settings.naiActiveNegative = entry.id;
        settings.novelaiNegativePrompt = '';
        changed = true;
    }
    return changed;
}

/** Upsert a negative by name (used for the legacy field and legacy profiles). */
export function migrateNaiNegative(settings, value, name = 'Своё') {
    const list = settings.naiNegatives || (settings.naiNegatives = []);
    let entry = list.find(e => e.name === name);
    if (entry) entry.value = value;
    else { entry = { id: newNaiId('neg'), name, value }; list.push(entry); }
    return entry;
}

// ─────────────────────────── library: queries ───────────────────────────

export function naiEntries(settings, kind) {
    return Array.isArray(settings?.[listKey(kind)]) ? settings[listKey(kind)] : [];
}

export function findNaiEntry(settings, kind, id) {
    return naiEntries(settings, kind).find(e => e.id === id) || null;
}

/** Active style entry for a model (block model or settings model), or null when none / explicitly off. */
export function activeNaiStyle(settings, model) {
    const key = naiModelKey(model);
    const id = settings?.naiActiveStyle?.[key];
    if (!id) return null;
    const e = findNaiEntry(settings, 'styles', id);
    return e && (e.model === 'any' || e.model === key) ? e : null;
}

/**
 * Style tags to send for this model.
 *   active entry → its value (sent verbatim: library entries are already tags);
 *   explicitly none ('' pointer) → '';
 *   missing / broken → house constant, so wiped settings never produce «cheap» images.
 */
export function activeNaiStyleTags(settings, model) {
    const key = naiModelKey(model);
    const id = settings?.naiActiveStyle?.[key];
    if (id === '') return '';
    const e = activeNaiStyle(settings, model);
    if (e) return e.value;
    return key === 'v5' ? NAI_DEFAULT_STYLE_V5 : NAI_DEFAULT_STYLE_45;
}

export function activeNaiNegativeEntry(settings) {
    const id = settings?.naiActiveNegative;
    return id ? findNaiEntry(settings, 'negatives', id) : null;
}

/** Negative to send: active entry, '' when explicitly none, house constant when missing / broken. */
export function activeNaiNegativeText(settings) {
    if (settings?.naiActiveNegative === '') return '';
    return activeNaiNegativeEntry(settings)?.value ?? NAI_DEFAULT_NEGATIVE;
}

/** Case-insensitive search by name and text. */
export function filterNaiEntries(list, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return list.slice();
    return list.filter(e => e.name.toLowerCase().includes(q) || e.value.toLowerCase().includes(q));
}

// ─────────────────────────── library: mutations ───────────────────────────

export function addNaiEntry(settings, kind, data = {}) {
    const list = settings[listKey(kind)] || (settings[listKey(kind)] = []);
    const entry = cleanEntry({ ...data, id: data.id || newNaiId(kind === 'negatives' ? 'neg' : 'sty') }, kind);
    if (!entry.name) entry.name = kind === 'negatives' ? `Негатив ${list.length + 1}` : `Стиль ${list.length + 1}`;
    list.push(entry);
    return entry;
}

export function updateNaiEntry(settings, kind, id, patch = {}) {
    const entry = findNaiEntry(settings, kind, id);
    if (!entry) return null;
    if (patch.name !== undefined) entry.name = String(patch.name).trim();
    if (patch.value !== undefined) entry.value = String(patch.value).trim();
    if (kind === 'styles' && patch.model !== undefined) {
        entry.model = ['4.5', 'v5', 'any'].includes(patch.model) ? patch.model : 'any';
        // A style active for a model it no longer serves is dropped from that slot.
        for (const key of ['4.5', 'v5']) {
            if (settings.naiActiveStyle?.[key] === id && entry.model !== 'any' && entry.model !== key) delete settings.naiActiveStyle[key];
        }
    }
    return entry;
}

export function duplicateNaiEntry(settings, kind, id) {
    const src = findNaiEntry(settings, kind, id);
    if (!src) return null;
    const list = settings[listKey(kind)];
    const copy = { ...src, id: newNaiId(kind === 'negatives' ? 'neg' : 'sty'), name: `${src.name} (копия)` };
    list.splice(list.indexOf(src) + 1, 0, copy);
    return copy;
}

/** Remove an entry; slots pointing at it fall back to «missing» (house constant). */
export function removeNaiEntry(settings, kind, id) {
    const list = settings[listKey(kind)];
    if (!Array.isArray(list)) return false;
    const i = list.findIndex(e => e.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    if (kind === 'styles') {
        for (const key of Object.keys(settings.naiActiveStyle || {})) if (settings.naiActiveStyle[key] === id) delete settings.naiActiveStyle[key];
    } else if (settings.naiActiveNegative === id) {
        delete settings.naiActiveNegative;
    }
    return true;
}

/**
 * Activate a style. For a '4.5' / 'v5' entry the slot is the entry's model; for 'any' it is
 * forModel (the model in the settings). id '' = explicitly no style for forModel.
 */
export function setActiveNaiStyle(settings, id, forModel) {
    settings.naiActiveStyle = settings.naiActiveStyle && typeof settings.naiActiveStyle === 'object' ? settings.naiActiveStyle : {};
    const slot = naiModelKey(forModel);
    // «Без стиля» is an off switch for both models: otherwise the slot of the model that is not selected
    // in the settings keeps its style and there is no row to clear it from.
    if (id === '' || id == null) { settings.naiActiveStyle['4.5'] = ''; settings.naiActiveStyle.v5 = ''; return slot; }
    const e = findNaiEntry(settings, 'styles', id);
    if (!e) return null;
    const key = e.model === 'any' ? slot : e.model;
    settings.naiActiveStyle[key] = id;
    return key;
}

export function setActiveNaiNegative(settings, id) {
    if (id === '' || id == null) { settings.naiActiveNegative = ''; return true; }
    if (!findNaiEntry(settings, 'negatives', id)) return false;
    settings.naiActiveNegative = id;
    return true;
}

// ─────────────────────────── export / import ───────────────────────────

export function exportNaiLibrary(settings) {
    return {
        format: 'slay-nai-library',
        version: 1,
        styles: naiEntries(settings, 'styles').map(e => ({ ...e })),
        negatives: naiEntries(settings, 'negatives').map(e => ({ ...e })),
        activeStyle: { ...(settings.naiActiveStyle || {}) },
        activeNegative: settings.naiActiveNegative ?? '',
    };
}

/**
 * Merge a JSON export (object or string) into the library: same id → replaced in place,
 * new ids → appended. Also accepts a bare { "name": "tags", … } map (the found-styles file)
 * as styles for `model` (default 'any'). Returns { styles, negatives } counts.
 */
export function importNaiLibrary(settings, data, { model = 'any' } = {}) {
    let d = data;
    if (typeof d === 'string') d = JSON.parse(d);
    if (!d || typeof d !== 'object') throw new Error('не JSON-объект');
    let styles = [], negatives = [];
    if (Array.isArray(d.styles) || Array.isArray(d.negatives)) {
        styles = (d.styles || []).map(e => cleanEntry(e, 'styles')).filter(e => e && e.value);
        negatives = (d.negatives || []).map(e => cleanEntry(e, 'negatives')).filter(e => e && e.value);
    } else {
        styles = Object.entries(d)
            .filter(([, v]) => typeof v === 'string' && v.trim())
            .map(([name, value]) => cleanEntry({ id: `import-${name}`, name, value, model }, 'styles'));
    }
    if (!styles.length && !negatives.length) throw new Error('в файле нет стилей и негативов');
    const merge = (kind, incoming) => {
        const list = settings[listKey(kind)] || (settings[listKey(kind)] = []);
        for (const e of incoming) {
            const i = list.findIndex(x => x.id === e.id);
            if (i >= 0) list[i] = e; else list.push(e);
        }
    };
    merge('styles', styles);
    merge('negatives', negatives);
    return { styles: styles.length, negatives: negatives.length };
}

/**
 * A style posted by the artists catalogue (the /artists/ page opened in a frame from the library modal
 * sends window.postMessage({ type: 'slay-style', name, tags })) → { name, value }, or null when it is
 * not such a message. The caller checks the origin; this only checks the shape.
 */
export function catalogStyleFromMessage(data) {
    if (!data || typeof data !== 'object' || data.type !== 'slay-style') return null;
    const name = String(data.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const value = String(data.tags ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!name || !value) return null;
    return { name, value };
}

// ─────────────────────────── style import: posts and NovelAI images ───────────────────────────
// A pasted generation post (Telegram «📎 Генерация …» / a prompt from the NovelAI site) or the prompt inside a
// NovelAI PNG/WebP → a library style: artists + quality tags only, the scene and characters are cut off.

// Tags that start the "what is in the picture" part of a prompt.
const NAI_CONTENT_TAG = /^(\d+\+?\s*(boy|girl|other|futa)s?|solo|solo focus|male focus|female focus|multiple (boys|girls)|couple|duo|trio|group|yaoi|yuri|hetero|nsfw|sfw|explicit|questionable|no humans|sex|sex from behind|anal|vaginal|oral|kiss|kissing|hug|hugging)$/i;

/** Split on commas that are not inside a `1.2::a, b::` weight group. */
export function splitNaiTags(text) {
    const out = [];
    let cur = '', depth = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
        if (s[i] === ':' && s[i + 1] === ':') {
            depth = depth ? 0 : 1; // NovelAI weight groups do not nest: `::` alternates open / close
            cur += '::'; i++; continue;
        }
        if (s[i] === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += s[i];
    }
    out.push(cur);
    return out.map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Bare tag text: weight prefix/suffix, brackets and case removed. */
function naiTagCore(tag) {
    return String(tag).replace(/^-?\d*\.?\d+\s*::/, '').replace(/::\s*$/, '').replace(/[{}[\]()]/g, '').trim().toLowerCase();
}

const isContentTag = (tag) => NAI_CONTENT_TAG.test(naiTagCore(tag));

/**
 * Style part of a prompt. Several paragraphs → the paragraphs before the first one that has a content tag
 * (1boy, solo, yaoi, …). One paragraph (or content from the very first line) → the tags before the first content tag.
 */
export function extractNaiStyle(prompt) {
    const paras = String(prompt || '').replace(/\r/g, '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    if (!paras.length) return '';
    const firstContent = paras.findIndex(p => splitNaiTags(p).some(isContentTag));
    let tags;
    if (firstContent > 0) tags = paras.slice(0, firstContent).flatMap(splitNaiTags);
    else {
        const all = paras.flatMap(splitNaiTags);
        const cut = all.findIndex(isContentTag);
        tags = cut === -1 ? all : all.slice(0, cut);
    }
    return tags.join(', ');
}

function naiModelFromText(s) {
    const t = String(s || '');
    if (/diffusion\s*v?\s*5|nai-diffusion-5/i.test(t)) return 'v5';
    if (/v?\s*4\.5|nai-diffusion-4-5/i.test(t)) return '4.5';
    return null;
}

/**
 * Parse a pasted post / prompt into { name, value, model, prompt }.
 * Understands «📎 Генерация #N», «Автор:», «Модель:», «Промпт:», «Персонажи:» lines; plain prompts work too.
 */
export function parseNaiStylePost(text) {
    const src = String(text || '').replace(/\r/g, '').normalize('NFKC');
    const line = (re) => (src.match(re)?.[1] || '').trim();
    const author = line(/Автор\s*:\s*([^\n]+)/i).replace(/[\[\]■□▪▫\s]+/g, ' ').trim();
    const chars = line(/Персонажи\s*:\s*\n?\s*([^\n]+)/i);
    const num = line(/Генерация\s*#\s*(\d+)/i);
    const model = naiModelFromText(line(/Модель\s*:\s*([^\n]+)/i));
    let prompt = src;
    const p = src.search(/Промпт\s*:/i);
    if (p !== -1) prompt = src.slice(p).replace(/^Промпт\s*:\s*/i, '');
    prompt = prompt.split(/\n\s*(Персонажи|Негатив|Undesired content|UC)\s*:/i)[0];
    prompt = prompt.split('\n').filter(l => !/^\s*(📎|👤|🧠|🖼|🎲)/u.test(l)).join('\n');
    const value = extractNaiStyle(prompt);
    const who = author || chars.split(',')[0].trim();
    const name = [who, num && `#${num}`].filter(Boolean).join(' ') || '';
    return { name, value, model, prompt: prompt.trim() };
}

/** Prompt + model from NovelAI image metadata (PNG tEXt/iTXt, or EXIF/JSON anywhere in a WebP/JPEG). */
export function parseNaiImageMeta(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const utf8 = new TextDecoder('utf-8', { fatal: false });
    const texts = {};
    if (u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
        let off = 8;
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        while (off + 8 <= u8.length) {
            const len = dv.getUint32(off), type = String.fromCharCode(...u8.subarray(off + 4, off + 8));
            const data = u8.subarray(off + 8, off + 8 + len);
            if (type === 'tEXt' || type === 'iTXt') {
                const z = data.indexOf(0);
                if (z > 0) {
                    const key = String.fromCharCode(...data.subarray(0, z));
                    let rest = data.subarray(z + 1);
                    if (type === 'iTXt') { // compression flag, method, language\0, translated keyword\0
                        if (rest[0] !== 0) { off += 12 + len; continue; }
                        rest = rest.subarray(2);
                        for (let k = 0; k < 2; k++) { const q = rest.indexOf(0); rest = rest.subarray(q + 1); }
                    }
                    texts[key] = utf8.decode(rest);
                }
            }
            if (type === 'IEND') break;
            off += 12 + len;
        }
    }
    let prompt = texts.Description || '';
    let model = naiModelFromText(texts.Source || texts.Software || '');
    const pool = [texts.Comment || '', utf8.decode(u8), new TextDecoder('utf-16le').decode(u8), new TextDecoder('utf-16be').decode(u8)];
    for (const s of pool) {
        if (prompt && model) break;
        const m = s.match(/"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (!prompt && m) { try { prompt = JSON.parse(`"${m[1]}"`); } catch (_) { /* keep looking */ } }
        if (!model) model = naiModelFromText((s.match(/NovelAI Diffusion V[\d.]+|nai-diffusion-[\d-]+/i) || [''])[0]);
    }
    return prompt ? { prompt, model } : null;
}
