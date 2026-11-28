// Unit tests for nai-library.js: knobs, free-tier check, library seed / migration / selection / import-export.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeNaiParams, resolveNaiSize, naiCost, enforceFreeTier, NAI_PROFILE_KEYS,
    ensureNaiLibrary, activeNaiStyle, activeNaiStyleTags, activeNaiNegativeText, activeNaiNegativeEntry,
    addNaiEntry, updateNaiEntry, duplicateNaiEntry, removeNaiEntry, setActiveNaiStyle, setActiveNaiNegative, toggleActiveNaiStyle, toggleActiveNaiNegative,
    filterNaiEntries, favFirst, exportNaiLibrary, importNaiLibrary, migrateNaiNegative, catalogStyleFromMessage,
    NAI_DEFAULT_STYLE_45, NAI_DEFAULT_STYLE_V5, NAI_DEFAULT_NEGATIVE, NAI_SEED_STYLES,
    parseNaiGallery, naiGalleryImageUrl, filterNaiGallery, setNaiTryStyle, clearNaiTryStyle, naiTryStyle, keepNaiTryStyle, naiStyleLabel, NAI_GALLERY_URL,
} from '../nai-library.js';
import { NAI_MODEL_45, NAI_MODEL_V5 } from '../nai-comics.js';

// ───────── knobs ─────────

test('normalizeNaiParams: defaults for missing, clamps and snaps the rest', () => {
    const p = normalizeNaiParams({});
    assert.equal(p.steps, 28); assert.equal(p.scale, 5); assert.equal(p.cfg_rescale, 0); assert.equal(p.seed, -1);
    assert.equal(p.sampler, 'k_euler_ancestral'); assert.equal(p.scheduler, 'karras'); assert.equal(p.allowAnlas, false);
    const q = normalizeNaiParams({ novelaiSteps: 99, novelaiCfgScale: '7.5', novelaiWidth: 1000, novelaiSeed: 12.7, novelaiSampler: 'bogus', novelaiNoiseSchedule: 'native', novelaiAllowAnlas: true });
    assert.equal(q.steps, 50); assert.equal(q.scale, 7.5); assert.equal(q.width, 1024); assert.equal(q.seed, 12);
    assert.equal(q.sampler, 'k_euler_ancestral'); assert.equal(q.scheduler, 'native'); assert.equal(q.allowAnlas, true);
    assert.equal(normalizeNaiParams({ novelaiSeed: '' }).seed, -1);
});

test('normalizeNaiParams: Medium Effort pins steps / sampler / CFG rescale, the other knobs and the settings stay', () => {
    const s = { novelaiModel: 'nai-diffusion-5-full-medium', novelaiSteps: 30, novelaiSampler: 'k_dpmpp_2m', novelaiCfgRescale: 0.4, novelaiCfgScale: 3.5, novelaiWidth: 1024, novelaiHeight: 1536 };
    const p = normalizeNaiParams(s);
    assert.equal(p.steps, 14); assert.equal(p.sampler, 'k_euler_ancestral'); assert.equal(p.cfg_rescale, 0);
    assert.equal(p.scale, 3.5); assert.equal(p.width, 1024); assert.equal(p.height, 1536);
    assert.equal(s.novelaiSteps, 30, 'settings untouched');
    // The model argument wins over the settings model (a block that switches the model per image).
    const q = normalizeNaiParams({ ...s, novelaiModel: NAI_MODEL_V5 }, 'nai-diffusion-5-full-medium');
    assert.equal(q.steps, 14);
    const r = normalizeNaiParams(s, NAI_MODEL_V5);
    assert.equal(r.steps, 30); assert.equal(r.sampler, 'k_dpmpp_2m'); assert.equal(r.cfg_rescale, 0.4);
    assert.equal(naiCost({ width: 832, height: 1216, steps: p.steps }).free, true, '14 steps at a normal size is free on Opus');
});

test('resolveNaiSize: auto follows the block ratio, presets are literal, custom reads W×H', () => {
    assert.deepEqual(resolveNaiSize({ novelaiAspectRatio: 'auto' }, '2:3'), [832, 1216]);
    assert.deepEqual(resolveNaiSize({ novelaiAspectRatio: 'auto' }, null, '16:9'), [1216, 832]);
    assert.deepEqual(resolveNaiSize({}, null), [1024, 1024]);
    assert.deepEqual(resolveNaiSize({ novelaiAspectRatio: '3:2' }, '2:3'), [1216, 832]);
    assert.deepEqual(resolveNaiSize({ novelaiAspectRatio: '1536x1536' }), [1536, 1536]);
    assert.deepEqual(resolveNaiSize({ novelaiAspectRatio: 'custom', novelaiWidth: 1280, novelaiHeight: 704 }), [1280, 704]);
});

test('naiCost and enforceFreeTier: free up to 1 MP / 28 steps, Anlas lifts to 3 MP / 50', () => {
    assert.deepEqual(naiCost({ width: 1216, height: 832, steps: 28 }), { free: true, reasons: [] });
    assert.deepEqual(naiCost({ width: 1536, height: 1024, steps: 30 }), { free: false, reasons: ['>1 МП', '>28 шагов'] });
    const c = enforceFreeTier(1536, 1536, 40, false);
    assert.ok(c.width * c.height <= 1024 * 1024 && c.width % 64 === 0 && c.steps === 28 && c.clamped);
    const a = enforceFreeTier(1536, 1536, 40, true);
    assert.deepEqual(a, { width: 1536, height: 1536, steps: 40, clamped: false });
    assert.equal(enforceFreeTier(2048, 2048, 60, true).steps, 50);
    assert.ok(enforceFreeTier(2048, 2048, 60, true).width * enforceFreeTier(2048, 2048, 60, true).height <= 3145728);
});

test('profile keys cover the knobs and the active library pointers', () => {
    for (const k of ['novelaiSteps', 'novelaiCfgScale', 'novelaiSeed', 'novelaiSampler', 'naiActiveStyle', 'naiActiveNegative']) assert.ok(NAI_PROFILE_KEYS.includes(k), k);
});

// ───────── library ─────────

test('first run seeds the library: house 4.5 active on 4.5, house V5 on V5, house negative, found styles inactive', () => {
    const s = {};
    assert.equal(ensureNaiLibrary(s), true);
    assert.equal(s.naiStyles.length, NAI_SEED_STYLES.length);
    assert.equal(activeNaiStyle(s, NAI_MODEL_45).id, 'house-45');
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_45), NAI_DEFAULT_STYLE_45);
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_V5), NAI_DEFAULT_STYLE_V5);
    assert.equal(activeNaiNegativeText(s), NAI_DEFAULT_NEGATIVE);
    assert.ok(s.naiStyles.some(e => e.id === 'found-f3' && e.value.startsWith('1.5::anime coloring')));
    assert.equal(ensureNaiLibrary(s), false, 'second run is a no-op');
});

test('a non-empty legacy negative migrates into «Своё» and becomes active; the field is cleared', () => {
    const s = { novelaiNegativePrompt: 'lowres, bad hands' };
    ensureNaiLibrary(s);
    const e = activeNaiNegativeEntry(s);
    assert.equal(e.name, 'Своё'); assert.equal(e.value, 'lowres, bad hands');
    assert.equal(s.novelaiNegativePrompt, '');
    assert.equal(s.naiNegatives.length, 2);
    // Same name again (a legacy profile) updates the entry instead of duplicating it.
    migrateNaiNegative(s, 'other', 'Своё');
    assert.equal(s.naiNegatives.length, 2);
    assert.equal(activeNaiNegativeText(s), 'other');
});

test('fallback: empty or broken library and missing pointers give the house constants; explicit none gives empty', () => {
    const s = { naiStyles: 'garbage', naiNegatives: [{ id: 'x', name: 'n', value: 'v' }], naiActiveStyle: 7, naiActiveNegative: 'missing' };
    ensureNaiLibrary(s);
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_45), NAI_DEFAULT_STYLE_45, 'no pointer → constant');
    assert.equal(activeNaiNegativeText(s), NAI_DEFAULT_NEGATIVE, 'dangling pointer → constant');
    setActiveNaiStyle(s, '', NAI_MODEL_45);
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_45), '', 'explicit none');
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_V5), '', '«Без стиля» switches both models off');
    assert.deepEqual(s.naiActiveStyle, { '4.5': '', v5: '' });
    setActiveNaiNegative(s, '');
    assert.equal(activeNaiNegativeText(s), '');
    assert.equal(activeNaiStyleTags({}, undefined), NAI_DEFAULT_STYLE_45, 'no model, no library → 4.5 constant');
});

test('active style is per model; "any" styles activate for the current model; model change frees the slot', () => {
    const s = {};
    ensureNaiLibrary(s);
    const f3 = s.naiStyles.find(e => e.id === 'found-f3');
    assert.equal(setActiveNaiStyle(s, f3.id, NAI_MODEL_V5), '4.5', 'a 4.5 entry lands in the 4.5 slot whatever the UI model');
    assert.equal(activeNaiStyle(s, NAI_MODEL_45).id, 'found-f3');
    assert.equal(activeNaiStyle(s, NAI_MODEL_V5).id, 'house-v5');
    const any = addNaiEntry(s, 'styles', { name: 'Универсальный', value: 'flat color', model: 'any' });
    assert.equal(setActiveNaiStyle(s, any.id, NAI_MODEL_V5), 'v5');
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_V5), 'flat color');
    updateNaiEntry(s, 'styles', any.id, { model: '4.5' });
    assert.equal(activeNaiStyle(s, NAI_MODEL_V5), null, 'no longer serves V5');
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_V5), NAI_DEFAULT_STYLE_V5);
    assert.equal(setActiveNaiStyle(s, 'nope', NAI_MODEL_45), null);
});

test('block without model + entry for the settings model → that entry', () => {
    const s = {};
    ensureNaiLibrary(s);
    const custom = addNaiEntry(s, 'styles', { name: 'Мой V5', value: 'oil painting', model: 'v5' });
    setActiveNaiStyle(s, custom.id, NAI_MODEL_V5);
    const settingsModel = NAI_MODEL_V5; // what resolveNaiLook returns when the block says nothing
    assert.equal(activeNaiStyleTags(s, settingsModel), 'oil painting');
});

test('CRUD: add names blanks, duplicate sits next to the source, remove clears pointers', () => {
    const s = {};
    ensureNaiLibrary(s);
    const n = addNaiEntry(s, 'negatives', { value: 'x' });
    assert.equal(n.name, 'Негатив 2');
    const d = duplicateNaiEntry(s, 'styles', 'house-45');
    assert.equal(s.naiStyles[1].id, d.id);
    assert.equal(d.name, 'Домашний 4.5 (копия)');
    assert.equal(d.value, NAI_DEFAULT_STYLE_45);
    updateNaiEntry(s, 'styles', d.id, { name: ' Дом 2 ', value: ' a, b ' });
    assert.deepEqual([d.name, d.value], ['Дом 2', 'a, b']);
    assert.equal(removeNaiEntry(s, 'styles', 'house-45'), true);
    assert.equal(s.naiActiveStyle['4.5'], undefined);
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_45), NAI_DEFAULT_STYLE_45, 'removed active → constant');
    assert.equal(removeNaiEntry(s, 'negatives', 'house-neg'), true);
    assert.equal(s.naiActiveNegative, undefined);
    assert.equal(removeNaiEntry(s, 'negatives', 'house-neg'), false);
});

test('filterNaiEntries searches name and text, case-insensitively', () => {
    const s = {};
    ensureNaiLibrary(s);
    assert.deepEqual(filterNaiEntries(s.naiStyles, 'PAINTERLY').map(e => e.id), ['found-f4']);
    assert.equal(filterNaiEntries(s.naiStyles, 'ДОМАШНИЙ 4.5').length, 1);
    assert.equal(filterNaiEntries(s.naiStyles, '').length, s.naiStyles.length);
});

test('export → import round-trips; same ids replace, new ids append; a bare name→tags map imports as styles', () => {
    const a = {};
    ensureNaiLibrary(a);
    addNaiEntry(a, 'styles', { id: 'mine', name: 'Mine', value: 'v1', model: 'v5' });
    const json = JSON.stringify(exportNaiLibrary(a));
    const b = {};
    ensureNaiLibrary(b);
    updateNaiEntry(b, 'styles', 'house-45', { value: 'edited' });
    const r = importNaiLibrary(b, json);
    assert.equal(r.styles, a.naiStyles.length);
    assert.equal(b.naiStyles.find(e => e.id === 'house-45').value, NAI_DEFAULT_STYLE_45, 'same id replaced');
    assert.equal(b.naiStyles.find(e => e.id === 'mine').value, 'v1');
    assert.equal(b.naiStyles.length, a.naiStyles.length);
    const r2 = importNaiLibrary(b, { f9_test: 'artist:x, y' }, { model: '4.5' });
    assert.deepEqual(r2, { styles: 1, negatives: 0 });
    assert.equal(b.naiStyles.find(e => e.id === 'import-f9_test').model, '4.5');
    assert.throws(() => importNaiLibrary(b, '{"nope":1}'));
    assert.throws(() => importNaiLibrary(b, '[]'));
});

test('catalogStyleFromMessage: only { type: "slay-style", name, tags } with both non-empty becomes a style', () => {
    assert.deepEqual(catalogStyleFromMessage({ type: 'slay-style', name: '  Мой микс ', tags: '1.2::a::,  b ' }), { name: 'Мой микс', value: '1.2::a::, b' });
    assert.equal(catalogStyleFromMessage({ type: 'slay-style', name: '', tags: 'a' }), null);
    assert.equal(catalogStyleFromMessage({ type: 'slay-style', name: 'x', tags: '   ' }), null);
    assert.equal(catalogStyleFromMessage({ type: 'other', name: 'x', tags: 'a' }), null);
    assert.equal(catalogStyleFromMessage('{"type":"slay-style"}'), null);
    assert.equal(catalogStyleFromMessage(null), null);
    assert.equal(catalogStyleFromMessage({ type: 'slay-style', name: 'n'.repeat(500), tags: 'a' }).name.length, 120);
});

test('toggle: a click on an inactive style activates it for its model, a second click switches that model off', () => {
    const s = {};
    ensureNaiLibrary(s);
    const f3 = s.naiStyles.find(e => e.model === '4.5' && e.id !== 'house-45');
    assert.equal(toggleActiveNaiStyle(s, f3.id, NAI_MODEL_V5), false, 'was inactive → now active');
    assert.equal(s.naiActiveStyle['4.5'], f3.id);
    assert.equal(toggleActiveNaiStyle(s, f3.id, NAI_MODEL_V5), true, 'was active → switched off');
    assert.equal(s.naiActiveStyle['4.5'], '');
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_45), '', 'off means empty, not the house constant');
    const v5 = s.naiActiveStyle.v5;
    assert.ok(v5, 'the other model keeps its style');
    assert.equal(toggleActiveNaiNegative(s, 'house-neg'), true);
    assert.equal(s.naiActiveNegative, '');
    assert.equal(toggleActiveNaiNegative(s, 'house-neg'), false);
    assert.equal(s.naiActiveNegative, 'house-neg');
});

test('favourite styles: ★ survives the load clean-up, goes first, is not copied by «дубликат»', () => {
    const s = {};
    ensureNaiLibrary(s);
    const ids = s.naiStyles.map(e => e.id);
    const last = ids[ids.length - 1];
    updateNaiEntry(s, 'styles', last, { fav: true });
    assert.deepEqual(favFirst(s.naiStyles).map(e => e.id), [last, ...ids.slice(0, -1)]);
    ensureNaiLibrary(s);
    assert.equal(s.naiStyles.find(e => e.id === last).fav, true, 'kept after the clean-up on load');
    assert.equal(duplicateNaiEntry(s, 'styles', last).fav, undefined);
    assert.equal(exportNaiLibrary(s).styles.find(e => e.id === last).fav, true);
    updateNaiEntry(s, 'styles', last, { fav: false });
    assert.equal('fav' in s.naiStyles.find(e => e.id === last), false);
    assert.deepEqual(favFirst(s.naiStyles).map(e => e.id).slice(0, 2), ids.slice(0, 2));
});

// ── Precise Reference (V5) ──
import { naiRefBucket, activeNaiPreciseRefs, naiSupportsPreciseRefs, NAI_REF_COST } from '../nai-library.js';

test('naiRefBucket: closest ~1 MP bucket, cover resize, centre crop', () => {
    assert.deepEqual(naiRefBucket(1440, 2184), { width: 832, height: 1216, resizeWidth: 832, resizeHeight: 1262, left: 0, top: 23 });
    assert.deepEqual(naiRefBucket(1024, 1024), { width: 1024, height: 1024, resizeWidth: 1024, resizeHeight: 1024, left: 0, top: 0 });
    const wide = naiRefBucket(450, 358);
    assert.deepEqual([wide.width, wide.height], [1152, 896]);
    assert.ok(wide.resizeWidth >= wide.width && wide.resizeHeight >= wide.height);
    const tall = naiRefBucket(100, 5000);
    assert.deepEqual([tall.width, tall.height], [256, 4096]);
});

test('activeNaiPreciseRefs: ticked entries only, outfit tick only for character types', () => {
    const s = { novelaiPreciseRefs: [
        { name: 'a', type: 'character', strength: 1.2, sameOutfit: true, enabled: true, thumb: 'x' },
        { name: 'b', type: 'style', strength: 7, sameOutfit: true, enabled: true },
        { name: 'c', type: 'costume', enabled: false },
    ] };
    assert.deepEqual(activeNaiPreciseRefs(s), [
        { name: 'a', type: 'character', strength: 1.2, same_outfit: true },
        { name: 'b', type: 'style', strength: 5 },
    ]);
    assert.deepEqual(activeNaiPreciseRefs({}), []);
});

test('naiCost counts precise references; only V5 Full / Curated support them', () => {
    assert.deepEqual(naiCost({ width: 832, height: 1216, steps: 28, refs: 2 }), { free: false, reasons: [`референсы 2 × ${NAI_REF_COST} = 10 Anlas за картинку`] });
    assert.equal(naiSupportsPreciseRefs('nai-diffusion-5-full'), true);
    assert.equal(naiSupportsPreciseRefs('nai-diffusion-5-full-medium'), false);
});

test('old seed names are renamed once; entries the user renamed stay', () => {
    const s = {
        naiStyles: [
            { id: 'house-45', name: 'Эйден (домашний 4.5)', model: '4.5', value: 'a' },
            { id: 'found-f1', name: 'моё имя', model: '4.5', value: 'b' },
            { id: 'sty-x', name: 'f4 Painterly (живопись)', model: 'any', value: 'c' },
        ],
        naiNegatives: [], naiActiveStyle: {}, naiActiveNegative: '',
    };
    assert.equal(ensureNaiLibrary(s), true);
    assert.deepEqual(s.naiStyles.map(e => e.name), ['Домашний 4.5', 'моё имя', 'f4 Painterly (живопись)']);
    assert.equal(s.naiStyles[0].value, 'a');
    assert.equal(ensureNaiLibrary(s), false);
});

// ───────── gallery and try-on ─────────

const GALLERY_FILE = `window.LIB = ${JSON.stringify({
    scene: 'x', seed: 1, kinds: ['Аниме', 'Арт'],
    styles: [
        { id: 's01', name: 'Первый', model: '4.5', tags: '1.2::artist:a ::, very aesthetic', kinds: ['Аниме'] },
        { id: 's02', name: '  Второй\n стиль ', model: 'v5', tags: 'muted colors,\n film grain', kinds: ['Арт'] },
        { id: 's03', name: 'Любой', model: 'weird', tags: 'flat color', kinds: 'nope' },
        { id: '../evil', name: 'Плохой id', model: 'v5', tags: 'x' },
        { id: 's01', name: 'Дубль', model: 'v5', tags: 'x' },
        { id: 's05', name: '', model: 'v5', tags: 'x' },
        { id: 's06', name: 'Без тегов', model: 'v5', tags: '' },
        null, 'строка',
    ],
})};\n`;

test('parseNaiGallery: the file is read as data, bad rows are dropped, fields are flattened', () => {
    const g = parseNaiGallery(GALLERY_FILE);
    assert.deepEqual(g.kinds, ['Аниме', 'Арт']);
    assert.deepEqual(g.styles.map(s => s.gid), ['s01', 's02', 's03']);
    assert.deepEqual(g.styles[1], { gid: 's02', name: 'Второй стиль', value: 'muted colors, film grain', model: 'v5', kinds: ['Арт'] });
    assert.equal(g.styles[2].model, 'any'); assert.deepEqual(g.styles[2].kinds, []);
    assert.equal(naiGalleryImageUrl('s02'), `${NAI_GALLERY_URL}img/s02.webp`);
    assert.equal(naiGalleryImageUrl('../evil'), '');
});

test('parseNaiGallery: anything that is not the gallery file gives null and never runs', () => {
    globalThis.__galleryRan = false;
    for (const bad of ['', 'nope', '<html>404</html>', 'window.LIB = {"styles": 5};', 'globalThis.__galleryRan = true; window.LIB = {styles:[]}', '{"styles":[', null, undefined]) {
        assert.equal(parseNaiGallery(bad), null);
    }
    assert.equal(globalThis.__galleryRan, false);
    const long = parseNaiGallery(JSON.stringify({ styles: [{ id: 'a', name: 'n'.repeat(500), tags: 't'.repeat(9000) }] }));
    assert.equal(long.styles[0].name.length, 120); assert.equal(long.styles[0].value.length, 4000);
});

test('filterNaiGallery: search over name, tags and kinds, plus a kind chip', () => {
    const g = parseNaiGallery(GALLERY_FILE);
    assert.deepEqual(filterNaiGallery(g.styles, 'film').map(s => s.gid), ['s02']);
    assert.deepEqual(filterNaiGallery(g.styles, 'аниме').map(s => s.gid), ['s01']);
    assert.deepEqual(filterNaiGallery(g.styles, '', 'Арт').map(s => s.gid), ['s02']);
    assert.equal(filterNaiGallery(g.styles, '').length, 3);
});

test('try-on: wins over the library for its model only, and the library is not touched', () => {
    const s = {}; ensureNaiLibrary(s);
    const before = JSON.stringify(s.naiStyles), pointers = JSON.stringify(s.naiActiveStyle);
    const g = parseNaiGallery(GALLERY_FILE);
    setNaiTryStyle(s, g.styles[1]); // v5
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_V5), 'muted colors, film grain');
    assert.equal(activeNaiStyle(s, NAI_MODEL_V5).tryOn, true);
    assert.equal(naiStyleLabel(s, NAI_MODEL_V5), 'Второй стиль · примерка');
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_45), NAI_DEFAULT_STYLE_45, '4.5 keeps its library style');
    assert.equal(naiTryStyle(s, NAI_MODEL_45), null);
    assert.equal(naiTryStyle(s).gid, 's02', 'no model = whatever is being tried');
    assert.equal(JSON.stringify(s.naiStyles), before); assert.equal(JSON.stringify(s.naiActiveStyle), pointers);
    setNaiTryStyle(s, g.styles[2]); // any
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_45), 'flat color'); assert.equal(activeNaiStyleTags(s, NAI_MODEL_V5), 'flat color');
    setActiveNaiStyle(s, '', NAI_MODEL_V5);
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_V5), 'flat color', 'try-on beats «Без стиля» until it is taken off');
    assert.equal(clearNaiTryStyle(s), true); assert.equal(clearNaiTryStyle(s), false);
    assert.equal(activeNaiStyleTags(s, NAI_MODEL_V5), '');
    assert.equal(setNaiTryStyle(s, { name: '', value: 'x' }), null);
    assert.equal(setNaiTryStyle(s, { name: 'x', value: ' ' }), null);
    assert.equal(s.naiTryStyle, undefined);
});

test('keepNaiTryStyle: becomes a library entry once, active for its model, try-on ends', () => {
    const s = {}; ensureNaiLibrary(s);
    const n = s.naiStyles.length;
    const g = parseNaiGallery(GALLERY_FILE);
    setNaiTryStyle(s, g.styles[1]);
    const e = keepNaiTryStyle(s, NAI_MODEL_45);
    assert.equal(s.naiStyles.length, n + 1); assert.equal(e.name, 'Второй стиль'); assert.equal(e.model, 'v5');
    assert.equal(s.naiTryStyle, undefined); assert.equal(s.naiActiveStyle.v5, e.id);
    assert.equal(naiStyleLabel(s, NAI_MODEL_V5), 'Второй стиль');
    setNaiTryStyle(s, g.styles[1]);
    assert.equal(keepNaiTryStyle(s, NAI_MODEL_V5).id, e.id, 'same tags → the existing entry');
    assert.equal(s.naiStyles.length, n + 1);
    assert.equal(keepNaiTryStyle(s, NAI_MODEL_V5), null, 'nothing is being tried');
});

test('naiStyleLabel: library name, house constant, no style', () => {
    const s = {}; ensureNaiLibrary(s);
    assert.equal(naiStyleLabel(s, NAI_MODEL_45), activeNaiStyle(s, NAI_MODEL_45).name);
    setActiveNaiStyle(s, '', NAI_MODEL_45);
    assert.equal(naiStyleLabel(s, NAI_MODEL_45), 'без стиля');
    assert.equal(naiStyleLabel({}, NAI_MODEL_V5), 'Домашний');
});
