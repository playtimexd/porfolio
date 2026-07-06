// ArtCanvas Studio — node-based multi-provider AI design tool.
// Zero-dependency Node server. Providers: OpenAI, Google Gemini, Seedance (BytePlus Ark).
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- load .env ----
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.PORT || 3000);
const KEYS = {
  openai: process.env.OPENAI_API_KEY || '',
  anthropic: process.env.ANTHROPIC_API_KEY || '',
  gemini: process.env.GEMINI_API_KEY || '',
  seedance: process.env.SEEDANCE_API_KEY || '',
  meshy: process.env.MESHY_API_KEY || '',
};
const ARK_BASE = process.env.ARK_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3';

// =====================================================================
// MODEL REGISTRY — add future models here (one line + adapter if new provider)
// kind: 'llm' | 'image' | 'video'
// =====================================================================
const MODELS = [
  // Anthropic — tier: 'smart' for reasoning-heavy tasks, 'fast' for cheap mechanical ones
  { id: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', kind: 'llm', tier: 'smart' },
  { id: 'claude-haiku-4-5',                     label: 'Claude Haiku 4.5',    provider: 'anthropic', kind: 'llm', tier: 'fast' },
  // OpenAI
  { id: process.env.CHAT_MODEL || 'gpt-5.5',    label: 'GPT (OpenAI)',        provider: 'openai',   kind: 'llm', tier: 'smart' },
  { id: process.env.CHAT_MODEL_FAST || 'gpt-5.4-mini', label: 'GPT mini',     provider: 'openai',   kind: 'llm', tier: 'fast' },
  { id: process.env.IMAGE_MODEL || 'gpt-image-2', label: 'GPT Image 2',       provider: 'openai',   kind: 'image' },
  { id: 'gpt-image-1.5',                        label: 'GPT Image 1.5',       provider: 'openai',   kind: 'image' },
  { id: 'gpt-image-1',                          label: 'GPT Image 1',         provider: 'openai',   kind: 'image' },
  { id: 'sora-2',                               label: 'Sora 2',              provider: 'openai',   kind: 'video' },
  { id: 'sora-2-pro',                           label: 'Sora 2 Pro',          provider: 'openai',   kind: 'video' },
  // Google Gemini
  { id: 'gemini-2.5-pro',                       label: 'Gemini Pro',          provider: 'gemini',   kind: 'llm', tier: 'smart' },
  { id: process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash', label: 'Gemini Flash', provider: 'gemini', kind: 'llm', tier: 'fast' },
  { id: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image', label: 'Gemini Image (Nano Banana)', provider: 'gemini', kind: 'image' },
  // Seedance via BytePlus ModelArk — set SEEDANCE_MODEL to the exact id from your console
  { id: process.env.SEEDANCE_MODEL || 'seedance-2-0', label: 'Seedance', provider: 'seedance', kind: 'video' },
  // Meshy — text-to-3D / image-to-3D
  { id: 'meshy-3d', label: 'Meshy 3D', provider: 'meshy', kind: 'threed' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function apiError(msg, status) {
  const e = new Error(msg);
  e.status = status || 500;
  return e;
}

async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.code || data?.message || `Request failed (${res.status})`;
    throw apiError(msg, res.status);
  }
  return data;
}

// split a data URL into { mime, b64 }
function parseDataUrl(url) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

// =====================================================================
// PROJECT STORE — local disk by default; Supabase cloud storage when
// SUPABASE_URL + SUPABASE_SERVICE_KEY are set (bucket default "artcanvas")
// =====================================================================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUPA = {
  url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  key: process.env.SUPABASE_SERVICE_KEY || '',
  bucket: process.env.SUPABASE_BUCKET || 'artcanvas',
};
const useCloud = !!(SUPA.url && SUPA.key);

const store = useCloud ? {
  kind: 'supabase',
  async get(key) {
    const res = await fetch(`${SUPA.url}/storage/v1/object/${SUPA.bucket}/${key}.json`, {
      headers: { Authorization: `Bearer ${SUPA.key}` },
    });
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok) throw apiError(`Cloud storage read failed (${res.status})`);
    return await res.json();
  },
  async put(key, value) {
    const res = await fetch(`${SUPA.url}/storage/v1/object/${SUPA.bucket}/${key}.json`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPA.key}`, 'Content-Type': 'application/json', 'x-upsert': 'true' },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw apiError(`Cloud storage write failed (${res.status})`);
  },
  async del(key) {
    await fetch(`${SUPA.url}/storage/v1/object/${SUPA.bucket}/${key}.json`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${SUPA.key}` },
    }).catch(() => {});
  },
} : {
  kind: 'local',
  async get(key) {
    const fp = path.join(DATA_DIR, key + '.json');
    if (!fs.existsSync(fp)) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
  },
  async put(key, value) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, key + '.json'), JSON.stringify(value));
  },
  async del(key) {
    const fp = path.join(DATA_DIR, key + '.json');
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  },
};

// aspect-ratio helpers — accepts "16:9" style plus legacy square/landscape/portrait
const LEGACY_RATIOS = { square: '1:1', landscape: '3:2', portrait: '2:3' };
function parseRatio(aspect) {
  const r = LEGACY_RATIOS[aspect] || aspect;
  if (!r || r === 'auto' || r === 'default') return null;
  const m = /^(\d+):(\d+)$/.exec(r);
  return m ? { str: r, w: +m[1], h: +m[2] } : null;
}
function videoRes(quality) {
  return ['high', 'ultra', '1080p'].includes(quality) ? '1080p' : '720p';
}

// normalize single `image` / multi `images` inputs to an array (max 9)
function imagesOf({ image, images }) {
  const list = Array.isArray(images) && images.length ? images : (image ? [image] : []);
  return list.filter(Boolean).slice(0, 9);
}

// resolve an image value (data URL or remote URL) to { mime, buf }
async function fetchImage(image) {
  const parsed = parseDataUrl(image);
  if (parsed) return { mime: parsed.mime, buf: Buffer.from(parsed.b64, 'base64') };
  const res = await fetch(image);
  if (!res.ok) throw apiError(`Could not fetch input image (${res.status})`);
  return { mime: res.headers.get('content-type') || 'image/png', buf: Buffer.from(await res.arrayBuffer()) };
}

// build a multipart/form-data body without dependencies
function multipart(fields, files) {
  const boundary = '----artcanvas' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.mime}\r\n\r\n`));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// JSON schema for the conversational agent (chat) turns
const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    deliverable: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['none', 'prompts', 'script', 'storyboard', 'images', 'video'] },
        title: { type: 'string' },
        shots: {
          type: 'array',
          items: {
            type: 'object',
            properties: { prompt: { type: 'string' }, caption: { type: 'string' } },
            required: ['prompt', 'caption'],
            additionalProperties: false,
          },
        },
      },
      required: ['kind', 'title', 'shots'],
      additionalProperties: false,
    },
  },
  required: ['reply', 'deliverable'],
  additionalProperties: false,
};

// JSON schema used when a node asks an LLM for a structured shot list
const SHOTS_SCHEMA = {
  type: 'object',
  properties: {
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  },
  required: ['shots'],
  additionalProperties: false,
};

// =====================================================================
// PROVIDER ADAPTERS — each implements the kinds it supports
// =====================================================================
const providers = {
  // ---------------- Anthropic (Claude) ----------------
  anthropic: {
    headers() {
      return {
        'x-api-key': KEYS.anthropic,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      };
    },
    async llm(model, { prompt, system, format, image, images, maxTokens }) {
      const imgs = imagesOf({ image, images });
      let userContent = prompt;
      if (imgs.length) {
        userContent = imgs.map((im) => {
          const parsed = parseDataUrl(im);
          return { type: 'image', source: parsed ? { type: 'base64', media_type: parsed.mime, data: parsed.b64 } : { type: 'url', url: im } };
        });
        userContent.push({ type: 'text', text: prompt });
      }
      const body = {
        model,
        max_tokens: Math.min(16000, maxTokens || 16000),
        messages: [{ role: 'user', content: userContent }],
      };
      if (system) body.system = system;
      if (format === 'json') body.output_config = { format: { type: 'json_schema', schema: SHOTS_SCHEMA } };
      else if (format === 'chat') body.output_config = { format: { type: 'json_schema', schema: CHAT_SCHEMA } };
      const data = await jsonFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: this.headers(), body: JSON.stringify(body),
      });
      if (data.stop_reason === 'refusal') throw apiError('Claude declined this request');
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      if (!text) throw apiError('Claude returned no text');
      return { text };
    },
  },

  // ---------------- OpenAI ----------------
  openai: {
    headers() {
      return { 'Authorization': `Bearer ${KEYS.openai}`, 'Content-Type': 'application/json' };
    },
    async llm(model, { prompt, system, format, image, images, maxTokens }) {
      const imgs = imagesOf({ image, images });
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({
        role: 'user',
        content: imgs.length
          ? [...imgs.map(im => ({ type: 'image_url', image_url: { url: im } })), { type: 'text', text: prompt }]
          : prompt,
      });
      const body = { model, messages };
      if (maxTokens) body.max_completion_tokens = maxTokens;
      if (format) body.response_format = { type: 'json_object' };
      const data = await jsonFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: this.headers(), body: JSON.stringify(body),
      });
      return { text: data.choices[0].message.content };
    },
    async image(model, { prompt, image, images, aspect, quality }) {
      const imgs = imagesOf({ image, images });
      // GPT Image has 3 canvas shapes — pick the closest to the requested ratio
      const rr = parseRatio(aspect);
      const size = !rr || rr.w === rr.h ? '1024x1024' : (rr.w > rr.h ? '1536x1024' : '1024x1536');
      const q = { standard: 'medium', high: 'high', ultra: 'high' }[quality];
      let data;
      if (imgs.length) {
        // image-to-image via the edits endpoint (multipart, up to 9 references)
        const files = [];
        for (let i = 0; i < imgs.length; i++) {
          const { mime, buf } = await fetchImage(imgs[i]);
          files.push({ name: 'image[]', filename: `ref-${i + 1}.png`, mime, data: buf });
        }
        const { body, contentType } = multipart({ model, prompt, size, quality: q }, files);
        data = await jsonFetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${KEYS.openai}`, 'Content-Type': contentType },
          body,
        });
      } else {
        data = await jsonFetch('https://api.openai.com/v1/images/generations', {
          method: 'POST', headers: this.headers(),
          body: JSON.stringify({ model, prompt, n: 1, size, ...(q ? { quality: q } : {}) }),
        });
      }
      const item = data.data[0];
      if (item.b64_json) return { image: `data:image/png;base64,${item.b64_json}` };
      if (item.url) return { image: item.url };
      throw apiError('No image in response');
    },
    async video(model, { prompt, image, images, duration, ratio, quality }) {
      const imgs = imagesOf({ image, images });
      const rr = parseRatio(ratio) || { w: 16, h: 9 };
      const portrait = rr.h > rr.w;
      // higher-res sizes are a Sora Pro feature
      const hi = ['high', 'ultra', '1080p'].includes(quality) && model.includes('pro');
      const size = portrait ? (hi ? '1024x1792' : '720x1280') : (hi ? '1792x1024' : '1280x720');
      let task;
      if (imgs.length) {
        // Sora accepts a single first-frame reference — use the first image
        const { mime, buf } = await fetchImage(imgs[0]);
        const { body, contentType } = multipart(
          { model, prompt, seconds: String(duration || 4), size },
          [{ name: 'input_reference', filename: 'ref.png', mime, data: buf }],
        );
        task = await jsonFetch('https://api.openai.com/v1/videos', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${KEYS.openai}`, 'Content-Type': contentType },
          body,
        });
      } else {
        task = await jsonFetch('https://api.openai.com/v1/videos', {
          method: 'POST', headers: this.headers(),
          body: JSON.stringify({ model, prompt, seconds: String(duration || 4), size }),
        });
      }
      for (let i = 0; i < 120; i++) {
        await sleep(5000);
        const st = await jsonFetch(`https://api.openai.com/v1/videos/${task.id}`, { headers: this.headers() });
        if (st.status === 'completed') {
          const res = await fetch(`https://api.openai.com/v1/videos/${task.id}/content`, { headers: { 'Authorization': `Bearer ${KEYS.openai}` } });
          if (!res.ok) throw apiError(`Video download failed (${res.status})`, res.status);
          const buf = Buffer.from(await res.arrayBuffer());
          return { video: `data:video/mp4;base64,${buf.toString('base64')}` };
        }
        if (st.status === 'failed') throw apiError(st.error?.message || 'Video generation failed');
      }
      throw apiError('Video generation timed out');
    },
  },

  // ---------------- Google Gemini ----------------
  gemini: {
    url(model) {
      return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    },
    headers() {
      return { 'x-goog-api-key': KEYS.gemini, 'Content-Type': 'application/json' };
    },
    async llm(model, { prompt, system, format, image, images, maxTokens }) {
      const parts = [];
      for (const im of imagesOf({ image, images })) {
        const { mime, buf } = await fetchImage(im);
        parts.push({ inline_data: { mime_type: mime, data: buf.toString('base64') } });
      }
      parts.push({ text: prompt });
      const body = { contents: [{ parts }] };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const gen = {};
      if (format) gen.responseMimeType = 'application/json';
      if (maxTokens) gen.maxOutputTokens = maxTokens;
      if (Object.keys(gen).length) body.generationConfig = gen;
      const data = await jsonFetch(this.url(model), {
        method: 'POST', headers: this.headers(), body: JSON.stringify(body),
      });
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      return { text };
    },
    async image(model, { prompt, image, images, aspect, quality }) {
      const parts = [{ text: prompt }];
      for (const im of imagesOf({ image, images })) {
        const { mime, buf } = await fetchImage(im);
        parts.push({ inline_data: { mime_type: mime, data: buf.toString('base64') } });
      }
      // Gemini supports the full ratio list natively, plus 2K/4K output
      const imageConfig = {};
      const rr = parseRatio(aspect);
      if (rr) imageConfig.aspectRatio = rr.str;
      const sizeMap = { high: '2K', ultra: '4K' };
      if (sizeMap[quality]) imageConfig.imageSize = sizeMap[quality];
      const data = await jsonFetch(this.url(model), {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
          },
        }),
      });
      const out = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData || p.inline_data);
      const inline = out?.inlineData || out?.inline_data;
      if (!inline) throw apiError('Gemini returned no image (' + JSON.stringify(data.candidates?.[0]?.finishReason || data).slice(0, 200) + ')');
      return { image: `data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}` };
    },
  },

  // ---------------- Seedance (BytePlus ModelArk) ----------------
  seedance: {
    headers() {
      return { 'Authorization': `Bearer ${KEYS.seedance}`, 'Content-Type': 'application/json' };
    },
    async video(model, { prompt, image, images, duration, ratio, quality }) {
      const rr = parseRatio(ratio);
      const content = [{ type: 'text', text: `${prompt} --ratio ${rr ? rr.str : '16:9'} --duration ${duration || 5} --resolution ${videoRes(quality)}` }];
      for (const im of imagesOf({ image, images })) {
        content.push({ type: 'image_url', image_url: { url: im } });
      }
      const task = await jsonFetch(`${ARK_BASE}/contents/generations/tasks`, {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({ model, content }),
      });
      for (let i = 0; i < 120; i++) {
        await sleep(5000);
        const st = await jsonFetch(`${ARK_BASE}/contents/generations/tasks/${task.id}`, { headers: this.headers() });
        if (st.status === 'succeeded') return { video: st.content?.video_url };
        if (st.status === 'failed' || st.status === 'cancelled') {
          throw apiError(st.error?.message || `Seedance task ${st.status}`);
        }
      }
      throw apiError('Seedance generation timed out');
    },
  },

  // ---------------- Meshy (text/image → 3D) ----------------
  meshy: {
    headers() {
      return { 'Authorization': `Bearer ${KEYS.meshy}`, 'Content-Type': 'application/json' };
    },
    async poll(base, id) {
      for (let i = 0; i < 240; i++) {
        await sleep(5000);
        const st = await jsonFetch(`${base}/${id}`, { headers: this.headers() });
        if (st.status === 'SUCCEEDED') return st;
        if (st.status === 'FAILED' || st.status === 'CANCELED') {
          throw apiError(st.task_error?.message || `Meshy task ${st.status.toLowerCase()}`);
        }
      }
      throw apiError('Meshy generation timed out');
    },
    async threed(model, { prompt, image, artStyle, quality }) {
      let base, task;
      if (image) {
        base = 'https://api.meshy.ai/openapi/v1/image-to-3d';
        task = await jsonFetch(base, {
          method: 'POST', headers: this.headers(),
          body: JSON.stringify({ image_url: image, should_texture: quality !== 'preview', enable_pbr: true }),
        });
      } else {
        if (!prompt) throw apiError('Connect a prompt or an image to the 3D node', 400);
        base = 'https://api.meshy.ai/openapi/v2/text-to-3d';
        task = await jsonFetch(base, {
          method: 'POST', headers: this.headers(),
          body: JSON.stringify({ mode: 'preview', prompt, art_style: artStyle || 'realistic', should_remesh: true }),
        });
      }
      let st = await this.poll(base, task.result);
      // text-to-3D previews are untextured — run the refine pass when asked
      if (!image && quality !== 'preview') {
        const refine = await jsonFetch(base, {
          method: 'POST', headers: this.headers(),
          body: JSON.stringify({ mode: 'refine', preview_task_id: task.result, enable_pbr: true }),
        });
        st = await this.poll(base, refine.result);
      }
      if (!st.model_urls?.glb) throw apiError('Meshy returned no model');
      return { model: st.model_urls.glb, thumbnail: st.thumbnail_url || null };
    },
  },
};

// =====================================================================
// RUN — dispatch a node execution to the right provider
// =====================================================================
async function run(modelId, inputs) {
  const entry = MODELS.find(m => m.id === modelId);
  if (!entry) throw apiError(`Unknown model: ${modelId}`, 400);
  if (!KEYS[entry.provider]) throw apiError(`No API key configured for ${entry.provider} — add it to .env`, 400);
  const provider = providers[entry.provider];
  const fn = provider[entry.kind];
  if (!fn) throw apiError(`${entry.provider} does not support ${entry.kind}`, 400);
  return await fn.call(provider, entry.id, inputs);
}

// ---- HTTP server ----
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const jobs = new Map(); // jobId -> {status, result, error, at}
let jobSeq = 1;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 4e7) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(apiError('Bad JSON', 400)); } });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/models') {
      return json(res, 200, MODELS.map(m => ({ ...m, available: !!KEYS[m.provider] })));
    }
    if (req.method === 'POST' && req.url === '/api/run') {
      const { model, inputs } = await readBody(req);
      if (!model) return json(res, 400, { error: 'model required' });
      // async job queue — long generations (video, 3D) outlive proxy timeouts
      const jobId = 'j' + (jobSeq++).toString(36) + Date.now().toString(36);
      const job = { status: 'running', result: null, error: null, at: Date.now() };
      jobs.set(jobId, job);
      run(model, inputs || {})
        .then(r => { job.status = 'done'; job.result = r; })
        .catch(e => { job.status = 'error'; job.error = e.message || 'Generation failed'; });
      for (const [k, jv] of jobs) if (Date.now() - jv.at > 30 * 60e3) jobs.delete(k);
      return json(res, 200, { jobId });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/jobs/')) {
      const job = jobs.get(req.url.slice('/api/jobs/'.length));
      if (!job) return json(res, 404, { error: 'Job not found (the server may have restarted mid-generation — try again)' });
      return json(res, 200, { status: job.status, result: job.result, error: job.error });
    }
    // ---- projects API (backed by the store: local disk or Supabase) ----
    if (req.method === 'GET' && req.url === '/api/projects') {
      const index = (await store.get('index')) || { list: [] };
      return json(res, 200, { ...index, storage: store.kind });
    }
    const pm = /^\/api\/projects\/([\w-]{1,64})$/.exec(req.url);
    if (pm) {
      const id = pm[1];
      if (req.method === 'GET') {
        const proj = await store.get('proj-' + id);
        return proj ? json(res, 200, proj) : json(res, 404, { error: 'not found' });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!body?.graph) return json(res, 400, { error: 'graph required' });
        await store.put('proj-' + id, { name: body.name || 'Untitled', updatedAt: body.updatedAt || Date.now(), graph: body.graph });
        const index = (await store.get('index')) || { list: [] };
        index.list = index.list.filter(p => p.id !== id);
        index.list.push({ id, name: body.name || 'Untitled', updatedAt: body.updatedAt || Date.now() });
        await store.put('index', index);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        await store.del('proj-' + id);
        const index = (await store.get('index')) || { list: [] };
        index.list = index.list.filter(p => p.id !== id);
        await store.put('index', index);
        return json(res, 200, { ok: true });
      }
    }
    // static files
    let file = req.url.split('?')[0];
    if (file === '/') file = '/index.html';
    const fp = path.join(__dirname, 'public', path.normalize(file).replace(/^([.][.][\\/])+/, ''));
    if (!fp.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      return fs.createReadStream(fp).pipe(res);
    }
    res.writeHead(404); res.end('Not found');
  } catch (err) {
    console.error(err.message);
    json(res, err.status && err.status < 600 ? err.status : 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`ArtCanvas Studio → http://localhost:${PORT}`);
  console.log('Providers configured:', Object.entries(KEYS).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none');
});
