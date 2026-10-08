// Pure request building for NovelAI V4 / V4.5 image generation.
// No SillyTavern imports here so it can be unit-tested with plain node.

export const MODEL_KEYS = {
    'nai-diffusion-5-full': 'v5full',   // key in .naiv4vibe files is a guess; V5 vibes untested
    'nai-diffusion-4-5-full': 'v4-5full',
    'nai-diffusion-4-5-curated': 'v4-5curated',
    'nai-diffusion-4-full': 'v4full',
    'nai-diffusion-4-curated-preview': 'v4curated',
};

export const MAX_CHARACTERS = 6;   // the NovelAI web UI allows six character slots
export const MAX_STEPS = 28;       // last free step count on the Opus tier
export const MAX_FREE_PIXELS = 1024 * 1024;

// Character positions are a 5x5 grid in the web UI: cell centers at 0.1, 0.3, 0.5, 0.7, 0.9.
const GRID = [0.1, 0.3, 0.5, 0.7, 0.9];

export function snapToGrid(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0.5;
    const clamped = Math.min(1, Math.max(0, n));
    return GRID.reduce((best, g) => (Math.abs(g - clamped) < Math.abs(best - clamped) ? g : best), 0.5);
}

function hasCenter(c) {
    return c && c.center && Number.isFinite(Number(c.center.x)) && Number.isFinite(Number(c.center.y));
}

// What the NovelAI site adds with "Add Quality Tags" on; "no text" only when no lettering is wanted.
export function withQuality(prompt) {
    const textAt = prompt.search(/\bText:/);
    const body = (textAt >= 0 ? prompt.slice(0, textAt) : prompt).trim().replace(/,\s*$/, '');
    const tail = textAt >= 0 ? ' ' + prompt.slice(textAt).trim() : '';
    const wantsText = textAt >= 0 || /speech bubble|comic|text/i.test(body);
    return `${body}, very aesthetic, masterpiece${wantsText ? '' : ', no text'}${tail}`;
}

// Normalise the characters array from the request body: trims, caps the count,
// snaps centers to the grid. Characters without a center get the web UI default (0.5, 0.5).
export function normalizeCharacters(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const c of list) {
        if (!c || typeof c !== 'object') continue;
        const prompt = String(c.prompt || '').trim();
        if (!prompt) continue;
        const uc = String(c.uc || c.negative_prompt || '').trim();
        const center = hasCenter(c)
            ? { x: snapToGrid(c.center.x), y: snapToGrid(c.center.y) }
            : { x: 0.5, y: 0.5 };
        out.push({ prompt, uc, center, hasCenter: hasCenter(c) });
        if (out.length >= MAX_CHARACTERS) break;
    }
    return out;
}

// Free-tier guard: Opus generations are free up to 1 MP and 28 steps.
export function clampSize(width, height) {
    let w = Math.max(64, Math.round(Number(width) || 832));
    let h = Math.max(64, Math.round(Number(height) || 1216));
    if (w * h > MAX_FREE_PIXELS) {
        const k = Math.sqrt(MAX_FREE_PIXELS / (w * h));
        w = Math.floor(w * k / 64) * 64;
        h = Math.floor(h * k / 64) * 64;
    }
    return [w, h];
}

/**
 * Build the body for POST https://image.novelai.net/ai/generate-image.
 *
 * @param {object} b request body from the extension:
 *   prompt | base      base caption (scene, counts, style tags)
 *   characters         [{ prompt, uc, center: { x, y } }] up to 6; center optional
 *   negative_prompt    base negative
 *   use_coords         optional override; default: true when any character carries a center
 *   model, width, height, scale, sampler, steps, seed, scheduler, quality
 * @param {Array<{encoding:string, strength:number, ie:number}>} refs vibe encodings
 */
export function buildGenerateRequest(b = {}, refs = []) {
    const model = b.model || 'nai-diffusion-5-full';
    const rawPrompt = String(b.prompt ?? b.base ?? '');
    const prompt = b.quality === false ? rawPrompt : withQuality(rawPrompt);
    const negative = String(b.negative_prompt || '');
    const characters = normalizeCharacters(b.characters);
    const useCoords = typeof b.use_coords === 'boolean' ? b.use_coords : characters.some(c => c.hasCenter);
    const [width, height] = clampSize(b.width, b.height);

    const charCaptions = characters.map(c => ({ char_caption: c.prompt, centers: [c.center] }));
    const charNegCaptions = characters.map(c => ({ char_caption: c.uc, centers: [c.center] }));

    const parameters = {
        params_version: 3,
        width,
        height,
        scale: Number.isFinite(Number(b.scale)) ? Number(b.scale) : 5,
        sampler: b.sampler || 'k_euler_ancestral',
        steps: Math.min(Number(b.steps) || MAX_STEPS, MAX_STEPS),
        n_samples: 1,
        seed: Number(b.seed) >= 0 ? Math.floor(Number(b.seed)) : Math.floor(Math.random() * 4294967295),
        noise_schedule: b.scheduler || 'karras',
        ucPreset: 0,
        qualityToggle: b.quality !== false,
        prefer_brownian: true,
        dynamic_thresholding: false,
        cfg_rescale: Number.isFinite(Number(b.cfg_rescale)) ? Number(b.cfg_rescale) : 0,
        legacy: false,
        legacy_v3_extend: false,
        legacy_uc: false,
        sm: false,
        sm_dyn: false,
        add_original_image: false,
        controlnet_strength: 1,
        deliberate_euler_ancestral_bug: false,
        use_coords: useCoords,
        characterPrompts: characters.map(c => ({ prompt: c.prompt, uc: c.uc, center: c.center, enabled: true })),
        negative_prompt: negative,
        v4_prompt: {
            caption: { base_caption: prompt, char_captions: charCaptions },
            use_coords: useCoords,
            use_order: true,
            legacy_uc: false,
        },
        v4_negative_prompt: {
            caption: { base_caption: negative, char_captions: charNegCaptions },
            use_coords: useCoords,
            use_order: false,
            legacy_uc: false,
        },
        reference_image_multiple: refs.map(r => r.encoding),
        reference_strength_multiple: refs.map(r => r.strength),
        reference_information_extracted_multiple: refs.map(r => r.ie),
        normalize_reference_strength_multiple: true,
    };
    return { action: 'generate', input: prompt, model, parameters };
}
