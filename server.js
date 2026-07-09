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
  { id: 'gemini-2.5-flash-lite',                label: 'Gemini Flash Lite',   provider: 'gemini',   kind: 'llm', tier: 'fast' },
  { id: process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image', label: 'Nano Banana Pro', provider: 'gemini', kind: 'image' },
  { id: 'gemini-3.1-flash-image',               label: 'Nano Banana 2',       provider: 'gemini',   kind: 'image' },
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

// =====================================================================
// AUTH & ACCOUNTS — infra-agnostic. Dev login works now; Azure AD (OIDC)
// activates when AUTH_MODE=azure + the AZURE_* env vars are set. Sessions are
// stateless HMAC-signed cookies; accounts + usage live in the `store` adapter.
// =====================================================================
const crypto = require('crypto');
const AUTH_MODE = (process.env.AUTH_MODE || 'dev').toLowerCase(); // 'dev' | 'azure'
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 days (ms)
const DEFAULT_CREDITS = Number(process.env.DEFAULT_CREDITS || 500);
const CREDIT_COST = { image: 1, video: 5, threed: 3, llm: 0 }; // credits per generation kind

// signing secret — from env, else persisted in DATA_DIR so dev logins survive restarts
let SERVER_SECRET = process.env.SERVER_SECRET || '';
if (!SERVER_SECRET) {
  try {
    const sp = path.join(DATA_DIR, '.secret');
    if (fs.existsSync(sp)) SERVER_SECRET = fs.readFileSync(sp, 'utf8');
    else { SERVER_SECRET = crypto.randomBytes(32).toString('hex'); fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(sp, SERVER_SECRET); }
  } catch { SERVER_SECRET = crypto.randomBytes(32).toString('hex'); }
}
const b64u = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
const hmac = (s) => crypto.createHmac('sha256', SERVER_SECRET).update(s).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function signSession(uid) { const p = b64u(JSON.stringify({ uid, exp: Date.now() + SESSION_TTL })); return p + '.' + hmac(p); }
function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [p, sig] = token.split('.');
  if (sig !== hmac(p)) return null;
  try { const d = JSON.parse(unb64u(p)); return (d.exp && d.exp > Date.now()) ? d.uid : null; } catch { return null; }
}
function parseCookies(req) {
  const out = {}; const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function setSessionCookie(res, token) { res.setHeader('Set-Cookie', `nova_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax`); }
function clearSessionCookie(res) { res.setHeader('Set-Cookie', 'nova_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax'); }

async function getAccounts() { return (await store.get('accounts')) || { users: {}, byEmail: {} }; }
async function saveAccounts(a) { await store.put('accounts', a); }
async function getUser(uid) { return uid ? (await getAccounts()).users[uid] || null : null; }
async function findOrCreateUser({ email, name, role }) {
  const a = await getAccounts();
  email = (email || '').toLowerCase().trim();
  if (a.byEmail[email] && a.users[a.byEmail[email]]) {
    const u = a.users[a.byEmail[email]];
    if (name && !u.name) { u.name = name; await saveAccounts(a); }
    return u;
  }
  const uid = 'u' + crypto.randomBytes(6).toString('hex');
  const isFirst = Object.keys(a.users).length === 0;
  a.users[uid] = { id: uid, email, name: name || email.split('@')[0] || 'User', role: role || (isFirst ? 'admin' : 'member'), credits: DEFAULT_CREDITS, used: 0, createdAt: Date.now() };
  a.byEmail[email] = uid;
  await saveAccounts(a);
  return a.users[uid];
}
async function currentUser(req) { return getUser(verifySession(parseCookies(req).nova_session)); }
const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, role: u.role, credits: u.credits, used: u.used, settings: u.settings || {} };
async function recordUsage(uid, kind, modelId) {
  const a = await getAccounts(); const u = a.users[uid]; if (!u) return;
  const cost = CREDIT_COST[kind] ?? 1;
  u.used = (u.used || 0) + cost;
  u.credits = Math.max(0, (u.credits || 0) - cost);
  u.lastActive = Date.now();
  u.usageLog = (u.usageLog || []).slice(-49);
  u.usageLog.push({ at: Date.now(), kind, model: modelId, cost });
  await saveAccounts(a);
}

// ---- Azure AD (OIDC authorization-code flow) — used when AUTH_MODE=azure ----
const AZURE = {
  tenant: process.env.AZURE_TENANT || '',
  clientId: process.env.AZURE_CLIENT_ID || '',
  clientSecret: process.env.AZURE_CLIENT_SECRET || '',
  redirect: process.env.AZURE_REDIRECT || '',
  adminGroup: process.env.AZURE_ADMIN_GROUP || '',
};
function azureAuthorizeUrl(state) {
  const p = new URLSearchParams({ client_id: AZURE.clientId, response_type: 'code', redirect_uri: AZURE.redirect, response_mode: 'query', scope: 'openid profile email', state });
  return `https://login.microsoftonline.com/${AZURE.tenant}/oauth2/v2.0/authorize?${p}`;
}
async function azureExchange(code) {
  const body = new URLSearchParams({ client_id: AZURE.clientId, client_secret: AZURE.clientSecret, code, redirect_uri: AZURE.redirect, grant_type: 'authorization_code', scope: 'openid profile email' });
  const r = await fetch(`https://login.microsoftonline.com/${AZURE.tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await r.json();
  if (!data.id_token) throw apiError('Azure token exchange failed', 401);
  // TODO(prod): validate id_token signature against the tenant JWKS before trusting claims
  const claims = JSON.parse(unb64u(data.id_token.split('.')[1]));
  return { email: claims.email || claims.preferred_username || claims.upn, name: claims.name };
}

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
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.fbx': 'application/octet-stream', '.obj': 'text/plain', '.map': 'application/json',
};
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
    const urlPath = req.url.split('?')[0];
    const uid = verifySession(parseCookies(req).nova_session);

    // ---- auth routes (always accessible) ----
    if (urlPath === '/api/auth/me') return json(res, 200, { user: publicUser(await getUser(uid)), authMode: AUTH_MODE });
    if (urlPath === '/api/auth/logout') { clearSessionCookie(res); return json(res, 200, { ok: true }); }
    if (urlPath === '/api/auth/settings' && req.method === 'POST') {
      if (!uid) return json(res, 401, { error: 'Not signed in' });
      const { name, settings } = await readBody(req);
      const a = await getAccounts(); const u = a.users[uid];
      if (!u) return json(res, 401, { error: 'Not signed in' });
      if (typeof name === 'string' && name.trim()) u.name = name.trim().slice(0, 60);
      if (settings && typeof settings === 'object') u.settings = { ...(u.settings || {}), ...settings };
      await saveAccounts(a);
      return json(res, 200, { user: publicUser(u) });
    }
    if (urlPath === '/api/auth/login' && req.method === 'POST') {
      if (AUTH_MODE !== 'dev') return json(res, 403, { error: 'Password login is disabled — use SSO' });
      const { email, name } = await readBody(req);
      if (!email) return json(res, 400, { error: 'email required' });
      const u = await findOrCreateUser({ email, name });
      setSessionCookie(res, signSession(u.id));
      return json(res, 200, { user: publicUser(u) });
    }
    if (urlPath === '/auth/login') { // SSO entry
      if (AUTH_MODE === 'azure') { res.writeHead(302, { Location: azureAuthorizeUrl('nova') }); return res.end(); }
      res.writeHead(302, { Location: '/login.html' }); return res.end();
    }
    if (urlPath === '/auth/callback') { // SSO return
      try {
        const code = new URL(req.url, 'http://localhost').searchParams.get('code');
        const u = await findOrCreateUser(await azureExchange(code));
        setSessionCookie(res, signSession(u.id));
      } catch (e) { console.error('SSO callback failed:', e.message); }
      res.writeHead(302, { Location: '/' }); return res.end();
    }

    // ---- admin portal API (admins only) ----
    if (urlPath.startsWith('/api/admin/')) {
      const me = await getUser(uid);
      if (!me || me.role !== 'admin') return json(res, 403, { error: 'Admins only' });
      const a = await getAccounts();
      const adminCount = () => Object.values(a.users).filter(x => x.role === 'admin').length;
      if (urlPath === '/api/admin/users' && req.method === 'GET') {
        const users = Object.values(a.users).map(u => ({
          id: u.id, email: u.email, name: u.name, role: u.role,
          credits: u.credits || 0, used: u.used || 0, createdAt: u.createdAt, lastActive: u.lastActive || null,
        })).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
        const totals = { users: users.length, used: users.reduce((s, u) => s + u.used, 0), credits: users.reduce((s, u) => s + u.credits, 0) };
        return json(res, 200, { users, totals });
      }
      if (urlPath === '/api/admin/invite' && req.method === 'POST') {
        const { email, name, credits } = await readBody(req);
        if (!email) return json(res, 400, { error: 'email required' });
        const u = await findOrCreateUser({ email, name });
        if (typeof credits === 'number') { const a2 = await getAccounts(); a2.users[u.id].credits = Math.max(0, credits | 0); await saveAccounts(a2); }
        return json(res, 200, { ok: true });
      }
      const um = /^\/api\/admin\/user\/([\w-]+)$/.exec(urlPath);
      if (um) {
        const t = a.users[um[1]];
        if (!t) return json(res, 404, { error: 'not found' });
        if (req.method === 'POST') {
          const b = await readBody(req);
          if (typeof b.credits === 'number') t.credits = Math.max(0, b.credits | 0);
          if (typeof b.addCredits === 'number') t.credits = Math.max(0, (t.credits || 0) + (b.addCredits | 0));
          if (b.role === 'admin' || b.role === 'member') {
            if (b.role === 'member' && t.role === 'admin' && adminCount() <= 1) return json(res, 400, { error: 'Cannot demote the last admin' });
            t.role = b.role;
          }
          await saveAccounts(a);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          if (t.role === 'admin' && adminCount() <= 1) return json(res, 400, { error: 'Cannot delete the last admin' });
          delete a.byEmail[t.email]; delete a.users[um[1]];
          await saveAccounts(a);
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: 'unknown admin route' });
    }

    // ---- gate everything else behind a session ----
    const publicStatic = urlPath === '/login.html' || urlPath.startsWith('/director') ||
      /\.(css|js|mjs|svg|png|jpe?g|webp|gif|ico|glb|gltf|bin|wasm|woff2?|ttf|map)$/i.test(urlPath);
    if (!uid && !publicStatic) {
      if (urlPath.startsWith('/api/')) return json(res, 401, { error: 'Not signed in' });
      res.writeHead(302, { Location: '/login.html' }); return res.end();
    }

    if (req.method === 'GET' && req.url === '/api/models') {
      return json(res, 200, MODELS.map(m => ({ ...m, available: !!KEYS[m.provider] })));
    }
    if (req.method === 'POST' && req.url === '/api/run') {
      const { model, inputs } = await readBody(req);
      if (!model) return json(res, 400, { error: 'model required' });
      // per-generation quota: charge credits by the model's kind
      const entry = MODELS.find(m => m.id === model);
      const kind = entry?.kind || 'image';
      const cost = CREDIT_COST[kind] ?? 1;
      const me = await getUser(uid);
      if (!me) return json(res, 401, { error: 'Not signed in' });
      if (cost > 0 && (me.credits || 0) < cost) {
        return json(res, 402, { error: `Out of credits — this ${kind} costs ${cost}, you have ${me.credits}. Ask an admin to top up.` });
      }
      // async job queue — long generations (video, 3D) outlive proxy timeouts
      const jobId = 'j' + (jobSeq++).toString(36) + Date.now().toString(36);
      const job = { status: 'running', result: null, error: null, at: Date.now() };
      jobs.set(jobId, job);
      run(model, inputs || {})
        .then(r => { job.status = 'done'; job.result = r; if (cost > 0) recordUsage(uid, kind, model); })
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
    // project keys are namespaced per user (multi-tenant)
    const pfx = 'u/' + uid + '/';
    if (req.method === 'GET' && req.url === '/api/projects') {
      const index = (await store.get(pfx + 'index')) || { list: [] };
      return json(res, 200, { ...index, storage: store.kind });
    }
    const pm = /^\/api\/projects\/([\w-]{1,64})$/.exec(req.url.split('?')[0]);
    if (pm) {
      const id = pm[1];
      if (req.method === 'GET') {
        const proj = await store.get(pfx + 'proj-' + id);
        return proj ? json(res, 200, proj) : json(res, 404, { error: 'not found' });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!body?.graph) return json(res, 400, { error: 'graph required' });
        await store.put(pfx + 'proj-' + id, { name: body.name || 'Untitled', updatedAt: body.updatedAt || Date.now(), graph: body.graph });
        const index = (await store.get(pfx + 'index')) || { list: [] };
        index.list = index.list.filter(p => p.id !== id);
        index.list.push({ id, name: body.name || 'Untitled', updatedAt: body.updatedAt || Date.now() });
        await store.put(pfx + 'index', index);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        await store.del(pfx + 'proj-' + id);
        const index = (await store.get(pfx + 'index')) || { list: [] };
        index.list = index.list.filter(p => p.id !== id);
        await store.put(pfx + 'index', index);
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

// =====================================================================
// REAL-TIME COLLABORATION — minimal RFC6455 WebSocket server (no deps).
// Rooms are keyed by a project's share id. Presence + live cursors +
// last-write-wins graph sync; the room's graph persists to `shared-<id>`.
// =====================================================================
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const COLLAB_COLORS = ['#19c6d6', '#ff8a5c', '#a78bfa', '#5eead4', '#f0c542', '#f472b6', '#4ade80', '#60a5fa'];
const rooms = new Map(); // roomId -> { graph, name, clients:Set, saveTimer }
function roomOf(id) { if (!rooms.has(id)) rooms.set(id, { graph: null, name: 'Shared project', clients: new Set(), saveTimer: null }); return rooms.get(id); }

function wsEncode(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x81, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  return Buffer.concat([header, payload]);
}
function wsSend(sock, obj) { try { sock.write(wsEncode(JSON.stringify(obj))); } catch { /* closed */ } }

server.on('upgrade', async (req, sock) => {
  try {
    const key = req.headers['sec-websocket-key'];
    const uid = verifySession(parseCookies(req).nova_session);
    const roomId = new URL(req.url, 'http://localhost').searchParams.get('room');
    if (!key || !uid || !roomId) { sock.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

    const user = await getUser(uid);
    const room = roomOf(roomId);
    if (room.graph === null) { const saved = await store.get('shared-' + roomId); if (saved) { room.graph = saved.graph; room.name = saved.name || room.name; } }
    const client = { sock, uid, name: user?.name || 'User', color: COLLAB_COLORS[room.clients.size % COLLAB_COLORS.length], cursor: null };
    room.clients.add(client);

    const roster = () => [...room.clients].map(c => ({ id: c.uid, name: c.name, color: c.color }));
    const broadcast = (obj, except) => { for (const c of room.clients) if (c !== except) wsSend(c.sock, obj); };

    wsSend(sock, { t: 'init', graph: room.graph, you: { id: uid, name: client.name, color: client.color } });
    broadcast({ t: 'roster', roster: roster() });

    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = buf.readUInt32BE(6); off = 10; }
        const need = off + (masked ? 4 : 0) + len;
        if (buf.length < need) break;
        let payload;
        if (masked) { const mask = buf.slice(off, off + 4); payload = buf.slice(off + 4, off + 4 + len); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
        else payload = buf.slice(off, off + len);
        buf = buf.slice(need);
        if (op === 0x8) { sock.end(); return; }        // close
        if (op === 0x9) { sock.write(Buffer.from([0x8a, 0])); continue; } // ping -> pong
        if (op !== 0x1) continue;                        // only text frames
        let msg; try { msg = JSON.parse(payload.toString()); } catch { continue; }
        if (msg.t === 'cursor') { client.cursor = { x: msg.x, y: msg.y }; broadcast({ t: 'cursor', id: uid, name: client.name, color: client.color, x: msg.x, y: msg.y }, client); }
        else if (msg.t === 'graph') {
          room.graph = msg.graph;
          broadcast({ t: 'graph', graph: msg.graph, from: uid }, client);
          clearTimeout(room.saveTimer);
          room.saveTimer = setTimeout(() => store.put('shared-' + roomId, { graph: room.graph, name: room.name, updatedAt: Date.now() }).catch(() => {}), 800);
        }
      }
    });
    const bye = () => { room.clients.delete(client); broadcast({ t: 'roster', roster: roster() }); broadcast({ t: 'left', id: uid }); if (!room.clients.size) { /* keep graph persisted */ } };
    sock.on('close', bye);
    sock.on('error', bye);
  } catch { try { sock.destroy(); } catch {} }
});

server.listen(PORT, () => {
  console.log(`Nova (Behaviour NASA) → http://localhost:${PORT}`);
  console.log('Providers configured:', Object.entries(KEYS).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none');
});
