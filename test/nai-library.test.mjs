// Unit tests for nai-library.js: knobs, free-tier check, library seed / migration / selection / import-export.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeNaiParams, resolveNaiSize, naiCost, enforceFreeTier, NAI_PROFILE_KEYS,
    ensureNaiLibrary, activeNaiStyle, activeNaiStyleTags, activeNaiNegativeText, activeNaiNegativeEntry,
    addNaiEntry, updateNaiEntry, duplicateNaiEntry, removeNaiEntry, setActiveNaiStyle, setActiveNaiNegative,
    filterNaiEntries, exportNaiLibrary, importNaiLibrary, migrateNaiNegative, catalogStyleFromMessage,
    NAI_DEFAULT_STYLE_45, NAI_DEFAULT_STYLE_V5, NAI_DEFAULT_NEGATIVE, NAI_SEED_STYLES,
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

test('first run seeds the library: Эйден active on 4.5, house V5 on V5, house negative, found styles inactive', () => {
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
    assert.equal(d.name, 'Эйден (домашний 4.5) (копия)');
    assert.equal(d.value, NAI_DEFAULT_STYLE_45);
    updateNaiEntry(s, 'styles', d.id, { name: ' Эйден 2 ', value: ' a, b ' });
    assert.deepEqual([d.name, d.value], ['Эйден 2', 'a, b']);
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
    assert.equal(filterNaiEntries(s.naiStyles, 'эйден').length, 1);
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
