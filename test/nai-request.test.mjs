// Unit tests for the nai-vibe plugin request builder (no network, no SillyTavern).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerateRequest, snapToGrid, normalizeCharacters, withQuality, clampSize } from '../server-plugin/nai-vibe/request.mjs';

test('plain prompt request is backward compatible', () => {
    const r = buildGenerateRequest({ prompt: '1girl, blonde hair, smile', negative_prompt: 'lowres', width: 832, height: 1216, model: 'nai-diffusion-4-5-full' });
    assert.equal(r.action, 'generate');
    assert.equal(r.model, 'nai-diffusion-4-5-full');
    assert.equal(r.input, '1girl, blonde hair, smile, very aesthetic, masterpiece, no text');
    const p = r.parameters;
    assert.equal(p.params_version, 3);
    assert.equal(p.width, 832);
    assert.equal(p.height, 1216);
    assert.equal(p.steps, 28);
    assert.equal(p.scale, 5);
    assert.equal(p.sampler, 'k_euler_ancestral');
    assert.equal(p.noise_schedule, 'karras');
    assert.equal(p.cfg_rescale, 0);
    assert.equal(p.skip_cfg_above_sigma, undefined);
    assert.equal(p.use_coords, false);
    assert.deepEqual(p.characterPrompts, []);
    assert.deepEqual(p.v4_prompt.caption, { base_caption: r.input, char_captions: [] });
    assert.equal(p.v4_prompt.use_order, true);
    assert.deepEqual(p.v4_negative_prompt.caption, { base_caption: 'lowres', char_captions: [] });
    assert.equal(p.negative_prompt, 'lowres');
    assert.deepEqual(p.reference_image_multiple, []);
    assert.equal(p.qualityToggle, true);
});

test('base alias and quality off', () => {
    const r = buildGenerateRequest({ base: 'scene tags', quality: false });
    assert.equal(r.input, 'scene tags');
    assert.equal(r.parameters.qualityToggle, false);
});

test('characters become char_captions with per-character negatives and coordinates', () => {
    const r = buildGenerateRequest({
        base: '1boy, 1girl, comic, speech bubble',
        negative_prompt: 'lowres, text',
        characters: [
            { prompt: 'boy, silver hair, grey eyes', uc: 'mask, headband', center: { x: 0.28, y: 0.52 } },
            { prompt: 'girl, blonde hair, green eyes', uc: 'huge breasts', center: { x: 0.74, y: 0.5 } },
        ],
    });
    const p = r.parameters;
    assert.equal(p.use_coords, true);
    assert.equal(p.v4_prompt.use_coords, true);
    assert.deepEqual(p.v4_prompt.caption.char_captions, [
        { char_caption: 'boy, silver hair, grey eyes', centers: [{ x: 0.3, y: 0.5 }] },
        { char_caption: 'girl, blonde hair, green eyes', centers: [{ x: 0.7, y: 0.5 }] },
    ]);
    assert.deepEqual(p.v4_negative_prompt.caption.char_captions, [
        { char_caption: 'mask, headband', centers: [{ x: 0.3, y: 0.5 }] },
        { char_caption: 'huge breasts', centers: [{ x: 0.7, y: 0.5 }] },
    ]);
    assert.deepEqual(p.characterPrompts, [
        { prompt: 'boy, silver hair, grey eyes', uc: 'mask, headband', center: { x: 0.3, y: 0.5 }, enabled: true },
        { prompt: 'girl, blonde hair, green eyes', uc: 'huge breasts', center: { x: 0.7, y: 0.5 }, enabled: true },
    ]);
    // comic/speech bubble prompts must not get "no text"
    assert.equal(r.input, '1boy, 1girl, comic, speech bubble, very aesthetic, masterpiece');
    assert.equal(p.v4_prompt.caption.base_caption, r.input);
});

test('characters without centers keep AI positioning (use_coords false, default 0.5/0.5)', () => {
    const r = buildGenerateRequest({ base: 'x', characters: [{ prompt: 'boy' }, { prompt: 'girl', uc: '' }] });
    const p = r.parameters;
    assert.equal(p.use_coords, false);
    assert.deepEqual(p.v4_prompt.caption.char_captions[1], { char_caption: 'girl', centers: [{ x: 0.5, y: 0.5 }] });
    assert.deepEqual(p.v4_negative_prompt.caption.char_captions[0], { char_caption: '', centers: [{ x: 0.5, y: 0.5 }] });
});

test('explicit use_coords override and partial centers', () => {
    const r = buildGenerateRequest({ base: 'x', use_coords: false, characters: [{ prompt: 'boy', center: { x: 0.1, y: 0.1 } }] });
    assert.equal(r.parameters.use_coords, false);
    assert.deepEqual(r.parameters.v4_prompt.caption.char_captions[0].centers, [{ x: 0.1, y: 0.1 }]);
    const r2 = buildGenerateRequest({ base: 'x', characters: [{ prompt: 'boy', center: { x: 0.9 } }] });
    assert.equal(r2.parameters.use_coords, false, 'a center needs both x and y');
});

test('snapToGrid snaps to the 5x5 web UI grid', () => {
    assert.equal(snapToGrid(0), 0.1);
    assert.equal(snapToGrid(0.19), 0.1);
    assert.equal(snapToGrid(0.21), 0.3);
    assert.equal(snapToGrid(0.5), 0.5);
    assert.equal(snapToGrid(1.4), 0.9);
    assert.equal(snapToGrid('abc'), 0.5);
});

test('normalizeCharacters drops empties and caps at six', () => {
    const list = normalizeCharacters([{ prompt: '' }, null, 'x', ...Array.from({ length: 8 }, (_, i) => ({ prompt: `c${i}` }))]);
    assert.equal(list.length, 6);
    assert.equal(list[0].prompt, 'c0');
});

test('steps are capped at 28 and size at 1 MP (free Opus limits)', () => {
    const r = buildGenerateRequest({ prompt: 'x', steps: 50, width: 1536, height: 1536 });
    assert.equal(r.parameters.steps, 28);
    assert.ok(r.parameters.width * r.parameters.height <= 1024 * 1024);
    assert.equal(r.parameters.width % 64, 0);
    assert.deepEqual(clampSize(1216, 832), [1216, 832]);
    assert.deepEqual(clampSize(undefined, undefined), [832, 1216]);
});

test('vibe references are passed through', () => {
    const refs = [{ encoding: 'AAA', strength: 0.6, ie: 1 }, { encoding: 'BBB', strength: 0.4, ie: 0.8 }];
    const p = buildGenerateRequest({ prompt: 'x' }, refs).parameters;
    assert.deepEqual(p.reference_image_multiple, ['AAA', 'BBB']);
    assert.deepEqual(p.reference_strength_multiple, [0.6, 0.4]);
    assert.deepEqual(p.reference_information_extracted_multiple, [1, 0.8]);
});

test('withQuality keeps a Text: tail last', () => {
    assert.equal(withQuality('1girl, Text: hello'), '1girl, very aesthetic, masterpiece Text: hello');
    assert.equal(withQuality('1girl,'), '1girl, very aesthetic, masterpiece, no text');
});

test('seed is honoured when given, random otherwise', () => {
    assert.equal(buildGenerateRequest({ prompt: 'x', seed: 42 }).parameters.seed, 42);
    const s = buildGenerateRequest({ prompt: 'x' }).parameters.seed;
    assert.ok(Number.isInteger(s) && s >= 0);
});

test('withQuality does not repeat tags the prompt already has (library styles carry them)', () => {
    assert.equal(withQuality('artist:x, masterpiece, very aesthetic, 1girl'), 'artist:x, masterpiece, very aesthetic, 1girl, no text');
    assert.equal(withQuality('Very Aesthetic, masterpiece, comic'), 'Very Aesthetic, masterpiece, comic');
    assert.equal(withQuality('masterpiece, 1girl, Text: hi'), 'masterpiece, 1girl, very aesthetic Text: hi');
});

test('cfg_rescale and skip_cfg_above_sigma pass through; V5 drops noise_schedule and skip-cfg', () => {
    const p45 = buildGenerateRequest({ prompt: 'x', model: 'nai-diffusion-4-5-full', cfg_rescale: 0.3, skip_cfg_above_sigma: 19, scheduler: 'native' }).parameters;
    assert.equal(p45.cfg_rescale, 0.3);
    assert.equal(p45.skip_cfg_above_sigma, 19);
    assert.equal(p45.noise_schedule, 'native');
    const p5 = buildGenerateRequest({ prompt: 'x', model: 'nai-diffusion-5-full', cfg_rescale: 0.3, skip_cfg_above_sigma: 19 }).parameters;
    assert.equal(p5.cfg_rescale, 0.3);
    assert.equal(p5.noise_schedule, undefined);
    assert.equal(p5.skip_cfg_above_sigma, undefined);
    assert.equal(buildGenerateRequest({ prompt: 'x', model: 'nai-diffusion-4-5-full', skip_cfg_above_sigma: 0 }).parameters.skip_cfg_above_sigma, undefined, '0 = off');
});

test('Medium Effort model: steps / sampler / CFG rescale pinned to the site values, V5 fields dropped, the rest kept', () => {
    const r = buildGenerateRequest({
        prompt: 'x', negative_prompt: 'lowres', model: 'nai-diffusion-5-full-medium',
        steps: 28, sampler: 'k_dpmpp_2m', cfg_rescale: 0.5, scale: 3.5, scheduler: 'native', skip_cfg_above_sigma: 19,
        characters: [{ prompt: 'girl', uc: 'lipstick' }],
    });
    assert.equal(r.model, 'nai-diffusion-5-full-medium');
    const p = r.parameters;
    assert.equal(p.steps, 14);
    assert.equal(p.sampler, 'k_euler_ancestral');
    assert.equal(p.cfg_rescale, 0);
    assert.equal(p.scale, 3.5, 'CFG is the caller\'s');
    assert.equal(p.noise_schedule, undefined);
    assert.equal(p.skip_cfg_above_sigma, undefined);
    assert.equal(p.negative_prompt, 'lowres', 'the negative is still sent');
    assert.equal(p.v4_negative_prompt.caption.char_captions[0].char_caption, 'lipstick', 'character negatives are still sent');
    // Even with Anlas allowed the pins hold (the site has no 50-step Medium).
    assert.equal(buildGenerateRequest({ prompt: 'x', model: 'nai-diffusion-5-full-medium', steps: 50, allow_anlas: true }).parameters.steps, 14);
    // V5 Full is not touched.
    assert.equal(buildGenerateRequest({ prompt: 'x', model: 'nai-diffusion-5-full', steps: 28, sampler: 'k_dpmpp_2m' }).parameters.sampler, 'k_dpmpp_2m');
});

test('allow_anlas lifts the free-tier clamp to 3 MP / 50 steps', () => {
    const p = buildGenerateRequest({ prompt: 'x', steps: 40, width: 1536, height: 1536, allow_anlas: true }).parameters;
    assert.equal(p.steps, 40);
    assert.deepEqual([p.width, p.height], [1536, 1536]);
    const q = buildGenerateRequest({ prompt: 'x', steps: 80, width: 2048, height: 2048, allow_anlas: true }).parameters;
    assert.equal(q.steps, 50);
    assert.ok(q.width * q.height <= 3145728);
    const r = buildGenerateRequest({ prompt: 'x', steps: 40, width: 1536, height: 1536, allow_anlas: 'yes' }).parameters;
    assert.equal(r.steps, 28, 'only a boolean true lifts the clamp');
});

// ── Precise Reference (V5) ──
import { normalizePreciseRefs, preciseRefDescription, supportsPreciseRefs } from '../server-plugin/nai-vibe/request.mjs';

test('precise reference: description strings follow the outfit tick', () => {
    assert.equal(preciseRefDescription('character', false), 'character');
    assert.equal(preciseRefDescription('character', true), 'character_mainoutfit');
    assert.equal(preciseRefDescription('character&style', true), 'character&style');
    assert.equal(preciseRefDescription('character&style', false), 'character&style_anyoutfit');
    assert.equal(preciseRefDescription('style', true), 'style');
    assert.equal(preciseRefDescription('costume', true), 'costume');
});

test('precise reference: only V5 Full and Curated take it', () => {
    assert.equal(supportsPreciseRefs('nai-diffusion-5-full'), true);
    assert.equal(supportsPreciseRefs('nai-diffusion-5-curated'), true);
    assert.equal(supportsPreciseRefs('nai-diffusion-5-full-medium'), false);
    assert.equal(supportsPreciseRefs('nai-diffusion-4-5-full'), false);
});

test('precise reference: list is cleaned, strength capped at 5, unknown type = character', () => {
    const l = normalizePreciseRefs([{ name: ' a ', type: 'costume', strength: 9 }, { name: '', type: 'style' }, { name: 'b', type: 'nope', strength: 'x', same_outfit: true }]);
    assert.deepEqual(l, [
        { name: 'a', type: 'costume', strength: 5, description: 'costume' },
        { name: 'b', type: 'character', strength: 1, description: 'character_mainoutfit' },
    ]);
    assert.equal(normalizePreciseRefs(Array.from({ length: 20 }, (_, i) => ({ name: 'r' + i }))).length, 8);
});

test('precise reference: sent only on a supporting model with allow_anlas', () => {
    const director = [{ image: 'AAAA', description: 'costume', strength: 1.5 }, { image: 'BBBB', description: 'style', strength: 2 }];
    const on = buildGenerateRequest({ prompt: 'x', model: 'nai-diffusion-5-full', allow_anlas: true }, [], director).parameters;
    assert.deepEqual(on.director_reference_images, ['AAAA', 'BBBB']);
    assert.deepEqual(on.director_reference_descriptions[0], { caption: { base_caption: 'costume', char_captions: [] }, legacy_uc: false });
    assert.deepEqual(on.director_reference_strength_values, [1.5, 2]);
    assert.deepEqual(on.director_reference_secondary_strength_values, [0, 0]);
    assert.deepEqual(on.director_reference_information_extracted, [1, 1]);
    for (const b of [{ model: 'nai-diffusion-5-full' }, { model: 'nai-diffusion-5-full-medium', allow_anlas: true }, { model: 'nai-diffusion-4-5-full', allow_anlas: true }]) {
        const off = buildGenerateRequest({ prompt: 'x', ...b }, [], director).parameters;
        assert.equal('director_reference_images' in off, false, JSON.stringify(b));
    }
});

test('precise reference: a picture may come inline (portrait / wardrobe), with or without a name', () => {
    const l = normalizePreciseRefs([{ image: 'data:image/png;base64,QUJD', type: 'costume', strength: 1.5, name: 'Hero: outfit' }, { image: 'REVG' }, { type: 'style' }]);
    assert.deepEqual(l, [
        { name: 'Hero: outfit', type: 'costume', strength: 1.5, description: 'costume', image: 'QUJD' },
        { name: '', type: 'character', strength: 1, description: 'character', image: 'REVG' },
    ]);
});
