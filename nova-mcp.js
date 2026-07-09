#!/usr/bin/env node
/*
 * Nova MCP server — exposes Nova's asset generation to Claude Code (and other
 * MCP clients) over stdio. Reads keys from Nova's .env; generates 2D art via
 * Gemini (Nano Banana); files assets into a game project by engine.
 *
 * Run as MCP:   node nova-mcp.js
 * Self-test:    node nova-mcp.js selftest <projectDir> [category]
 */
const fs = require('fs');
const path = require('path');

// ---- load Nova's .env (same simple parser as the server) ----
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2];
  }
})();
const KEYS = { gemini: process.env.GEMINI_API_KEY || '' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => process.stderr.write('[nova-mcp] ' + a.join(' ') + '\n'); // never stdout (reserved for JSON-RPC)

function parseRatio(a) { const m = /^(\d+):(\d+)$/.exec(a || ''); return m ? `${m[1]}:${m[2]}` : null; }

// ---- generators (reuse Nova's provider approach) ----
async function genImagePNG(prompt, aspect, refPngs) {
  if (!KEYS.gemini) throw new Error('GEMINI_API_KEY not set in Nova .env');
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image';
  const parts = [{ text: prompt }];
  for (const b of (refPngs || [])) parts.push({ inline_data: { mime_type: 'image/png', data: b.toString('base64') } });
  const gen = { responseModalities: ['IMAGE'] };
  const rr = parseRatio(aspect); if (rr) gen.imageConfig = { aspectRatio: rr };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': KEYS.gemini, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: gen }),
  });
  const data = await res.json();
  const part = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts.find(p => p.inlineData || p.inline_data);
  const inline = part && (part.inlineData || part.inline_data);
  if (!inline) throw new Error('Gemini returned no image: ' + JSON.stringify(data).slice(0, 240));
  return Buffer.from(inline.data, 'base64');
}

// ---- engine detection + asset routing ----
function detectEngine(dir) {
  try {
    const files = fs.readdirSync(dir);
    if (fs.existsSync(path.join(dir, 'project.godot'))) return { engine: 'godot', root: 'art' };
    if (files.some(f => f.endsWith('.uproject'))) return { engine: 'unreal', root: 'Content/NovaArt' };
    if (fs.existsSync(path.join(dir, 'ProjectSettings'))) return { engine: 'unity', root: 'Assets/NovaArt' };
  } catch { /* fall through */ }
  return { engine: 'generic', root: 'nova_art' };
}

// ---- session state ----
const project = { dir: null, engine: null, root: null, manifest: null };
function manifestPath() { return path.join(project.dir, 'nova.assets.json'); }
function loadManifest() { try { project.manifest = JSON.parse(fs.readFileSync(manifestPath(), 'utf8')); } catch { project.manifest = null; } return project.manifest; }
function saveManifest() { if (project.manifest) fs.writeFileSync(manifestPath(), JSON.stringify(project.manifest, null, 2)); }

function setProject(dir, engineOverride) {
  if (!dir || !fs.existsSync(dir)) throw new Error('Project folder not found: ' + dir);
  project.dir = path.resolve(dir);
  const det = detectEngine(project.dir);
  project.engine = engineOverride || det.engine;
  project.root = det.root;
  loadManifest();
  if (project.manifest && project.manifest.assetRoot) project.root = project.manifest.assetRoot.replace(/^res:\/\//, '');
  return { dir: project.dir, engine: project.engine, assetRoot: project.root, manifestAssets: project.manifest ? (project.manifest.assets || []).length : 0 };
}
function assetFile(category, id, ext) {
  const p = path.join(project.dir, project.root, category || 'misc', `${id}.${ext}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}
function styled(prompt) {
  const s = project.manifest && project.manifest.style;
  return s ? `${prompt}. Style: ${s}` : prompt;
}

// generate one asset spec -> writes file, returns { id, path, type }
async function generateAsset(spec) {
  if (!project.dir) throw new Error('No project set. Call set_project first.');
  const id = spec.id || (spec.prompt || 'asset').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
  const category = spec.category || 'images';
  const png = await genImagePNG(styled(spec.prompt), spec.aspect || '1:1');
  const f = assetFile(category, id, 'png'); fs.writeFileSync(f, png);
  return { id, type: 'image', path: f, bytes: png.length };
}
async function generateFromManifest(filter) {
  if (!project.manifest) throw new Error('No nova.assets.json manifest in ' + project.dir);
  let list = project.manifest.assets || [];
  if (filter && filter.category) list = list.filter(a => a.category === filter.category);
  if (filter && filter.ids) list = list.filter(a => filter.ids.includes(a.id));
  const results = [];
  for (const spec of list) {
    try { results.push(await generateAsset(spec)); }
    catch (e) { results.push({ id: spec.id, error: e.message }); }
  }
  return results;
}
function listAssets() {
  const out = { project: project.dir, engine: project.engine, assetRoot: project.root, planned: [], onDisk: [] };
  if (project.manifest) out.planned = (project.manifest.assets || []).map(a => ({ id: a.id, type: a.type || 'image', category: a.category }));
  const rootDir = project.dir && path.join(project.dir, project.root);
  if (rootDir && fs.existsSync(rootDir)) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp); else out.onDisk.push(path.relative(project.dir, fp).replace(/\\/g, '/'));
    });
    walk(rootDir);
  }
  return out;
}

// ================= MCP stdio server (JSON-RPC 2.0, newline-delimited) =================
const TOOLS = [
  { name: 'set_project', description: 'Point Nova at a game project folder. Auto-detects the engine (Godot/Unreal/Unity) and asset root, and loads its nova.assets.json manifest if present.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the game project root' }, engine: { type: 'string', enum: ['godot', 'unreal', 'unity', 'generic'], description: 'Optional override' } }, required: ['path'] } },
  { name: 'list_assets', description: 'List the planned assets (from nova.assets.json) and the asset files already generated on disk.', inputSchema: { type: 'object', properties: {} } },
  { name: 'generate_asset', description: 'Generate one 2D art asset (Nano Banana) and file it into the project.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, prompt: { type: 'string' }, category: { type: 'string', description: 'e.g. towers, enemies, ui, tiles' }, aspect: { type: 'string', description: 'e.g. 1:1, 16:9' } }, required: ['prompt'] } },
  { name: 'generate_assets', description: 'Batch-generate assets from the project manifest (nova.assets.json). Optionally filter by category or ids; otherwise generates all.',
    inputSchema: { type: 'object', properties: { category: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } } } } },
  { name: 'add_asset', description: 'Append an asset spec to the project manifest (does not generate it).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, prompt: { type: 'string' }, type: { type: 'string' }, category: { type: 'string' }, aspect: { type: 'string' } }, required: ['id', 'prompt'] } },
];
async function callTool(name, args) {
  args = args || {};
  if (name === 'set_project') return setProject(args.path, args.engine);
  if (name === 'list_assets') return listAssets();
  if (name === 'generate_asset') return await generateAsset(args);
  if (name === 'generate_assets') return await generateFromManifest(args);
  if (name === 'add_asset') {
    if (!project.manifest) project.manifest = { assets: [] };
    project.manifest.assets = (project.manifest.assets || []).filter(a => a.id !== args.id);
    project.manifest.assets.push({ id: args.id, prompt: args.prompt, type: args.type || 'image', category: args.category, aspect: args.aspect });
    saveManifest();
    return { added: args.id, total: project.manifest.assets.length };
  }
  throw new Error('Unknown tool: ' + name);
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
async function handle(req) {
  const { id, method, params } = req;
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (message, code = -32000) => send({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'nova', version: '1.0.0' } });
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // no response
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const out = await callTool(params && params.name, params && params.arguments);
      return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    }
    if (id !== undefined) fail('Method not found: ' + method, -32601);
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } });
  }
}
function startMcp() {
  log('Nova MCP server ready (stdio). Keys:', Object.entries(KEYS).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) { try { handle(JSON.parse(line)); } catch (e) { log('bad json', e.message); } }
    }
  });
}

// ---- CLI self-test (no MCP): node nova-mcp.js selftest <dir> [category] ----
if (process.argv[2] === 'selftest') {
  (async () => {
    const info = setProject(process.argv[3]);
    log('project:', JSON.stringify(info));
    const res = await generateFromManifest(process.argv[4] ? { category: process.argv[4] } : null);
    log('results:\n' + JSON.stringify(res, null, 2));
    process.exit(0);
  })().catch(e => { log('FAILED: ' + e.message); process.exit(1); });
} else {
  startMcp();
}
