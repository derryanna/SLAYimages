// Unit tests for the «NovelAI через прокси» request body (OpenAI-style /v1/images/generations).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseNaiInstruction, resolveNaiLook, buildNaiProxyBody, naiProxyModel, naiQualityTags,
    NAI_MODEL_45, NAI_MODEL_V5, NAI_MODEL_V5_MEDIUM, NAI_PROXY_MODEL_PREFIX,
} from '../nai-comics.js';

test('proxy model id: vendor prefix, no double prefix, Medium Effort → V5 Full', () => {
    assert.equal(naiProxyModel(NAI_MODEL_V5), 'novelai/nai-diffusion-5-full');
    assert.equal(naiProxyModel(NAI_MODEL_45), 'novelai/nai-diffusion-4-5-full');
    assert.equal(naiProxyModel('novelai/nai-diffusion-4-5-curated'), 'novelai/nai-diffusion-4-5-curated');
    assert.equal(naiProxyModel(NAI_MODEL_V5_MEDIUM), NAI_PROXY_MODEL_PREFIX + NAI_MODEL_V5);
    assert.equal(naiProxyModel(''), NAI_PROXY_MODEL_PREFIX + NAI_MODEL_V5);
});

test('quality tags: added once, weight groups kept whole, no "no text" on a comic', () => {
    assert.equal(naiQualityTags('1girl, solo'), '1girl, solo, very aesthetic, masterpiece, no text');
    assert.equal(naiQualityTags('1girl, masterpiece, Very Aesthetic,'), '1girl, masterpiece, Very Aesthetic, no text');
    assert.equal(naiQualityTags('1.2::a, b::, comic, speech bubble'), '1.2::a, b::, comic, speech bubble, very aesthetic, masterpiece');
});

test('proxy body: style first, characters folded into the prompt, their uc into the negative', () => {
    const instr = parseNaiInstruction({
        base: '1boy, 1girl, kitchen, night',
        characters: [
            { name: 'Ren', prompt: 'boy, silver hair, grey eyes', uc: 'lipstick, lowres' },
            { name: 'Mira', prompt: 'girl, blonde hair, green eyes' },
        ],
        negative: 'speech bubble',
        aspect_ratio: '2:3',
    });
    const look = resolveNaiLook(instr, { settingsModel: NAI_MODEL_V5 });
    const body = buildNaiProxyBody(instr, {
        styleTags: '1.3::artist:someone::, muted colors', styleSuffix: look.styleSuffix, negative: 'lowres, bad hands',
        model: look.model, width: 832, height: 1216, steps: 30, scale: 5.5, sampler: 'k_dpmpp_2m', scheduler: 'karras', cfgRescale: 0.2, seed: 42,
    });
    assert.equal(body.model, 'novelai/nai-diffusion-5-full');
    assert.ok(body.prompt.startsWith('1.3::artist:someone::, muted colors, 1boy, 1girl, kitchen, night'), body.prompt);
    assert.ok(body.prompt.includes('boy, silver hair, grey eyes, girl, blonde hair, green eyes'), body.prompt);
    assert.ok(body.prompt.endsWith('very aesthetic, masterpiece, no text'), body.prompt);
    assert.equal(body.negative_prompt, 'lowres, bad hands, speech bubble, lipstick');
    assert.equal(body.size, '832x1216');
    assert.equal(body.n, 1);
    assert.equal(body.steps, 30);
    assert.equal(body.scale, 5.5);
    assert.equal(body.sampler, 'k_dpmpp_2m');
    assert.equal('noise_schedule' in body, false); // V5: no schedule field
    assert.equal(body.cfg_rescale, 0.2);
    assert.equal(body.seed, 42);
    assert.equal(body.response_format, 'b64_json');
    // fields this format has no place for
    for (const k of ['characters', 'vibes', 'precise_refs', 'allow_anlas', 'width', 'height']) assert.equal(k in body, false, k);
});

test('proxy body: random seed, no rescale and an unsupported schedule are left out; quality can be off', () => {
    const instr = parseNaiInstruction({ prompt: '1girl, solo, smile' });
    const opts = { negative: '', model: NAI_MODEL_45, width: 1024, height: 1024, cfgRescale: 0, seed: -1, quality: false };
    assert.equal(buildNaiProxyBody(instr, { ...opts, scheduler: 'native' }).noise_schedule, 'native');
    const body = buildNaiProxyBody(instr, { ...opts, scheduler: 'exponential' });
    assert.equal(body.model, 'novelai/nai-diffusion-4-5-full');
    assert.equal(body.prompt, '1girl, solo, smile');
    assert.equal(body.negative_prompt, '');
    for (const k of ['seed', 'cfg_rescale', 'noise_schedule']) assert.equal(k in body, false, k);
    assert.equal(body.steps, 28);
    assert.equal(body.scale, 5);
});
