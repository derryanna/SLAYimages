// Unit tests for the nai-vibe plugin request builder (no network, no SillyTavern).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerateRequest, snapToGrid, normalizeCharacters, withQuality, clampSize } from '../server-plugin/nai-vibe/request.mjs';

test('plain prompt request is backward compatible', () => {
    const r = buildGenerateRequest({ prompt: '1girl, blonde hair, smile', negative_prompt: 'lowres', width: 832, height: 1216 });
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
