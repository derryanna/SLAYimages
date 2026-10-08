// Unit tests for nai-comics.js: instruction parsing, prompt composition, bubble detection and layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseNaiInstruction, naiStyleTags, composeNaiNegative, composeNaiPrompt, buildNaiPluginBody,
    findBubbleRegions, wrapText, fitText, layoutBubbles, renderBubbles, decodeEntities, BLANK_BUBBLE_NEGATIVES,
    normalizeNaiModel, resolveNaiLook, NAI_MODEL_45, NAI_MODEL_V5, NAI_HOUSE_VIBES, NAI_V5_SUFFIX,
} from '../nai-comics.js';

// Monospace-ish stub: every character is 0.55 em wide.
const measure = (text, size) => text.length * size * 0.55;

// ───────── instruction parsing ─────────

test('structured instruction is normalised', () => {
    const d = {
        base: '1boy, 1girl, comic, 4 panels, bedroom, warm lighting',
        characters: [
            { name: 'Kakashi', prompt: 'boy, silver hair, grey eyes', uc: 'mask, headband', center: { x: 0.3, y: 0.5 } },
            { name: 'Aurora', prompt: 'girl, blonde hair, green eyes', center: { x: '0.7', y: '0.5' } },
            { name: 'Nobody', prompt: '' },
        ],
        bubbles: [{ speaker: 'Kakashi', text: 'Ты отсюда никуда не уйдешь...' }, { speaker: 'Aurora', text: '' }],
        aspect_ratio: '2:3',
    };
    const i = parseNaiInstruction(d);
    assert.equal(i.structured, true);
    assert.equal(i.base, d.base);
    assert.equal(i.comic, true);
    assert.equal(i.aspectRatio, '2:3');
    assert.equal(i.characters.length, 2);
    assert.deepEqual(i.characters[1].center, { x: 0.7, y: 0.5 });
    assert.equal(i.characters[0].uc, 'mask, headband');
    assert.deepEqual(i.bubbles, [{ speaker: 'Kakashi', text: 'Ты отсюда никуда не уйдешь...' }]);
});

test('plain prompt stays plain; invalid ratio dropped', () => {
    const i = parseNaiInstruction({ prompt: '1girl, solo, smile', aspect_ratio: '7:1' });
    assert.equal(i.structured, false);
    assert.equal(i.base, '1girl, solo, smile');
    assert.deepEqual(i.characters, []);
    assert.deepEqual(i.bubbles, []);
    assert.equal(i.aspectRatio, null);
    assert.equal(i.comic, false);
});

test('old naicom "|" prompt splits into characters and Russian lines become bubbles', () => {
    const prompt = '1 boy, 1 girl, comic, 3 panels. Hospital corridor. Elena has a speech bubble saying «Мы у тебя в долгу», with the tail pointing to Elena. '
        + '| boy Kakashi. Handsome adult male, messy silver hair, grey eyes. Text: Я подожду '
        + '| girl Aurora. Long wavy blonde hair, green eyes.';
    const i = parseNaiInstruction({ prompt });
    assert.equal(i.structured, false);
    assert.equal(i.comic, true);
    assert.ok(!/[Ѐ-ӿ]/.test(i.base), 'no Cyrillic in base');
    assert.ok(i.base.includes('Elena has an empty speech bubble'));
    assert.equal(i.characters.length, 2);
    assert.equal(i.characters[0].name, 'Kakashi');
    assert.ok(!/Text:/.test(i.characters[0].prompt));
    assert.ok(!/[Ѐ-ӿ]/.test(i.characters[0].prompt));
    assert.deepEqual(i.bubbles, [{ speaker: 'Elena', text: 'Мы у тебя в долгу' }, { speaker: 'Kakashi', text: 'Я подожду' }]);
});

test('numeric HTML entities in the instruction are decoded', () => {
    assert.equal(decodeEntities('&#1040;&#1085;&#1085;&#1072; &quot;x&quot;'), 'Анна "x"');
    const i = parseNaiInstruction({ base: 'x', bubbles: [{ speaker: 'Kakashi', text: '&#1055;&#1088;&#1080;&#1074;&#1077;&#1090;' }] });
    assert.equal(i.bubbles[0].text, 'Привет');
});

test('JSON string input is accepted', () => {
    const i = parseNaiInstruction('{"base":"1girl","bubbles":[{"speaker":"A","text":"Да"}]}');
    assert.equal(i.base, '1girl');
    assert.equal(i.bubbles.length, 1);
});

// ───────── prompt composition ─────────

test('naiStyleTags keeps tags and drops the Avoid list and labels', () => {
    assert.equal(naiStyleTags('[STYLE: artist:wlop, artist:guweiz, painterly, warm lighting. Avoid: rain streaks, speech bubbles, manga panels]'),
        'artist:wlop, artist:guweiz, painterly, warm lighting');
    assert.equal(naiStyleTags(''), '');
    assert.equal(naiStyleTags('Style: oil painting (medium); detailed skin'), 'oil painting (medium), detailed skin');
});

test('composeNaiNegative strips anti-comic tags for comics and adds no-lettering tags for bubbles', () => {
    const neg = 'lowres, artistic error, multiple views, split screen, looking at viewer, watermark';
    const plain = parseNaiInstruction({ prompt: '1girl' });
    assert.equal(composeNaiNegative(neg, plain), neg);
    const comic = parseNaiInstruction({ base: '1girl, comic', bubbles: [{ speaker: 'A', text: 'Привет' }] });
    const out = composeNaiNegative(neg, comic);
    assert.ok(!out.includes('multiple views'));
    assert.ok(!out.includes('split screen'));
    assert.ok(out.includes('looking at viewer'), 'unrelated tags stay');
    for (const t of BLANK_BUBBLE_NEGATIVES) assert.ok(out.includes(t), t);
    assert.equal(out.split(', ').length, new Set(out.split(', ')).size, 'no duplicates');
});

test('composeNaiPrompt puts style first and asks for blank bubbles', () => {
    const i = parseNaiInstruction({ base: '1boy, 1girl, comic', bubbles: [{ speaker: 'A', text: 'Ага' }] });
    assert.equal(composeNaiPrompt(i, 'artist:wlop, painterly'), 'artist:wlop, painterly, 1boy, 1girl, comic, speech bubble, blank speech bubble');
    const i2 = parseNaiInstruction({ base: '1girl, speech bubble', bubbles: [{ speaker: 'A', text: 'Ага' }] });
    assert.equal(composeNaiPrompt(i2, ''), '1girl, speech bubble');
});

test('buildNaiPluginBody carries characters with centers only when given', () => {
    const i = parseNaiInstruction({
        base: '1boy, 1girl, bedroom',
        characters: [{ name: 'K', prompt: 'boy, silver hair', uc: 'mask', center: { x: 0.3, y: 0.5 } }, { name: 'A', prompt: 'girl, blonde hair' }],
    });
    const body = buildNaiPluginBody(i, { styleTags: 'artist:wlop', negative: 'lowres', model: 'nai-diffusion-4-5-full', width: 832, height: 1216, quality: true, vibes: [] });
    assert.equal(body.prompt, 'artist:wlop, 1boy, 1girl, bedroom');
    assert.deepEqual(body.characters, [{ prompt: 'boy, silver hair', uc: 'mask', center: { x: 0.3, y: 0.5 } }, { prompt: 'girl, blonde hair', uc: '' }]);
    assert.equal(body.negative_prompt, 'lowres');
    assert.equal(body.width, 832);
    assert.equal(body.steps, 28);
    assert.equal(body.quality, true);
});

// ───────── text fitting ─────────

test('wrapText wraps by words and breaks overlong words', () => {
    const m = (t) => t.length * 10;
    assert.deepEqual(wrapText('Ты отсюда никуда не уйдешь', 100, m), ['Ты отсюда', 'никуда не', 'уйдешь']);
    assert.deepEqual(wrapText('абвгдежзиклмн', 50, m), ['абвгд', 'ежзик', 'лмн']);
    assert.deepEqual(wrapText('', 50, m), []);
});

test('fitText picks the largest size that fits, or null', () => {
    const fit = fitText('Глубже вбивай, шкаф...', 120, 60, measure, { minSize: 10, maxSize: 40 });
    assert.ok(fit);
    assert.ok(fit.fontSize >= 10 && fit.fontSize <= 40);
    for (const l of fit.lines) assert.ok(measure(l, fit.fontSize) <= 120);
    assert.ok(fit.lines.length * fit.fontSize * fit.lineHeight <= 60);
    assert.equal(fitText('очень длинная строка которая не влезет никак', 20, 10, measure, { minSize: 10, maxSize: 40 }), null);
});

// ───────── bubble detection ─────────

function makeImage(W, H, bg = [120, 90, 70]) {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255; }
    const set = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const p = (y * W + x) * 4; data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2]; data[p + 3] = 255; };
    return { width: W, height: H, data, set };
}

function ellipse(img, cx, cy, rx, ry, c) {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        if (((x - cx) ** 2) / (rx * rx) + ((y - cy) ** 2) / (ry * ry) <= 1) img.set(x, y, c);
    }
}

function outlinedBubble(img, cx, cy, rx, ry) {
    ellipse(img, cx, cy, rx + 2, ry + 2, [20, 20, 20]);   // dark outline
    ellipse(img, cx, cy, rx, ry, [250, 250, 250]);          // white interior
}

test('findBubbleRegions finds outlined white bubbles, fills lettering holes, rejects walls and thin lines', () => {
    const img = makeImage(300, 440);
    outlinedBubble(img, 60, 50, 42, 26);      // bubble A, top-left
    outlinedBubble(img, 240, 60, 40, 24);     // bubble B, top-right
    // "lettering" inside A: dark dashes
    for (let k = 0; k < 4; k++) for (let x = 30; x < 90; x += 2) img.set(x, 40 + k * 6, [10, 10, 10]);
    // a big white wall without outline (bottom), should be rejected by area or missing outline
    for (let y = 300; y < 440; y++) for (let x = 0; x < 300; x++) img.set(x, y, [245, 245, 245]);
    // a thin white gutter line
    for (let y = 100; y < 290; y++) for (let x = 148; x < 152; x++) img.set(x, y, [255, 255, 255]);
    const regions = findBubbleRegions(img);
    assert.equal(regions.length, 2, JSON.stringify(regions.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h, fill: r.fill, edgeDark: r.edgeDark }))));
    const [a, b] = regions;  // reading order: A (y≈24) then B (y≈36)
    assert.ok(Math.abs(a.cx * 300 - 60) < 3 && Math.abs(a.cy * 440 - 50) < 3);
    assert.ok(Math.abs(b.cx * 300 - 240) < 3);
    assert.ok(a.fill > 0.7, 'holes filled: fill ' + a.fill);
    // the mask covers the lettering pixels
    const m = a.mask;
    const bit = (x, y) => m.bits[(y - m.y0) * m.w + (x - m.x0)];
    assert.equal(bit(60, 46), 1);
    assert.equal(bit(60, 50), 1);
});

test('findBubbleRegions ignores a white shirt-like blob with ragged edges and no outline', () => {
    const img = makeImage(200, 200);
    ellipse(img, 100, 120, 50, 60, [240, 240, 240]);  // no outline
    assert.equal(findBubbleRegions(img).length, 0);
});

// ───────── layout ─────────

const W = 832, H = 1216;
const regionAt = (cx, cy, w, h) => ({ x: cx - w / 2, y: cy - h / 2, w, h, cx, cy, areaFrac: w * h, fill: 0.9, edgeDark: 0.5, mask: { x0: 0, y0: 0, w: 1, h: 1, bits: new Uint8Array([1]) } });

test('layoutBubbles assigns detected bubbles to speakers by proximity and fits the text', () => {
    const regions = [regionAt(0.2, 0.12, 0.28, 0.14), regionAt(0.82, 0.14, 0.26, 0.13)];
    const characters = [{ name: 'Kakashi', center: { x: 0.3, y: 0.5 } }, { name: 'Aurora', center: { x: 0.7, y: 0.5 } }];
    const bubbles = [{ speaker: 'Aurora', text: 'Глубже вбивай, шкаф...' }, { speaker: 'Kakashi', text: 'Ты отсюда никуда не уйдешь...' }];
    const pl = layoutBubbles({ bubbles, characters, regions, width: W, height: H, measure });
    assert.equal(pl.length, 2);
    assert.equal(pl[0].kind, 'region');
    assert.equal(pl[0].region, regions[1], 'Aurora (right) gets the right bubble');
    assert.equal(pl[1].kind, 'region');
    assert.equal(pl[1].region, regions[0]);
    for (const p of pl) {
        assert.ok(p.fontSize >= 10);
        assert.ok(p.box.x >= p.region.x * W && p.box.x + p.box.w <= (p.region.x + p.region.w) * W + 0.01);
        for (const l of p.lines) assert.ok(measure(l, p.fontSize) <= p.box.w + 0.01);
    }
});

test('layoutBubbles falls back to a drawn bubble near the speaker with a tail, inside the image, no overlap', () => {
    const characters = [{ name: 'Kakashi', center: { x: 0.3, y: 0.5 } }, { name: 'Aurora', center: { x: 0.3, y: 0.5 } }];
    const bubbles = [{ speaker: 'Kakashi', text: 'Ты отсюда никуда не уйдешь...' }, { speaker: 'Aurora', text: 'Глубже вбивай, шкаф...' }];
    const pl = layoutBubbles({ bubbles, characters, regions: [], width: W, height: H, measure });
    assert.equal(pl.length, 2);
    for (const p of pl) {
        assert.equal(p.kind, 'drawn');
        const s = p.shape;
        assert.ok(s.cx - s.rx >= 0 && s.cx + s.rx <= W, 'inside horizontally');
        assert.ok(s.cy - s.ry >= 0 && s.cy + s.ry <= H, 'inside vertically');
        assert.ok(s.tail, 'tail present');
        assert.ok(s.cx < W / 2, 'bubble shifted to the speaker side');
        assert.ok(s.cy < H * 0.5, 'bubble above the speaker');
        assert.ok(p.lines.length >= 1 && p.lines.length <= 4);
    }
    const a = pl[0].shape, b = pl[1].shape;
    const overlap = !(a.cx + a.rx <= b.cx - b.rx || b.cx + b.rx <= a.cx - a.rx || a.cy + a.ry <= b.cy - b.ry || b.cy + b.ry <= a.cy - a.ry);
    assert.equal(overlap, false, 'drawn bubbles do not overlap');
});

test('layoutBubbles without speaker centers uses reading order and index-based corners', () => {
    const regions = [regionAt(0.2, 0.12, 0.28, 0.14)];
    const pl = layoutBubbles({ bubbles: [{ speaker: 'X', text: 'Да' }, { speaker: 'Y', text: 'Нет' }], characters: [], regions, width: W, height: H, measure });
    assert.equal(pl[0].kind, 'region');
    assert.equal(pl[1].kind, 'drawn');
    assert.ok(pl[1].shape.cx > W / 2, 'second fallback bubble goes to the right');
});

test('a region too small for the text is skipped in favour of a drawn bubble', () => {
    const regions = [regionAt(0.5, 0.1, 0.07, 0.05)];
    const pl = layoutBubbles({ bubbles: [{ speaker: 'X', text: 'Очень длинная реплика которая никак не поместится в крошечный пузырь' }], characters: [], regions, width: W, height: H, measure });
    assert.equal(pl[0].kind, 'drawn');
});

// ───────── rendering (stub context) ─────────

test('renderBubbles draws every line of text and a shape per drawn bubble', () => {
    const calls = [];
    const ctx = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, args]); } });
    const pl = layoutBubbles({
        bubbles: [{ speaker: 'K', text: 'Ты отсюда никуда не уйдешь' }], characters: [{ name: 'K', center: { x: 0.3, y: 0.5 } }],
        regions: [], width: W, height: H, measure,
    });
    renderBubbles(ctx, pl, { width: W, height: H });
    const texts = calls.filter(c => c[0] === 'fillText').map(c => c[1][0]);
    assert.deepEqual(texts, pl[0].lines);
    assert.ok(calls.some(c => c[0] === 'ellipse'));
    assert.ok(calls.some(c => c[0] === 'stroke'));
});

test('findBubbleRegions rejects a pale beige wall framed by dark lines (not paper-white)', () => {
    const img = makeImage(300, 440);
    ellipse(img, 150, 120, 62, 72, [20, 20, 20]);
    ellipse(img, 150, 120, 60, 70, [236, 230, 222]);   // beige, passes the loose white test
    assert.equal(findBubbleRegions(img).length, 0);
});

// ───────── per-image model switch (round 3) ─────────

test('instruction "model" / "look" is normalised; absent or unknown → null', () => {
    assert.equal(parseNaiInstruction({ base: '1girl', model: '4.5' }).model, NAI_MODEL_45);
    assert.equal(parseNaiInstruction({ base: '1girl', model: 'V5' }).model, NAI_MODEL_V5);
    assert.equal(parseNaiInstruction({ base: '1girl', model: 'nai-diffusion-5-full' }).model, NAI_MODEL_V5);
    assert.equal(parseNaiInstruction({ base: '1girl', look: 'hot' }).model, NAI_MODEL_45);
    assert.equal(parseNaiInstruction({ base: '1girl', look: 'clean' }).model, NAI_MODEL_V5);
    assert.equal(parseNaiInstruction({ base: '1girl' }).model, null);
    assert.equal(parseNaiInstruction({ base: '1girl', model: 'dall-e' }).model, null);
    assert.equal(parseNaiInstruction({ prompt: '1girl' }).model, null, 'plain prompts have no model');
    assert.equal(normalizeNaiModel(undefined), null);
    assert.equal(parseNaiInstruction('{"base":"1boy, 1girl","model":"v5"}').model, NAI_MODEL_V5, 'JSON string input');
});

test('nsfw is read from the base', () => {
    assert.equal(parseNaiInstruction({ base: 'nsfw, 1boy, 1girl, on bed' }).nsfw, true);
    assert.equal(parseNaiInstruction({ base: '1boy, 1girl, kitchen, morning' }).nsfw, false);
});

test('resolveNaiLook: UI model wins by default; with blockModel the block model beats it', () => {
    const uiWins = resolveNaiLook(parseNaiInstruction({ base: '1girl', model: '4.5' }), { settingsModel: NAI_MODEL_V5 });
    assert.equal(uiWins.model, NAI_MODEL_V5);
    assert.equal(uiWins.fromBlock, false);
    const fromBlock = resolveNaiLook(parseNaiInstruction({ base: '1girl', model: '4.5' }), { settingsModel: NAI_MODEL_V5, blockModel: true });
    assert.equal(fromBlock.model, NAI_MODEL_45);
    assert.equal(fromBlock.fromBlock, true);
    const fromUi = resolveNaiLook(parseNaiInstruction({ base: '1girl' }), { settingsModel: NAI_MODEL_45 });
    assert.equal(fromUi.model, NAI_MODEL_45);
    assert.equal(fromUi.fromBlock, false);
    assert.equal(resolveNaiLook(parseNaiInstruction({ base: '1girl' }), {}).model, NAI_MODEL_V5, 'default model');
});

test('resolveNaiLook: V5 turns vibes off even when ticked, and adds the V5 phrase', () => {
    const ui = [{ name: 'violet', strength: 0.6, enabled: true }];
    const look = resolveNaiLook(parseNaiInstruction({ base: 'nsfw, 1boy, 1girl, on bed', model: 'v5' }), { settingsModel: NAI_MODEL_45, uiVibes: ui, blockModel: true });
    assert.equal(look.model, NAI_MODEL_V5);
    assert.equal(look.v5, true);
    assert.deepEqual(look.vibes, []);
    assert.equal(look.styleSuffix, NAI_V5_SUFFIX);
    assert.deepEqual(look.missing, []);
});

test('resolveNaiLook: 4.5 uses the ticked vibes, or the house set when none is ticked', () => {
    const ui = [{ name: 'favourite', strength: 0.4 }];
    const ticked = resolveNaiLook(parseNaiInstruction({ base: '1boy, 1girl', model: '4.5' }), { uiVibes: ui });
    assert.deepEqual(ticked.vibes, [{ name: 'favourite', strength: 0.4 }]);
    assert.equal(ticked.styleSuffix, '');
    const day = resolveNaiLook(parseNaiInstruction({ base: '1boy, 1girl, kitchen, morning', model: '4.5' }), {});
    assert.deepEqual(day.vibes, NAI_HOUSE_VIBES.day);
    const night = resolveNaiLook(parseNaiInstruction({ base: 'nsfw, 1boy, 1girl, on bed', model: '4.5' }), {});
    assert.deepEqual(night.vibes, NAI_HOUSE_VIBES.night);
    assert.deepEqual(NAI_HOUSE_VIBES.day, [{ name: 'aur10', strength: 0.6 }]);
    assert.deepEqual(NAI_HOUSE_VIBES.night, [{ name: 'aur10', strength: 0.6 }]);
    // the UI model alone (no block model) also gets the house set on 4.5 when nothing is ticked
    const uiOnly = resolveNaiLook(parseNaiInstruction({ base: '1boy, 1girl' }), { settingsModel: NAI_MODEL_45 });
    assert.deepEqual(uiOnly.vibes, NAI_HOUSE_VIBES.day);
});

test('resolveNaiLook: house vibes are limited to what the server has, the rest is reported', () => {
    const look = resolveNaiLook(parseNaiInstruction({ base: '1boy, 1girl', model: '4.5' }), { serverVibes: ['aur10', 'favourite'] });
    assert.deepEqual(look.vibes, [{ name: 'aur10', strength: 0.6 }]);
    assert.deepEqual(look.missing, []);
    const absent = resolveNaiLook(parseNaiInstruction({ base: '1boy, 1girl', model: '4.5' }), { serverVibes: ['violet'] });
    assert.deepEqual(absent.missing, ['aur10']);
    const none = resolveNaiLook(parseNaiInstruction({ base: '1boy, 1girl', model: '4.5' }), { serverVibes: [] });
    assert.deepEqual(none.vibes, []);
    assert.deepEqual(none.missing, ['aur10']);
});

test('dedupe keeps NovelAI weight groups whole and compares whole tokens', () => {
    const i = parseNaiInstruction({ base: 'anime, 1girl, realistic' });
    const style = '1.5::anime coloring, anime, anime style::, 1.4::nekido::, 1.5::realistic, photorealistic::';
    assert.equal(composeNaiPrompt(i, style), '1.5::anime coloring, anime, anime style::, 1.4::nekido::, 1.5::realistic, photorealistic::, anime, 1girl, realistic');
    assert.equal(composeNaiPrompt(parseNaiInstruction({ base: '1girl, 1girl, smile' }), '-2::multiple images::, -2::multiple images::'), '-2::multiple images::, 1girl, smile');
    assert.equal(composeNaiNegative('lowres, 1.2::bad hands, extra digits::, lowres', { negative: 'extra digits' }), 'lowres, 1.2::bad hands, extra digits::, extra digits');
});

test('buildNaiPluginBody carries the knobs only when set', () => {
    const i = parseNaiInstruction({ base: '1girl' });
    const plain = buildNaiPluginBody(i, { styleTags: '', negative: '', model: NAI_MODEL_45 });
    assert.equal(plain.cfg_rescale, undefined); assert.equal(plain.seed, undefined);
    assert.equal(plain.skip_cfg_above_sigma, undefined); assert.equal(plain.allow_anlas, undefined);
    const full = buildNaiPluginBody(i, {
        styleTags: '', negative: '', model: NAI_MODEL_45, sampler: 'k_dpmpp_2m', scheduler: 'native',
        steps: 30, scale: 6.5, cfgRescale: 0.2, seed: 123.9, skipCfgAboveSigma: 19, allowAnlas: true,
    });
    assert.equal(full.sampler, 'k_dpmpp_2m'); assert.equal(full.scheduler, 'native');
    assert.equal(full.steps, 30); assert.equal(full.scale, 6.5);
    assert.equal(full.cfg_rescale, 0.2); assert.equal(full.seed, 123); assert.equal(full.skip_cfg_above_sigma, 19); assert.equal(full.allow_anlas, true);
    assert.equal(buildNaiPluginBody(i, { model: NAI_MODEL_45, seed: -1, skipCfgAboveSigma: 0 }).seed, undefined, 'seed -1 = random');
});

test('buildNaiPluginBody appends the V5 phrase after the scene, once', () => {
    const i = parseNaiInstruction({ base: '1boy, solo, upper body, night, lonely mood, soft painterly shading', model: 'v5' });
    const look = resolveNaiLook(i, { settingsModel: NAI_MODEL_V5 });
    const body = buildNaiPluginBody(i, { styleTags: 'muted colors', styleSuffix: look.styleSuffix, negative: 'lowres', model: look.model, vibes: look.vibes });
    assert.equal(body.model, NAI_MODEL_V5);
    assert.deepEqual(body.vibes, []);
    assert.equal(body.prompt, 'muted colors, 1boy, solo, upper body, night, lonely mood, soft painterly shading, moody low key light, faces close and large in frame');
    const i45 = parseNaiInstruction({ base: '1boy, 1girl, kitchen', model: '4.5' });
    const look45 = resolveNaiLook(i45, {});
    const body45 = buildNaiPluginBody(i45, { styleTags: 'muted colors', styleSuffix: look45.styleSuffix, negative: 'lowres', model: look45.model, vibes: look45.vibes });
    assert.equal(body45.prompt, 'muted colors, 1boy, 1girl, kitchen');
    assert.equal(body45.vibes.length, 1);
});
