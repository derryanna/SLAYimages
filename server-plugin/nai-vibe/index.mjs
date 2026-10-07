// nai-vibe: NovelAI image generation with Vibe Transfer (.naiv4vibe) for SillyTavern.
// ST's own /api/novelai/generate-image always sends empty reference arrays, so vibes need this route.
// The NovelAI key is read from ST secrets on the server and never reaches the browser.
import fs from 'node:fs';
import path from 'node:path';
import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';
import { extractFileFromZipBuffer } from '../../src/util.js';

export const info = { id: 'nai-vibe', name: 'NAI Vibe', description: 'NovelAI generation with pre-encoded vibe files.' };

const GENERATE_URL = 'https://image.novelai.net/ai/generate-image';
const MODEL_KEYS = {
    'nai-diffusion-4-5-full': 'v4-5full',
    'nai-diffusion-4-5-curated': 'v4-5curated',
    'nai-diffusion-4-full': 'v4full',
    'nai-diffusion-4-curated-preview': 'v4curated',
};

function vibeDir(req) {
    const dir = path.join(req.user.directories.root, 'nai-vibes');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function safeName(name) {
    return String(name || '').replace(/\.naiv4vibe$/i, '').replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/^\.+/, '').trim().slice(0, 80);
}

function readVibe(dir, name) {
    const file = path.join(dir, safeName(name) + '.naiv4vibe');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function summary(name, vibe) {
    return {
        name,
        strength: vibe.importInfo?.strength ?? 0.6,
        information_extracted: vibe.importInfo?.information_extracted ?? null,
        models: Object.keys(vibe.encodings || {}),
        thumbnail: vibe.thumbnail || '',
    };
}

// Encoding of this vibe for the model, or null when the file was encoded for another model.
function pickEncoding(vibe, model) {
    const key = MODEL_KEYS[model];
    const byHash = key && vibe.encodings?.[key];
    if (!byHash) return null;
    const first = Object.values(byHash)[0];
    return first?.encoding ? { encoding: first.encoding, ie: first.params?.information_extracted ?? 1 } : null;
}

// What the NovelAI site adds with "Add Quality Tags" on; "no text" only when no lettering is wanted.
function withQuality(prompt) {
    const textAt = prompt.search(/\bText:/);
    const body = (textAt >= 0 ? prompt.slice(0, textAt) : prompt).trim().replace(/,\s*$/, '');
    const tail = textAt >= 0 ? ' ' + prompt.slice(textAt).trim() : '';
    const wantsText = textAt >= 0 || /speech bubble/i.test(body);
    return `${body}, very aesthetic, masterpiece${wantsText ? '' : ', no text'}${tail}`;
}

export async function init(router) {
    router.get('/vibes', (req, res) => {
        const dir = vibeDir(req);
        const list = fs.readdirSync(dir).filter(f => f.endsWith('.naiv4vibe')).map(f => {
            const name = f.replace(/\.naiv4vibe$/, '');
            try { return summary(name, readVibe(dir, name)); } catch { return null; }
        }).filter(Boolean);
        res.json(list);
    });

    router.post('/vibes', (req, res) => {
        let vibe;
        try { vibe = typeof req.body.file === 'string' ? JSON.parse(req.body.file) : req.body.file; } catch { vibe = null; }
        if (vibe?.identifier !== 'novelai-vibe-transfer' || !vibe.encodings) {
            return res.status(400).send('Это не .naiv4vibe файл (нет identifier novelai-vibe-transfer).');
        }
        const name = safeName(req.body.name || vibe.name) || 'vibe';
        fs.writeFileSync(path.join(vibeDir(req), name + '.naiv4vibe'), JSON.stringify(vibe));
        res.json(summary(name, vibe));
    });

    router.delete('/vibes/:name', (req, res) => {
        const file = path.join(vibeDir(req), safeName(req.params.name) + '.naiv4vibe');
        if (fs.existsSync(file)) fs.unlinkSync(file);
        res.sendStatus(204);
    });

    router.post('/generate', async (req, res) => {
        const key = readSecret(req.user.directories, SECRET_KEYS.NOVEL);
        if (!key) return res.status(400).send('NovelAI: токен не найден в API Connections → NovelAI.');
        const b = req.body || {};
        const model = b.model || 'nai-diffusion-4-5-full';
        const dir = vibeDir(req);
        const refs = [];
        for (const v of b.vibes || []) {
            const vibe = readVibe(dir, v.name);
            if (!vibe) return res.status(400).send(`Вайб «${v.name}» не найден.`);
            const enc = pickEncoding(vibe, model);
            if (!enc) return res.status(400).send(`Вайб «${v.name}» закодирован не для ${model} (есть: ${Object.keys(vibe.encodings).join(', ')}).`);
            refs.push({ ...enc, strength: Number(v.strength ?? vibe.importInfo?.strength ?? 0.6) });
        }
        const prompt = b.quality === false ? String(b.prompt || '') : withQuality(String(b.prompt || ''));
        const negative = String(b.negative_prompt || '');
        const parameters = {
            params_version: 3,
            width: b.width || 832,
            height: b.height || 1216,
            scale: b.scale ?? 5,
            sampler: b.sampler || 'k_euler_ancestral',
            steps: Math.min(b.steps || 28, 28),
            n_samples: 1,
            seed: b.seed >= 0 ? b.seed : Math.floor(Math.random() * 4294967295),
            noise_schedule: b.scheduler || 'karras',
            ucPreset: 0,
            qualityToggle: b.quality !== false,
            prefer_brownian: true,
            dynamic_thresholding: false,
            legacy: false,
            legacy_v3_extend: false,
            sm: false,
            sm_dyn: false,
            add_original_image: false,
            controlnet_strength: 1,
            deliberate_euler_ancestral_bug: false,
            use_coords: false,
            characterPrompts: [],
            negative_prompt: negative,
            v4_prompt: { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true },
            v4_negative_prompt: { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false },
            reference_image_multiple: refs.map(r => r.encoding),
            reference_strength_multiple: refs.map(r => r.strength),
            reference_information_extracted_multiple: refs.map(r => r.ie),
            normalize_reference_strength_multiple: true,
        };
        try {
            const r = await fetch(GENERATE_URL, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'generate', input: prompt, model, parameters }),
            });
            if (!r.ok) {
                const text = await r.text();
                console.warn('[nai-vibe] NovelAI error', r.status, text.slice(0, 500));
                return res.status(r.status === 402 ? 402 : 502).send(`NovelAI ${r.status}: ${text.slice(0, 300)}`);
            }
            const png = await extractFileFromZipBuffer(await r.arrayBuffer(), '.png');
            if (!png) return res.status(502).send('NovelAI ответила без PNG.');
            console.info(`[nai-vibe] ok ${model} ${parameters.width}x${parameters.height} vibes=${refs.length}`);
            res.send(png.toString('base64'));
        } catch (e) {
            console.error('[nai-vibe]', e);
            res.status(500).send(String(e.message || e));
        }
    });
}
