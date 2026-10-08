// Unit tests for the style import: pasted generation posts and NovelAI image metadata → library style.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitNaiTags, extractNaiStyle, parseNaiStylePost, parseNaiImageMeta } from '../nai-library.js';

const POST_JOTARO = `📎 Генерация #1930902
👤 Автор: [ ■■ ]
🧠 Модель: NAI Diffusion V4.5 Full
🖼 Пресет: 9:16
🎲 Сид: 1038682275

Промпт:
year 2025, fuyao (kafeiwww), 0.6::artist:fumio_(snnmfmw)::, 1.1::artist:haiki_(tegusu)::, artist:penguin_frontier, masterpiece, best quality, 1.2::high contrast::, muted colors

1boy, solo, Jotaro Kujo, JoJo's Bizarre Adventure, male focus, white tank top, sitting
dramatic lighting, warm lighting, outdoors, japanese house, sky`;

const POST_AIDEN = `📎 Генерация #1868901
👤 Автор: 𝙰𝚒𝚍𝚎𝚗
🧠 Модель: NAI Diffusion V4.5 Full
🖼 Пресет: 3:2
🎲 Сид: 1486364912

Промпт:
0.8::lart_art1 ::, 1.6::zero_q_0q::, -2::multiple images::, intricate details, chiaroscuro, masterpiece, sharp focus,

solo, male focus, masturbation, bedroom, bed, mirror

1boy, blonde hair, short hair, green eyes, topless

Персонажи:
Aiden`;

const POST_KITCHEN = `📎 Генерация #2050597
👤 Автор: [ ■■ ]
🧠 Модель: NAI Diffusion V4.5 Full

Промпт:
1.5::anime coloring, anime, anime style::

1.4::nekido::, 0.7::gomoro (nsfwgomoro)::, haiki (tegusu), very aesthetic, masterpiece,
2::year 2025 ::

zero q 0q, 1.3::oro9 ::, 1.5::realistic, photorealistic::,

yaoi, male focus, 2boys, sex from behind, anal, kitchen, table

Персонажи:
Flyn, Nag`;

test('splitNaiTags keeps weight groups whole', () => {
    assert.deepEqual(splitNaiTags('a, 1.5::b, c::, d'), ['a', '1.5::b, c::', 'd']);
    assert.deepEqual(splitNaiTags('-2::multiple images::, x'), ['-2::multiple images::', 'x']);
    assert.deepEqual(splitNaiTags('0.6::artist:fumio_(snnmfmw)::, artist:penguin'), ['0.6::artist:fumio_(snnmfmw)::', 'artist:penguin']);
});

test('Jotaro post: style paragraph only, scene and lighting cut, author hidden → number', () => {
    const r = parseNaiStylePost(POST_JOTARO);
    assert.equal(r.model, '4.5');
    assert.equal(r.name, '#1930902');
    assert.match(r.value, /^year 2025, fuyao \(kafeiwww\), 0\.6::artist:fumio_\(snnmfmw\)::/);
    assert.match(r.value, /muted colors$/);
    assert.doesNotMatch(r.value, /1boy|Jotaro|outdoors/);
});

test('Aiden post: unicode author normalised, characters and scene cut', () => {
    const r = parseNaiStylePost(POST_AIDEN);
    assert.equal(r.name, 'Aiden #1868901');
    assert.equal(r.value, '0.8::lart_art1 ::, 1.6::zero_q_0q::, -2::multiple images::, intricate details, chiaroscuro, masterpiece, sharp focus');
});

test('Kitchen post: several style paragraphs joined, yaoi paragraph and characters cut', () => {
    const r = parseNaiStylePost(POST_KITCHEN);
    assert.equal(r.name, 'Flyn #2050597');
    assert.match(r.value, /^1\.5::anime coloring, anime, anime style::, 1\.4::nekido::/);
    assert.match(r.value, /2::year 2025 ::, zero q 0q, 1\.3::oro9 ::, 1\.5::realistic, photorealistic::$/);
    assert.doesNotMatch(r.value, /yaoi|kitchen|Flyn/);
});

test('plain one-line prompt: tags before the first content tag', () => {
    assert.equal(extractNaiStyle('artist:wlop, painterly, masterpiece, 1girl, solo, smile'), 'artist:wlop, painterly, masterpiece');
    assert.equal(parseNaiStylePost('artist:wlop, painterly').value, 'artist:wlop, painterly');
    assert.equal(parseNaiStylePost('artist:wlop, painterly').model, null);
});

function pngWithText(chunks) {
    const enc = new TextEncoder();
    const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
    for (const [key, val] of chunks) {
        const data = new Uint8Array([...enc.encode(key), 0, ...enc.encode(val)]);
        const head = new Uint8Array(8); new DataView(head.buffer).setUint32(0, data.length); head.set(enc.encode('tEXt'), 4);
        parts.push(head, data, new Uint8Array(4));
    }
    const iend = new Uint8Array(12); iend.set(enc.encode('IEND'), 4); parts.push(iend);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

test('NovelAI PNG: Description is the prompt, Source gives the model', () => {
    const png = pngWithText([['Title', 'NovelAI generated image'], ['Description', 'artist:dang0_23, painterly, 1boy, solo'], ['Source', 'NovelAI Diffusion V4.5 4BDE2A90']]);
    assert.deepEqual(parseNaiImageMeta(png), { prompt: 'artist:dang0_23, painterly, 1boy, solo', model: '4.5' });
});

test('WebP / other: prompt found in an embedded JSON comment (UTF-8 and UTF-16)', () => {
    const json = '{"prompt": "artist:x, \\"quoted\\", 1girl", "v4_prompt": {}} NovelAI Diffusion V5';
    const u8 = new TextEncoder().encode('RIFF....WEBPEXIF' + json);
    assert.deepEqual(parseNaiImageMeta(u8), { prompt: 'artist:x, "quoted", 1girl', model: 'v5' });
    const u16 = new Uint8Array([...'UNICODE\0'].map(c => c.charCodeAt(0)).concat(...[...json].map(c => [c.charCodeAt(0), 0])));
    assert.equal(parseNaiImageMeta(u16).prompt, 'artist:x, "quoted", 1girl');
    assert.equal(parseNaiImageMeta(new Uint8Array([1, 2, 3])), null);
});
