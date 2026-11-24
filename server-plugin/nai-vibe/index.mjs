// nai-vibe: NovelAI image generation with Vibe Transfer (.naiv4vibe) for SillyTavern.
// ST's own /api/novelai/generate-image always sends empty reference arrays, so vibes need this route.
// The NovelAI key is read from ST secrets on the server and never reaches the browser.
import fs from 'node:fs';
import path from 'node:path';
import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';
import { extractFileFromZipBuffer } from '../../src/util.js';
import { MODEL_KEYS, buildGenerateRequest, normalizePreciseRefs, supportsPreciseRefs } from './request.mjs';

export const info = { id: 'nai-vibe', name: 'NAI Vibe', description: 'NovelAI generation with vibe files and V4 character prompts.' };

const GENERATE_URL = 'https://image.novelai.net/ai/generate-image';

function vibeDir(req) {
    const dir = path.join(req.user.directories.root, 'nai-vibes');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Precise Reference pictures: PNG files the extension has already cut to a NovelAI bucket.
function refDir(req) {
    const dir = path.join(req.user.directories.root, 'nai-refs');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_REF_BYTES = 8 * 1024 * 1024;

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

    router.get('/refs', (req, res) => {
        res.json(fs.readdirSync(refDir(req)).filter(f => f.endsWith('.png')).map(f => ({ name: f.replace(/\.png$/, '') })));
    });

    router.post('/refs', (req, res) => {
        const name = safeName(String(req.body?.name || '').replace(/\.(png|jpe?g|webp)$/i, '')) || 'ref';
        const buf = Buffer.from(String(req.body?.image || '').replace(/^data:image\/png;base64,/, ''), 'base64');
        if (buf.length < 100 || buf.length > MAX_REF_BYTES || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
            return res.status(400).send('Референс должен быть PNG до 8 МБ.');
        }
        fs.writeFileSync(path.join(refDir(req), name + '.png'), buf);
        res.json({ name });
    });

    router.delete('/refs/:name', (req, res) => {
        const file = path.join(refDir(req), safeName(req.params.name) + '.png');
        if (fs.existsSync(file)) fs.unlinkSync(file);
        res.sendStatus(204);
    });

    router.post('/generate', async (req, res) => {
        const key = readSecret(req.user.directories, SECRET_KEYS.NOVEL);
        if (!key) return res.status(400).send('NovelAI: токен не найден в API Connections → NovelAI.');
        const b = req.body || {};
        const model = b.model || 'nai-diffusion-5-full';
        const dir = vibeDir(req);
        const refs = [];
        for (const v of b.vibes || []) {
            const vibe = readVibe(dir, v.name);
            if (!vibe) return res.status(400).send(`Вайб «${v.name}» не найден.`);
            const enc = pickEncoding(vibe, model);
            if (!enc) return res.status(400).send(`Вайб «${v.name}» закодирован не для ${model} (есть: ${Object.keys(vibe.encodings).join(', ')}).`);
            refs.push({ ...enc, strength: Number(v.strength ?? vibe.importInfo?.strength ?? 0.6) });
        }
        // Plain { prompt } requests and structured { base, characters: [...] } requests both go through here.
        // Precise Reference costs Anlas per picture: without allow_anlas, or on a model that has none, it is left out.
        const director = [];
        if (b.allow_anlas === true && supportsPreciseRefs(model)) {
            for (const r of normalizePreciseRefs(b.precise_refs)) {
                if (r.image) {   // picture sent with the request (a portrait or a wardrobe outfit)
                    const buf = Buffer.from(r.image, 'base64');
                    if (buf.length < 100 || buf.length > MAX_REF_BYTES || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
                        return res.status(400).send(`Референс «${r.name || r.type}»: нужна PNG-картинка до 8 МБ.`);
                    }
                    director.push({ image: r.image, description: r.description, strength: r.strength });
                    continue;
                }
                const file = path.join(refDir(req), safeName(r.name) + '.png');
                if (!fs.existsSync(file)) return res.status(400).send(`Референс «${r.name}» не найден на сервере.`);
                director.push({ image: fs.readFileSync(file).toString('base64'), description: r.description, strength: r.strength });
            }
        }
        const request = buildGenerateRequest({ ...b, model }, refs, director);
        const parameters = request.parameters;
        try {
            const r = await fetch(GENERATE_URL, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
            });
            if (!r.ok) {
                const text = await r.text();
                console.warn('[nai-vibe] NovelAI error', r.status, text.slice(0, 500));
                return res.status(r.status === 402 ? 402 : 502).send(`NovelAI ${r.status}: ${text.slice(0, 300)}`);
            }
            const png = await extractFileFromZipBuffer(await r.arrayBuffer(), '.png');
            if (!png) return res.status(502).send('NovelAI ответила без PNG.');
            console.info(`[nai-vibe] ok ${model} ${parameters.width}x${parameters.height} chars=${parameters.characterPrompts.length} coords=${parameters.use_coords} vibes=${refs.length} precise_refs=${director.length}`);
            res.send(png.toString('base64'));
        } catch (e) {
            console.error('[nai-vibe]', e);
            res.status(500).send(String(e.message || e));
        }
    });
}
