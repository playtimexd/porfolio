// ArtCanvas Studio — Weavy-style node editor
// Graph state ---------------------------------------------------------
const nodes = new Map();   // id -> {id, type, x, y, data, out, el}
let edges = [];            // {id, from:{node,port}, to:{node,port}, type}
let idCounter = 1;
let panX = 0, panY = 0, zoom = 1;
let MODELS = [];

const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const nodesLayer = document.getElementById('nodes-layer');
const edgesSvg = document.getElementById('edges-svg');
const zoomLabel = document.getElementById('zoom-label');
const propsBody = document.getElementById('props-body');
const propsTitle = document.getElementById('props-title');

const TYPE_COLORS = { text: '#b98aff', image: '#4cc9f0', video: '#ff9e64', model: '#6ef0d2', any: '#97979f' };

// aspect-ratio & quality options (Weavy-style ranges; mapped per provider server-side)
const RATIO_OPTS = [
  ['auto', 'Default'], ['21:9', '21:9'], ['16:9', '16:9'], ['3:2', '3:2'], ['4:3', '4:3'],
  ['5:4', '5:4'], ['1:1', '1:1'], ['4:5', '4:5'], ['3:4', '3:4'], ['2:3', '2:3'], ['9:16', '9:16'],
];
const VIDEO_RATIO_OPTS = [['16:9', '16:9'], ['21:9', '21:9'], ['4:3', '4:3'], ['1:1', '1:1'], ['3:4', '3:4'], ['9:16', '9:16']];
const QUALITY_OPTS = [['auto', 'Auto'], ['standard', 'Standard (1K)'], ['high', 'High (2K)'], ['ultra', 'Ultra (4K)']];
const VIDEO_QUALITY_OPTS = [['auto', 'Auto'], ['720p', '720p'], ['1080p', '1080p']];
// old projects stored square/landscape/portrait — upgrade in place
function normRatio(node, key) {
  const legacy = { square: '1:1', landscape: '3:2', portrait: '2:3' };
  if (legacy[node.data[key]]) node.data[key] = legacy[node.data[key]];
}
const v = (input) => input?.value;
const runningNodes = new Set();

// Node type definitions ------------------------------------------------
const NODE_TYPES = {
  prompt: {
    title: 'Prompt', color: '#b98aff', desc: 'text',
    inputs: [], outputs: [{ name: 'text', type: 'text' }],
    defaults: () => ({ text: '' }),
    sub: (n) => n.data.text ? '' : 'empty',
    media(node) {
      const ta = el('textarea', { class: 'node-ta', placeholder: 'Type your prompt here…' });
      ta.value = node.data.text || '';
      ta.addEventListener('input', () => {
        node.data.text = ta.value;
        // auto-grow with the content (up to a sane cap)
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 600) + 'px';
        updateHead(node);
        save();
        // keep the properties panel in sync if this node is selected there
        if (selected?.kind === 'node' && selected.id === node.id) {
          const pta = propsBody.querySelector('textarea');
          if (pta && pta.value !== ta.value) pta.value = ta.value;
        }
      });
      return ta;
    },
    props(node, box) {
      box.appendChild(el('label', {}, 'Prompt'));
      const ta = el('textarea', { placeholder: 'Describe what to create…' });
      ta.value = node.data.text || '';
      ta.addEventListener('input', () => { node.data.text = ta.value; refreshMedia(node); save(); });
      box.appendChild(ta);
    },
    async exec(node) {
      if (!node.data.text?.trim()) throw new Error('Prompt is empty');
      return { text: { type: 'text', value: node.data.text.trim() } };
    },
  },

  imageModel: {
    title: 'Image', color: '#4cc9f0', desc: 'prompt → image',
    inputs: [{ name: 'prompt', type: 'text' }, { name: 'image', type: 'image', optional: true, multi: 9 }],
    outputs: [{ name: 'image', type: 'image' }],
    defaults: () => ({ model: '', aspect: 'auto', quality: 'auto', refs: [] }),
    sub: (n) => modelLabel(n.data.model),
    media(node) {
      if (node.out.media) return mediaEl(node.out.media);
      return el('div', { class: 'placeholder' }, 'No image yet — connect a prompt and run');
    },
    props(node, box) {
      normRatio(node, 'aspect');
      box.appendChild(el('label', {}, 'Model'));
      box.appendChild(modelSelect(node, 'image'));
      const row = el('div', { class: 'row' });
      const c1 = el('div');
      c1.appendChild(el('label', {}, 'Aspect ratio'));
      c1.appendChild(selectCtl(node, 'aspect', RATIO_OPTS));
      const c2 = el('div');
      c2.appendChild(el('label', {}, 'Quality'));
      c2.appendChild(selectCtl(node, 'quality', QUALITY_OPTS));
      row.appendChild(c1); row.appendChild(c2);
      box.appendChild(row);
      box.appendChild(el('div', { class: 'mini-hint' }, 'Gemini honours every ratio + 2K/4K; GPT Image maps to its nearest canvas.'));
      refControl(node, box, false);
      actionRow(node, box);
    },
    async exec(node, inputs) {
      const refImgs = (node.data.refs || []).filter(r => r.kind === 'image').map(r => r.src);
      const r = await api(node.data.model, {
        prompt: v(inputs.prompt),
        images: [...(inputs.image || []).map(v).filter(Boolean), ...refImgs].slice(0, 9),
        aspect: node.data.aspect,
        quality: node.data.quality,
      });
      node.out.media = { kind: 'image', src: r.image };
      addAsset('image', r.image, v(inputs.prompt));
      refreshMedia(node);
      return { image: { type: 'image', value: r.image } };
    },
  },

  videoModel: {
    title: 'Video', color: '#ff9e64', desc: 'prompt → video',
    inputs: [{ name: 'prompt', type: 'text' }, { name: 'image', type: 'image', optional: true, multi: 9 }],
    outputs: [{ name: 'video', type: 'video' }],
    defaults: () => ({ model: '', duration: '5', ratio: '16:9', quality: 'auto', refs: [] }),
    sub: (n) => modelLabel(n.data.model),
    media(node) {
      if (node.out.media) return mediaEl(node.out.media);
      return el('div', { class: 'placeholder' }, 'No video yet — generation can take minutes');
    },
    props(node, box) {
      box.appendChild(el('label', {}, 'Model'));
      box.appendChild(modelSelect(node, 'video'));
      const row = el('div', { class: 'row' });
      const c1 = el('div'); c1.appendChild(el('label', {}, 'Duration')); c1.appendChild(selectCtl(node, 'duration', [['4', '4s'], ['5', '5s'], ['8', '8s'], ['10', '10s']]));
      const c2 = el('div'); c2.appendChild(el('label', {}, 'Ratio')); c2.appendChild(selectCtl(node, 'ratio', VIDEO_RATIO_OPTS));
      const c3 = el('div'); c3.appendChild(el('label', {}, 'Quality')); c3.appendChild(selectCtl(node, 'quality', VIDEO_QUALITY_OPTS));
      row.appendChild(c1); row.appendChild(c2); row.appendChild(c3);
      box.appendChild(row);
      box.appendChild(el('div', { class: 'mini-hint' }, '1080p-class output needs Sora 2 Pro or Seedance; Sora 2 runs at 720p.'));
      refControl(node, box, true);
      actionRow(node, box);
    },
    async exec(node, inputs) {
      const refImgs = (node.data.refs || []).filter(r => r.kind === 'image').map(r => r.src);
      const refVid = (node.data.refs || []).find(r => r.kind === 'video')?.src;
      const r = await api(node.data.model, {
        prompt: v(inputs.prompt),
        images: [...(inputs.image || []).map(v).filter(Boolean), ...refImgs].slice(0, 9),
        video: refVid,
        duration: node.data.duration,
        ratio: node.data.ratio,
        quality: node.data.quality,
      });
      node.out.media = { kind: 'video', src: r.video };
      addAsset('video', r.video, v(inputs.prompt));
      refreshMedia(node);
      return { video: { type: 'video', value: r.video } };
    },
  },

  threeD: {
    title: '3D Model', color: '#6ef0d2', desc: 'prompt/image → 3D',
    inputs: [{ name: 'prompt', type: 'text', optional: true }, { name: 'image', type: 'image', optional: true }],
    outputs: [{ name: 'model', type: 'model' }],
    defaults: () => ({ model: '', artStyle: 'realistic', quality: 'preview' }),
    sub: (n) => modelLabel(n.data.model),
    media(node) {
      if (node.out.media) return mediaEl(node.out.media);
      return el('div', { class: 'placeholder' }, 'No 3D model yet — generation takes a few minutes. Connect a prompt (text-to-3D) or an image (image-to-3D).');
    },
    props(node, box) {
      box.appendChild(el('label', {}, 'Model'));
      box.appendChild(modelSelect(node, 'threed'));
      const row = el('div', { class: 'row' });
      const c1 = el('div');
      c1.appendChild(el('label', {}, 'Art style'));
      c1.appendChild(selectCtl(node, 'artStyle', [['realistic', 'Realistic'], ['sculpture', 'Sculpture']]));
      const c2 = el('div');
      c2.appendChild(el('label', {}, 'Quality'));
      c2.appendChild(selectCtl(node, 'quality', [['preview', 'Preview (fast)'], ['textured', 'Textured (slower)']]));
      row.appendChild(c1); row.appendChild(c2);
      box.appendChild(row);
      box.appendChild(el('div', { class: 'mini-hint' }, 'Textured runs Meshy’s refine pass — better result, more credits. Drag the preview to rotate it.'));
      actionRow(node, box);
    },
    async exec(node, inputs) {
      const prompt = v(inputs.prompt);
      const image = v(inputs.image);
      if (!prompt && !image) throw new Error('Connect a prompt or an image');
      setState(node, 'running', 'Sculpting… this takes a few minutes');
      const r = await api(node.data.model, { prompt, image, artStyle: node.data.artStyle, quality: node.data.quality });
      node.out.media = { kind: 'model', src: r.model, poster: r.thumbnail };
      addAsset('model', r.model, prompt || '3D from image', r.thumbnail);
      refreshMedia(node);
      return { model: { type: 'model', value: r.model } };
    },
  },

  upload: {
    title: 'Upload', color: '#6ee7a0', desc: 'image',
    inputs: [], outputs: [{ name: 'image', type: 'image' }],
    defaults: () => ({ image: null }),
    sub: (n) => n.data.image ? 'image' : 'empty',
    media(node) {
      if (node.data.image) return mediaEl({ kind: 'image', src: node.data.image });
      return el('div', { class: 'placeholder' }, 'Choose a file in the panel →');
    },
    props(node, box) {
      box.appendChild(el('label', {}, 'Image file'));
      const inp = el('input', { type: 'file', accept: 'image/*' });
      inp.addEventListener('change', () => {
        const f = inp.files[0];
        if (!f) return;
        const fr = new FileReader();
        fr.onload = () => { node.data.image = fr.result; refreshMedia(node); updateHead(node); save(); };
        fr.readAsDataURL(f);
      });
      box.appendChild(inp);
    },
    async exec(node) {
      if (!node.data.image) throw new Error('No image uploaded');
      return { image: { type: 'image', value: node.data.image } };
    },
  },

};

// Small helpers ---------------------------------------------------------
function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val);
  if (text !== undefined) e.textContent = text;
  return e;
}

function modelLabel(id) {
  return MODELS.find(m => m.id === id)?.label || id || '';
}

function mediaEl(media) {
  let m;
  if (media.kind === 'video') {
    m = el('video', { src: media.src, controls: '', loop: '' });
    m.muted = true; m.autoplay = true;
    m.addEventListener('loadedmetadata', () => { redrawEdges(); drawMinimap(); });
  } else if (media.kind === 'model') {
    if (window.customElements?.get('model-viewer')) {
      m = el('model-viewer', {
        src: media.src, 'camera-controls': '', 'auto-rotate': '', 'shadow-intensity': '1',
        style: 'width:100%;height:190px;background:#141418;display:block',
      });
      if (media.poster) m.setAttribute('poster', media.poster);
    } else if (media.poster) {
      m = el('img', { src: media.poster, title: '3D preview (viewer unavailable offline) — download for the full model' });
      m.addEventListener('load', () => { redrawEdges(); drawMinimap(); });
    } else {
      m = el('div', { class: 'placeholder' }, '🧊 3D model ready — use ⬇ Save to download the .glb');
    }
  } else {
    m = el('img', { src: media.src });
    m.addEventListener('load', () => { redrawEdges(); drawMinimap(); });
  }
  // Wrap images & videos with an expand button that opens the full-size lightbox.
  if (media.kind === 'image' || media.kind === 'video') {
    const wrap = el('div', { class: 'media-wrap' });
    wrap.appendChild(m);
    const exp = el('button', { class: 'media-expand', title: 'Expand — view full size' }, '⤢');
    exp.addEventListener('pointerdown', (e) => e.stopPropagation());
    exp.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(media); });
    wrap.appendChild(exp);
    return wrap;
  }
  return m;
}

// Full-size media viewer (lightbox) -----------------------------------------
function openLightbox(media) {
  let box = document.getElementById('lightbox');
  if (!box) {
    box = el('div', { id: 'lightbox' });
    box.addEventListener('click', (e) => { if (e.target === box) closeLightbox(); });
    document.body.appendChild(box);
  }
  box.innerHTML = '';
  const close = el('button', { class: 'lb-close', title: 'Close (Esc)' }, '✕');
  close.addEventListener('click', closeLightbox);
  box.appendChild(close);
  let content;
  if (media.kind === 'video') {
    content = el('video', { class: 'lb-media', src: media.src, controls: '', loop: '', autoplay: '' });
  } else {
    content = el('img', { class: 'lb-media', src: media.src, title: 'Click to toggle actual size' });
    content.addEventListener('click', (e) => { e.stopPropagation(); content.classList.toggle('zoomed'); });
  }
  box.appendChild(content);
  if (media.kind === 'image') {
    const edit = el('button', { class: 'lb-edit', title: 'Edit this image' }, '✎ Edit');
    edit.addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); openImageEditor(media.src); });
    box.appendChild(edit);
  }
  const dl = el('a', { class: 'lb-dl', href: media.src, download: 'artcanvas-full.' + (media.kind === 'video' ? 'mp4' : 'png') }, '⬇ Download');
  if (!media.src.startsWith('data:')) dl.target = '_blank';
  dl.addEventListener('click', (e) => e.stopPropagation());
  box.appendChild(dl);
  box.hidden = false;
}
function closeLightbox() {
  const box = document.getElementById('lightbox');
  if (box) { box.hidden = true; box.innerHTML = ''; }
}

// =====================================================================
// IMAGE EDITOR (Lovart-style) — AI edits via Nano Banana img2img + local canvas tools
// =====================================================================
let imgEditor = null;
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; });

function editorImageModelId() {
  if (chatCfg.imageModel && MODELS.some(m => m.id === chatCfg.imageModel && m.available)) return chatCfg.imageModel;
  return MODELS.find(m => m.kind === 'image' && m.available)?.id || '';
}

function openImageEditor(src) {
  buildImageEditor();
  imgEditor.src = src;
  imgEditor.history = [];
  imgEditor.mode = null;
  setEditorStatus('');
  renderEditorImage();
  imgEditor.overlay.hidden = false;
}
function closeImageEditor() { if (imgEditor) imgEditor.overlay.hidden = true; }

function buildImageEditor() {
  if (imgEditor?.overlay) return;
  const overlay = el('div', { id: 'img-editor', hidden: '' });

  const bar = el('div', { class: 'ie-bar' });
  bar.appendChild(el('span', { class: 'ie-title' }, '✎ Image editor'));
  const status = el('span', { class: 'ie-status' });
  bar.appendChild(status);
  const closeBtn = el('button', { class: 'ie-close', title: 'Close (Esc)' }, '✕');
  closeBtn.addEventListener('click', closeImageEditor);
  bar.appendChild(closeBtn);
  overlay.appendChild(bar);

  const body = el('div', { class: 'ie-body' });
  // Tool rail
  const rail = el('div', { class: 'ie-rail' });
  const grp = (label) => { rail.appendChild(el('div', { class: 'ie-grp' }, label)); };
  const tool = (label, fn) => { const b = el('button', { class: 'ie-tool' }, label); b.addEventListener('click', fn); rail.appendChild(b); return b; };

  grp('AI edit (Nano Banana)');
  tool('🪄 Quick edit', () => { imgEditor.promptEl.focus(); });
  tool('🧩 Edit elements', () => setPrompt('Change the following element: '));
  tool('🔤 Edit text', () => setPrompt('Replace the text in the image with: '));
  tool('🖼 Mockup', () => setPrompt('Place this design as a realistic mockup on: '));
  tool('↔ Expand / uncrop', () => aiEdit('Expand and outpaint the scene naturally on all sides, keeping the existing content centered and consistent.', {}));
  tool('🧭 Multi-angle', () => multiAngle());
  tool('✂ Remove background', () => aiEdit('Remove the background completely. Keep only the main subject, cleanly cut out on a plain white background.', {}));
  tool('🔺 Vectorize', () => aiEdit('Redraw as a clean flat vector illustration: smooth shapes, solid colors, crisp edges, no photographic texture.', {}));
  tool('⬆ Upscale 2K', () => aiEdit('Upscale to higher resolution. Enhance fine detail and sharpness. Do NOT change the content, colors or composition.', { quality: 'high' }));
  tool('⬆ Upscale 4K', () => aiEdit('Upscale to maximum resolution. Enhance fine detail and sharpness. Do NOT change the content, colors or composition.', { quality: 'ultra' }));

  grp('Adjust (local)');
  tool('↺ Rotate left', () => transformCanvas(rotateFn(-1)));
  tool('↻ Rotate right', () => transformCanvas(rotateFn(1)));
  tool('⇋ Flip horizontal', () => transformCanvas(flipFn(true)));
  tool('⇵ Flip vertical', () => transformCanvas(flipFn(false)));
  tool('⛶ Crop', () => toggleCrop());
  tool('🩹 Eraser', () => toggleErase());
  tool('🎚 Adjust colors', () => toggleAdjust());
  body.appendChild(rail);

  // Stage
  const stageWrap = el('div', { class: 'ie-stage' });
  const canvas = el('canvas', { class: 'ie-canvas' });
  stageWrap.appendChild(canvas);
  const cropRect = el('div', { class: 'ie-crop', hidden: '' });
  stageWrap.appendChild(cropRect);
  body.appendChild(stageWrap);
  overlay.appendChild(body);

  // Adjust panel (hidden until toggled)
  const adj = el('div', { class: 'ie-adjust', hidden: '' });
  const mkSlider = (name, min, max, val) => {
    const row = el('label', { class: 'ie-slider' });
    row.appendChild(el('span', {}, name));
    const s = el('input', { type: 'range', min, max, value: val });
    row.appendChild(s);
    adj.appendChild(row);
    return s;
  };
  const sB = mkSlider('Brightness', '50', '150', '100');
  const sC = mkSlider('Contrast', '50', '150', '100');
  const sS = mkSlider('Saturation', '0', '200', '100');
  const applyAdj = el('button', { class: 'ie-apply' }, 'Apply');
  const previewAdj = () => { canvas.style.filter = `brightness(${sB.value}%) contrast(${sC.value}%) saturate(${sS.value}%)`; };
  [sB, sC, sS].forEach(s => s.addEventListener('input', previewAdj));
  applyAdj.addEventListener('click', async () => {
    await transformCanvas((img) => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d');
      x.filter = `brightness(${sB.value}%) contrast(${sC.value}%) saturate(${sS.value}%)`;
      x.drawImage(img, 0, 0);
      return c;
    });
    canvas.style.filter = ''; sB.value = sC.value = 100; sS.value = 100; adj.hidden = true;
  });
  adj.appendChild(applyAdj);
  overlay.appendChild(adj);

  // Prompt bar
  const promptBar = el('form', { class: 'ie-prompt' });
  const promptEl = el('input', { type: 'text', placeholder: 'Describe an edit — e.g. “make it night time”, “add a red hat”…' });
  const go = el('button', { type: 'submit', class: 'ie-go' }, 'Apply edit');
  promptBar.appendChild(promptEl); promptBar.appendChild(go);
  promptBar.addEventListener('submit', (e) => { e.preventDefault(); const t = promptEl.value.trim(); if (t) aiEdit(t, {}); });
  overlay.appendChild(promptBar);

  // Footer actions
  const foot = el('div', { class: 'ie-foot' });
  const undo = el('button', {}, '↶ Undo');
  undo.addEventListener('click', undoEditor);
  const toCanvasBtn = el('button', { class: 'primary' }, '＋ Save to canvas');
  toCanvasBtn.addEventListener('click', () => {
    const r = viewport.getBoundingClientRect();
    addNode('upload', (r.width / 2 - panX) / zoom - 130, (r.height / 2 - panY) / zoom - 90, { image: imgEditor.src, title: 'Image' });
    addAsset('image', imgEditor.src, 'edited image');
    toast('Edited image added to the canvas');
  });
  const dl = el('a', {}, '⬇ Download');
  dl.addEventListener('click', () => { dl.href = imgEditor.src; dl.download = 'artcanvas-edited.png'; });
  foot.appendChild(undo); foot.appendChild(toCanvasBtn); foot.appendChild(dl);
  overlay.appendChild(foot);

  document.body.appendChild(overlay);
  imgEditor = { overlay, canvas, ctx: canvas.getContext('2d'), stageWrap, cropRect, statusEl: status, promptEl, adj, previewAdj, src: null, history: [], mode: null, busy: false };
  wireCropAndErase();
}

function setPrompt(t) { imgEditor.promptEl.value = t; imgEditor.promptEl.focus(); imgEditor.promptEl.setSelectionRange(t.length, t.length); }
function setEditorStatus(t, busy) { imgEditor.statusEl.textContent = t; imgEditor.overlay.classList.toggle('busy', !!busy); }
function pushHistory() { if (imgEditor.src) imgEditor.history.push(imgEditor.src); if (imgEditor.history.length > 20) imgEditor.history.shift(); }
function undoEditor() { if (!imgEditor.history.length) { toast('Nothing to undo'); return; } imgEditor.src = imgEditor.history.pop(); renderEditorImage(); }

async function renderEditorImage() {
  const img = await loadImage(imgEditor.src);
  imgEditor.canvas.width = img.naturalWidth; imgEditor.canvas.height = img.naturalHeight;
  imgEditor.ctx.clearRect(0, 0, img.naturalWidth, img.naturalHeight);
  imgEditor.ctx.drawImage(img, 0, 0);
}

async function transformCanvas(fn) {
  const img = await loadImage(imgEditor.src);
  const c = fn(img);
  pushHistory();
  imgEditor.src = c.toDataURL('image/png');
  renderEditorImage();
}
const rotateFn = (dir) => (img) => {
  const c = document.createElement('canvas'); c.width = img.height; c.height = img.width;
  const x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(dir * Math.PI / 2);
  x.drawImage(img, -img.width / 2, -img.height / 2); return c;
};
const flipFn = (horiz) => (img) => {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const x = c.getContext('2d'); x.translate(horiz ? c.width : 0, horiz ? 0 : c.height); x.scale(horiz ? -1 : 1, horiz ? 1 : -1);
  x.drawImage(img, 0, 0); return c;
};

async function aiEdit(instruction, opts) {
  if (imgEditor.busy) return;
  const model = editorImageModelId();
  if (!model) { toast('No image model available — add a key', 'error'); return; }
  imgEditor.busy = true; setEditorStatus('Working… ' + instruction.slice(0, 40), true);
  try {
    const g = await api(model, { prompt: instruction, images: [imgEditor.src], quality: opts.quality || 'auto', aspect: opts.aspect || 'auto' });
    if (!g.image) throw new Error('No image returned');
    pushHistory();
    imgEditor.src = g.image;
    imgEditor.promptEl.value = '';
    renderEditorImage();
    setEditorStatus('Done ✓');
  } catch (e) { setEditorStatus('⚠ ' + e.message); toast('Edit failed: ' + e.message, 'error'); }
  imgEditor.busy = false;
  imgEditor.overlay.classList.remove('busy');
}

async function multiAngle() {
  if (imgEditor.busy) return;
  const model = editorImageModelId();
  if (!model) { toast('No image model available', 'error'); return; }
  const angles = [
    ['three-quarter left', 'Show the same subject from a three-quarter front-left angle, same style and lighting.'],
    ['side profile', 'Show the same subject from a direct side profile, same style and lighting.'],
    ['three-quarter right', 'Show the same subject from a three-quarter front-right angle, same style and lighting.'],
    ['back view', 'Show the same subject from behind (back view), same style and lighting.'],
  ];
  const base = imgEditor.src;
  imgEditor.busy = true;
  let n = 0;
  const r = viewport.getBoundingClientRect();
  let ox = (r.width / 2 - panX) / zoom - 130, oy = (r.height / 2 - panY) / zoom - 90;
  try {
    for (const [name, prompt] of angles) {
      setEditorStatus(`Generating ${++n}/4 — ${name}…`, true);
      const g = await api(model, { prompt, images: [base], aspect: 'auto' });
      if (g.image) { addNode('upload', ox, oy, { image: g.image, title: 'Image' }); addAsset('image', g.image, 'angle: ' + name); ox += 44; oy += 44; }
    }
    setEditorStatus('4 angles added to the canvas ✓');
    toast('Multi-angle views added to the canvas');
  } catch (e) { setEditorStatus('⚠ ' + e.message); }
  imgEditor.busy = false; imgEditor.overlay.classList.remove('busy');
}

function toggleAdjust() { imgEditor.adj.hidden = !imgEditor.adj.hidden; if (imgEditor.adj.hidden) imgEditor.canvas.style.filter = ''; }

// crop + eraser interactions on the stage canvas
function toggleCrop() {
  imgEditor.mode = imgEditor.mode === 'crop' ? null : 'crop';
  imgEditor.cropRect.hidden = true;
  imgEditor.canvas.style.cursor = imgEditor.mode === 'crop' ? 'crosshair' : '';
  setEditorStatus(imgEditor.mode === 'crop' ? 'Crop: drag a box, then release to apply' : '');
}
function toggleErase() {
  imgEditor.mode = imgEditor.mode === 'erase' ? null : 'erase';
  imgEditor.canvas.style.cursor = imgEditor.mode === 'erase' ? 'cell' : '';
  setEditorStatus(imgEditor.mode === 'erase' ? 'Eraser: drag over the image to erase to transparent' : '');
}
function canvasCoords(ev) {
  const rect = imgEditor.canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) / rect.width * imgEditor.canvas.width,
    y: (ev.clientY - rect.top) / rect.height * imgEditor.canvas.height,
    scale: imgEditor.canvas.width / rect.width,
  };
}
function wireCropAndErase() {
  const cv = imgEditor.canvas;
  let start = null, erased = false;
  cv.addEventListener('pointerdown', (e) => {
    if (imgEditor.mode === 'crop') {
      start = canvasCoords(e);
      const rect = cv.getBoundingClientRect();
      imgEditor.cropRect.hidden = false;
      imgEditor._cropStartClient = { x: e.clientX, y: e.clientY, rect };
      Object.assign(imgEditor.cropRect.style, { left: (e.clientX - rect.left) + 'px', top: (e.clientY - rect.top) + 'px', width: '0px', height: '0px' });
      cv.setPointerCapture(e.pointerId);
    } else if (imgEditor.mode === 'erase') {
      pushHistory(); erased = false;
      cv.setPointerCapture(e.pointerId);
      eraseAt(e); erased = true;
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (imgEditor.mode === 'crop' && start && imgEditor._cropStartClient) {
      const s = imgEditor._cropStartClient;
      const x = Math.min(e.clientX, s.x) - s.rect.left, y = Math.min(e.clientY, s.y) - s.rect.top;
      Object.assign(imgEditor.cropRect.style, { left: x + 'px', top: y + 'px', width: Math.abs(e.clientX - s.x) + 'px', height: Math.abs(e.clientY - s.y) + 'px' });
    } else if (imgEditor.mode === 'erase' && e.buttons) {
      eraseAt(e);
    }
  });
  cv.addEventListener('pointerup', (e) => {
    if (imgEditor.mode === 'crop' && start) {
      const end = canvasCoords(e);
      const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
      start = null; imgEditor.cropRect.hidden = true;
      if (w > 6 && h > 6) applyCrop(x, y, w, h);
      imgEditor.mode = null; cv.style.cursor = ''; setEditorStatus('');
    } else if (imgEditor.mode === 'erase' && erased) {
      imgEditor.src = cv.toDataURL('image/png');
    }
  });
}
function eraseAt(e) {
  const c = canvasCoords(e);
  const x = imgEditor.ctx;
  x.save(); x.globalCompositeOperation = 'destination-out';
  x.beginPath(); x.arc(c.x, c.y, 18 * c.scale, 0, Math.PI * 2); x.fill(); x.restore();
}
async function applyCrop(x, y, w, h) {
  const img = await loadImage(imgEditor.src);
  const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h);
  c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
  pushHistory(); imgEditor.src = c.toDataURL('image/png'); renderEditorImage();
}

// remembered model choices (per kind + tier context) so a pick sticks everywhere
let PREFS = {};
try { PREFS = JSON.parse(localStorage.getItem('artcanvas-prefs') || '{}'); } catch { PREFS = {}; }
function setPref(prefKey, id) {
  PREFS[prefKey] = id;
  try { localStorage.setItem('artcanvas-prefs', JSON.stringify(PREFS)); } catch { /* ignore */ }
}

function modelSelect(node, kind, key = 'model', preferTier = null) {
  const sel = el('select');
  const avail = MODELS.filter(m => m.kind === kind);
  for (const m of avail) {
    const opt = el('option', { value: m.id }, `${m.label}${m.available ? '' : ' (no key)'}`);
    if (!m.available) opt.disabled = true;
    sel.appendChild(opt);
  }
  const prefKey = preferTier ? `${kind}:${preferTier}` : kind;
  const firstOk =
    (PREFS[prefKey] && avail.find(m => m.available && m.id === PREFS[prefKey])) ||
    (preferTier && avail.find(m => m.available && m.tier === preferTier)) ||
    avail.find(m => m.available) || avail[0];
  // never wipe a saved choice when the model list failed to load
  if (avail.length && (!node.data[key] || !avail.some(m => m.id === node.data[key]))) node.data[key] = firstOk?.id || '';
  sel.value = node.data[key];
  sel.addEventListener('change', () => { node.data[key] = sel.value; setPref(prefKey, sel.value); updateHead(node); save(); });
  return sel;
}

// same-provider cheap variant for mechanical work (sub-agents, refinement)
function fastVariantOf(modelId) {
  const m = MODELS.find(x => x.id === modelId);
  if (!m || m.tier === 'fast') return modelId;
  const fast = MODELS.find(x => x.kind === 'llm' && x.provider === m.provider && x.tier === 'fast' && x.available);
  return fast ? fast.id : modelId;
}

function selectCtl(node, key, options) {
  const sel = el('select');
  for (const [val, label] of options) sel.appendChild(el('option', { value: val }, label));
  sel.value = node.data[key];
  sel.addEventListener('change', () => { node.data[key] = sel.value; save(); });
  return sel;
}

function actionRow(node, box) {
  const row = el('div', { class: 'btn-row' });
  const run = el('button', { class: 'primary' }, '▶ Run');
  run.addEventListener('click', () => runGraph([node.id]));
  row.appendChild(run);
  const dl = el('button', {}, '⬇ Save');
  dl.disabled = !node.out.media;
  dl.addEventListener('click', () => downloadNode(node));
  row.appendChild(dl);
  box.appendChild(row);
}

// Reference uploader shown in Image/Video node props.
// allowVideo=true permits at most one video reference (plus any images).
function refControl(node, box, allowVideo) {
  node.data.refs ||= [];
  box.appendChild(el('label', {}, allowVideo ? 'References (images + 1 video)' : 'Reference images'));
  const strip = el('div', { class: 'ref-strip' });
  const render = () => {
    strip.innerHTML = '';
    node.data.refs.forEach((r, i) => {
      const chip = el('div', { class: 'ref-chip' });
      chip.appendChild(r.kind === 'video'
        ? Object.assign(el('video', { src: r.src }), { muted: true })
        : el('img', { src: r.src }));
      const x = el('button', { type: 'button', title: 'Remove' }, '✕');
      x.addEventListener('click', () => { node.data.refs.splice(i, 1); render(); save(); });
      chip.appendChild(x);
      strip.appendChild(chip);
    });
    if (!node.data.refs.length) strip.appendChild(el('span', { class: 'ref-empty' }, 'None yet'));
  };
  box.appendChild(strip);
  const add = el('button', { class: 'ref-add' }, '＋ Add reference');
  const input = el('input', { type: 'file', accept: allowVideo ? 'image/*,video/*' : 'image/*', multiple: '', hidden: '' });
  add.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    for (const f of input.files) {
      const kind = (f.type || '').startsWith('video') ? 'video' : 'image';
      if (kind === 'video' && !allowVideo) { toast('This node takes image references only'); continue; }
      if (kind === 'video' && node.data.refs.some(r => r.kind === 'video')) { toast('Only one video reference allowed'); continue; }
      if (node.data.refs.length >= 9) { toast('Up to 9 references'); break; }
      const fr = new FileReader();
      fr.onload = () => { node.data.refs.push({ kind, src: fr.result }); render(); save(); };
      fr.readAsDataURL(f);
    }
    input.value = '';
  });
  box.appendChild(add);
  box.appendChild(input);
  render();
}

function downloadNode(node) {
  const media = node.out.media;
  if (!media) return;
  const ext = media.kind === 'video' ? 'mp4' : media.kind === 'model' ? 'glb' : 'png';
  const a = el('a', { href: media.src, download: `artcanvas-${node.id}.${ext}` });
  if (!media.src.startsWith('data:')) a.target = '_blank';
  a.click();
}

function refreshMedia(node) {
  const box = node.el.querySelector('.node-media');
  box.innerHTML = '';
  box.appendChild(NODE_TYPES[node.type].media(node));
  redrawEdges();
  drawMinimap();
  if (selected?.kind === 'node' && selected.id === node.id) {
    const dl = propsBody.querySelector('.btn-row button:nth-child(2)');
    if (dl) dl.disabled = !node.out.media;
  }
}

function updateHead(node) {
  const sub = node.el.querySelector('.node-head .sub');
  sub.textContent = NODE_TYPES[node.type].sub(node) || '';
}

async function api(model, inputs) {
  if (!model) throw new Error('No model selected — open this node and pick one in the properties panel');
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, inputs }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  if (!data.jobId) return data; // direct result (older server)
  // poll the job until it settles — survives proxy timeouts on long generations
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    const jr = await fetch('/api/jobs/' + data.jobId);
    const j = await jr.json();
    if (!jr.ok) throw new Error(j.error || 'Job lost');
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw new Error(j.error);
  }
}

// Node creation --------------------------------------------------------
function addNode(type, x, y, data, id) {
  const def = NODE_TYPES[type];
  const node = {
    id: id || 'n' + idCounter++,
    type, x, y,
    data: { ...def.defaults(), ...(data || {}) },
    out: {},
  };
  const div = el('div', { class: 'node', 'data-id': node.id, 'data-type': type });
  div.style.left = x + 'px';
  div.style.top = y + 'px';
  if (node.data.w) div.style.width = node.data.w + 'px';

  const head = el('div', { class: 'node-head' });
  head.style.setProperty('--hc', def.color);
  head.appendChild(el('span', { class: 'hdot' }));
  head.appendChild(document.createTextNode(node.data.title || def.title));
  head.appendChild(el('span', { class: 'sub' }));
  const menuBtn = el('button', { class: 'menu', title: 'Node menu' }, '⋯');
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openCtxMenu(node, e.clientX, e.clientY); });
  head.appendChild(menuBtn);
  div.appendChild(head);

  // pins
  const left = el('div', { class: 'pins left' });
  for (const p of def.inputs) {
    const wrap = el('div', { class: 'pin-wrap', 'data-port': p.name, 'data-dir': 'in', 'data-type': p.type });
    const pin = el('div', { class: 'pin' });
    wrap.appendChild(pin);
    wrap.appendChild(el('span', { class: 'pin-label' }, p.name + (p.multi ? ` (up to ${p.multi})` : p.optional ? ' (optional)' : '')));
    bindPin(pin, node.id, p.name, 'in', p.type);
    left.appendChild(wrap);
  }
  const right = el('div', { class: 'pins right' });
  for (const p of def.outputs) {
    const wrap = el('div', { class: 'pin-wrap', 'data-port': p.name, 'data-dir': 'out', 'data-type': p.type });
    const pin = el('div', { class: 'pin' });
    wrap.appendChild(pin);
    wrap.appendChild(el('span', { class: 'pin-label' }, p.name));
    bindPin(pin, node.id, p.name, 'out', p.type);
    right.appendChild(wrap);
  }
  div.appendChild(left);
  div.appendChild(right);

  div.appendChild(el('div', { class: 'node-media' }));
  div.appendChild(el('div', { class: 'node-status' }));

  const rz = el('div', { class: 'node-resize', title: 'Drag to resize width' });
  div.appendChild(rz);

  node.el = div;
  nodesLayer.appendChild(div);
  nodes.set(node.id, node);
  makeResizable(node, rz);
  refreshMedia(node);
  updateHead(node);

  div.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('pin')) return;
    selectNode(node.id);
    e.stopPropagation();
  });
  makeDraggable(node, div);
  save();
  drawMinimap();
  updateEmptyHint();
  return node;
}

function removeNode(id) {
  const node = nodes.get(id);
  if (!node) return;
  edges = edges.filter(e => e.from.node !== id && e.to.node !== id);
  node.el.remove();
  nodes.delete(id);
  if (selected?.kind === 'node' && selected.id === id) clearSelection();
  redrawEdges();
  drawMinimap();
  updateEmptyHint();
  save();
}

function duplicateNode(id) {
  const node = nodes.get(id);
  if (!node) return;
  const copy = addNode(node.type, node.x + 30, node.y + 30, JSON.parse(JSON.stringify(node.data)));
  selectNode(copy.id);
  redrawEdges();
}

function makeDraggable(node, handle) {
  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.target.classList.contains('pin')) return;
    if (/TEXTAREA|SELECT|INPUT/.test(e.target.tagName)) return;
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY; ox = node.x; oy = node.y;
    nodesLayer.appendChild(node.el);
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    moved = true;
    node.x = ox + (e.clientX - sx) / zoom;
    node.y = oy + (e.clientY - sy) / zoom;
    node.el.style.left = node.x + 'px';
    node.el.style.top = node.y + 'px';
    redrawEdges();
  });
  handle.addEventListener('pointerup', () => {
    if (dragging && moved) { save(); drawMinimap(); }
    dragging = false;
  });
}

function makeResizable(node, handle) {
  let resizing = false, sx = 0, sw = 0;
  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); // don't start a node drag / selection
    resizing = true;
    sx = e.clientX;
    sw = node.el.getBoundingClientRect().width / zoom;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    node.data.w = Math.round(Math.max(200, Math.min(1400, sw + (e.clientX - sx) / zoom)));
    node.el.style.width = node.data.w + 'px';
    redrawEdges();
  });
  handle.addEventListener('pointerup', () => {
    if (resizing) { save(); drawMinimap(); }
    resizing = false;
  });
}

// Selection & properties panel ------------------------------------------
let selected = null;
function selectNode(id) {
  clearSelection(true);
  selected = { kind: 'node', id };
  const node = nodes.get(id);
  node.el.classList.add('selected');
  renderProps(node);
}
function selectEdge(id) {
  clearSelection(true);
  selected = { kind: 'edge', id };
  edgesSvg.querySelector(`[data-id="${id}"]`)?.classList.add('selected');
}
function clearSelection(soft) {
  selected = null;
  document.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'));
  edgesSvg.querySelectorAll('.selected').forEach(p => p.classList.remove('selected'));
  if (!soft) renderProps(null);
}
function renderProps(node) {
  propsBody.innerHTML = '';
  propsTitle.innerHTML = '';
  if (!node) {
    propsTitle.textContent = 'Properties';
    const d = el('div', { class: 'props-empty' });
    d.innerHTML = 'Select a node to edit its settings.<br><br><b>Shortcuts</b><br>Double-click — add node<br>Drag pins — connect<br>Arrow keys — nudge (Shift = faster)<br>Ctrl+D — duplicate<br>Del — delete<br>F — fit view';
    propsBody.appendChild(d);
    return;
  }
  const def = NODE_TYPES[node.type];
  const dot = el('span', { class: 'hdot' });
  dot.style.setProperty('--hc', def.color);
  propsTitle.appendChild(dot);
  propsTitle.appendChild(document.createTextNode(def.title));
  def.props(node, propsBody);
}

document.addEventListener('keydown', (e) => {
  // Esc closes the top-most open surface (works even while typing)
  if (e.key === 'Escape') {
    const ctx = document.getElementById('ctxmenu');
    const qa = document.getElementById('quickadd');
    const ov = document.getElementById('overlay');
    const ch = document.getElementById('chat');
    const as = document.getElementById('assets');
    const lb = document.getElementById('lightbox');
    if (imgEditor && !imgEditor.overlay.hidden) closeImageEditor();
    else if (lb && !lb.hidden) closeLightbox();
    else if (directorOverlay && !directorOverlay.hidden) closeDirector();
    else if (!ctx.hidden) ctx.hidden = true;
    else if (!qa.hidden) qa.hidden = true;
    else if (!ov.hidden) ov.hidden = true;
    else if (ch && !ch.hidden) ch.hidden = true;
    else if (as && !as.hidden) as.hidden = true;
    else clearSelection();
    return;
  }
  // Ctrl/Cmd+Enter runs the selected node (unless typing in the chat)
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    if (!e.target.closest?.('#chat')) {
      e.preventDefault();
      if (selected?.kind === 'node') runGraph([selected.id]);
      else toast('Select a node, then Ctrl+Enter to run it');
    }
    return;
  }
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    if (selected.kind === 'node') removeNode(selected.id);
    else { edges = edges.filter(ed => ed.id !== selected.id); redrawEdges(); save(); }
    selected = null;
    renderProps(null);
  } else if (e.key.toLowerCase() === 'd' && (e.ctrlKey || e.metaKey) && selected?.kind === 'node') {
    e.preventDefault();
    duplicateNode(selected.id);
  } else if (selected?.kind === 'node' && e.key.startsWith('Arrow')) {
    // nudge the selected node with the arrow keys (Shift = larger step)
    e.preventDefault();
    const node = nodes.get(selected.id);
    if (node) {
      const step = e.shiftKey ? 40 : 8;
      if (e.key === 'ArrowLeft') node.x -= step;
      else if (e.key === 'ArrowRight') node.x += step;
      else if (e.key === 'ArrowUp') node.y -= step;
      else if (e.key === 'ArrowDown') node.y += step;
      node.el.style.left = node.x + 'px';
      node.el.style.top = node.y + 'px';
      redrawEdges();
      drawMinimap();
      save();
    }
  } else if (e.key.toLowerCase() === 'f') {
    fitView();
  }
});

// Edges ----------------------------------------------------------------
function pinWorldPos(nodeId, portName, dir) {
  const node = nodes.get(nodeId);
  const pin = node?.el.querySelector(`.pin-wrap[data-dir="${dir}"][data-port="${portName}"] .pin`);
  if (!pin) return { x: 0, y: 0 };
  const r = pin.getBoundingClientRect();
  const vr = viewport.getBoundingClientRect();
  return {
    x: (r.left + r.width / 2 - vr.left - panX) / zoom,
    y: (r.top + r.height / 2 - vr.top - panY) / zoom,
  };
}

function edgePath(a, b) {
  const dx = Math.min(200, Math.max(40, Math.abs(b.x - a.x) / 2));
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function redrawEdges() {
  edgesSvg.querySelectorAll('.edge').forEach(p => p.remove());
  for (const edge of edges) {
    const a = pinWorldPos(edge.from.node, edge.from.port, 'out');
    const b = pinWorldPos(edge.to.node, edge.to.port, 'in');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'edge' + (runningNodes.has(edge.to.node) ? ' flow' : ''));
    path.setAttribute('data-id', edge.id);
    path.setAttribute('d', edgePath(a, b));
    path.setAttribute('stroke', TYPE_COLORS[edge.type] || TYPE_COLORS.any);
    path.addEventListener('pointerdown', (e) => { selectEdge(edge.id); e.stopPropagation(); });
    edgesSvg.appendChild(path);
  }
  updatePinStates();
}

function updatePinStates() {
  document.querySelectorAll('.pin').forEach(p => p.classList.remove('connected'));
  for (const edge of edges) {
    nodes.get(edge.from.node)?.el.querySelector(`.pin-wrap[data-dir="out"][data-port="${edge.from.port}"] .pin`)?.classList.add('connected');
    nodes.get(edge.to.node)?.el.querySelector(`.pin-wrap[data-dir="in"][data-port="${edge.to.port}"] .pin`)?.classList.add('connected');
  }
}

function bindPin(pin, nodeId, portName, dir, type) {
  pin.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'temp');
    path.setAttribute('stroke', TYPE_COLORS[type]);
    path.style.pointerEvents = 'none';
    edgesSvg.appendChild(path);
    pin.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const vr = viewport.getBoundingClientRect();
      const m = { x: (ev.clientX - vr.left - panX) / zoom, y: (ev.clientY - vr.top - panY) / zoom };
      const p = pinWorldPos(nodeId, portName, dir);
      path.setAttribute('d', dir === 'out' ? edgePath(p, m) : edgePath(m, p));
      document.querySelectorAll('.pin.hot').forEach(x => x.classList.remove('hot'));
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (target?.classList.contains('pin')) target.classList.add('hot');
    };
    const up = (ev) => {
      pin.removeEventListener('pointermove', move);
      pin.removeEventListener('pointerup', up);
      path.remove();
      document.querySelectorAll('.pin.hot').forEach(x => x.classList.remove('hot'));
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (target?.classList.contains('pin')) {
        tryConnect({ nodeId, portName, dir, type }, target);
      } else if (!target?.closest('.node')) {
        // dropped on empty canvas → offer compatible nodes to create + wire
        openConnectorMenu({ nodeId, portName, dir, type }, ev.clientX, ev.clientY);
      }
    };
    pin.addEventListener('pointermove', move);
    pin.addEventListener('pointerup', up);
  });
}

function tryConnect(from, targetPin) {
  const wrap = targetPin.closest('.pin-wrap');
  const nodeEl = targetPin.closest('.node');
  if (!wrap || !nodeEl) return;
  const to = { nodeId: nodeEl.dataset.id, portName: wrap.dataset.port, dir: wrap.dataset.dir, type: wrap.dataset.type };
  if (from.dir === to.dir || from.nodeId === to.nodeId) return;
  const [src, dst] = from.dir === 'out' ? [from, to] : [to, from];
  if (dst.type !== 'any' && src.type !== dst.type) return;
  const dstDef = NODE_TYPES[nodes.get(dst.nodeId).type].inputs.find(i => i.name === dst.portName);
  const max = dstDef?.multi || 1;
  const existing = edges.filter(e => e.to.node === dst.nodeId && e.to.port === dst.portName);
  // no duplicate wire from the same source port
  if (existing.some(e => e.from.node === src.nodeId && e.from.port === src.portName)) return;
  if (max === 1) {
    edges = edges.filter(e => !(e.to.node === dst.nodeId && e.to.port === dst.portName));
  } else if (existing.length >= max) {
    return; // at capacity
  }
  edges.push({
    id: 'e' + idCounter++,
    from: { node: src.nodeId, port: src.portName },
    to: { node: dst.nodeId, port: dst.portName },
    type: src.type,
  });
  redrawEdges();
  save();
}

// Execution ------------------------------------------------------------
function setState(node, state, msg) {
  node.el.classList.remove('running', 'error');
  if (state === 'running') runningNodes.add(node.id);
  else runningNodes.delete(node.id);
  if (state && state !== 'done') node.el.classList.add(state);
  node.el.querySelector('.node-status').textContent = msg || '';
  redrawEdges();
}

async function execNode(id, ctx) {
  if (ctx.results.has(id)) return ctx.results.get(id);
  if (ctx.pending.has(id)) throw new Error('Cycle detected in graph');
  ctx.pending.add(id);
  const node = nodes.get(id);
  const def = NODE_TYPES[node.type];
  const inputs = {};
  for (const p of def.inputs) {
    const inEdges = edges.filter(e => e.to.node === id && e.to.port === p.name);
    if (p.multi) {
      const vals = [];
      for (const edge of inEdges) {
        const upstream = await execNode(edge.from.node, ctx);
        vals.push(upstream[edge.from.port]);
      }
      inputs[p.name] = vals;
      if (!vals.length && !p.optional) throw new Error(`Input "${p.name}" is not connected`);
    } else if (inEdges[0]) {
      const upstream = await execNode(inEdges[0].from.node, ctx);
      inputs[p.name] = upstream[inEdges[0].from.port];
    } else if (!p.optional) {
      throw new Error(`Input "${p.name}" is not connected`);
    }
  }
  setState(node, 'running', 'Generating…');
  try {
    const out = await def.exec(node, inputs);
    setState(node, 'done');
    ctx.results.set(id, out);
    ctx.pending.delete(id);
    return out;
  } catch (err) {
    setState(node, 'error', err.message);
    ctx.pending.delete(id);
    throw err;
  }
}

// lightweight feedback toasts
function toast(msg, type = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = el('div', { id: 'toasts' }); document.body.appendChild(box); }
  const t = el('div', { class: 'toast' + (type === 'error' ? ' error' : '') }, msg);
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, 2400);
}

// 3D Director — a full-page 3D previs stage; captured shots drop into the project.
let directorOverlay = null;
let directorFrame = null;
let directorScope = null;

function buildDirectorOverlay() {
  const ov = el('div', { class: 'director-overlay', hidden: '' });
  const bar = el('div', { class: 'director-bar' });
  bar.appendChild(el('span', { class: 'director-title' }, '🎬 3D Director'));
  bar.appendChild(el('span', { class: 'director-hint' }, 'Block a shot, Capture, then “Send to canvas” — it drops into this project as an image node.'));
  const close = el('button', { class: 'director-close', title: 'Close (Esc)' }, '✕ Close');
  close.addEventListener('click', closeDirector);
  bar.appendChild(close);
  ov.appendChild(bar);
  directorFrame = el('iframe', { class: 'director-frame', allow: 'fullscreen; xr-spatial-tracking' });
  ov.appendChild(directorFrame);
  document.body.appendChild(ov);
  return ov;
}

function openDirector() {
  if (!directorOverlay) directorOverlay = buildDirectorOverlay();
  // Scope the 3D scene per project so each project keeps its own blocking.
  const scope = 'acv-' + (projects.current || 'default');
  if (directorScope !== scope) {
    directorScope = scope;
    directorFrame.src = `/director/index.html?instanceId=${encodeURIComponent(scope)}&theme=dark`;
  }
  directorOverlay.hidden = false;
}

function closeDirector() {
  if (directorOverlay) directorOverlay.hidden = true;
}

// Receive captured shots from the Director; each becomes an Upload node + asset.
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object' || d.type !== 'storyai:director-desk-captures-sent') return;
  if (!directorFrame || e.source !== directorFrame.contentWindow) return;
  const caps = (d.payload?.captures || []).filter(c => c && c.dataUrl);
  if (!caps.length) return;
  // Drop each captured shot onto the canvas as an image (Upload) node.
  const vr = viewport.getBoundingClientRect();
  let wx = (vr.width / 2 - panX) / zoom - 130;
  let wy = (vr.height / 2 - panY) / zoom - 90;
  for (const c of caps) {
    const node = addNode('upload', wx, wy, { image: c.dataUrl, title: 'Image' });
    refreshMedia(node); updateHead(node);
    addAsset('image', c.dataUrl, c.fileName || 'director shot');
    wx += 40; wy += 40;
  }
  save();
  toast(caps.length > 1 ? `${caps.length} shots added to the project` : 'Shot captured → added to the project');
});

let running = false;
async function runGraph(targetIds) {
  if (running) return;
  running = true;
  const ctx = { results: new Map(), pending: new Set() };
  for (const id of targetIds) {
    try { await execNode(id, ctx); } catch { /* shown on node */ }
  }
  running = false;
}

// Pan & zoom -----------------------------------------------------------
function applyTransform() {
  world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  // dot grid follows the canvas so panning/zooming feels physical
  const s = 26 * zoom;
  viewport.style.setProperty('--dot-s', s + 'px');
  viewport.style.setProperty('--dot-x', (panX % s) + 'px');
  viewport.style.setProperty('--dot-y', (panY % s) + 'px');
  drawMinimap();
}
let panning = false, lastX = 0, lastY = 0;
viewport.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.node')) return;
  panning = true;
  lastX = e.clientX; lastY = e.clientY;
  viewport.classList.add('panning');
  viewport.setPointerCapture(e.pointerId);
  clearSelection();
  hideQuickAdd();
});
viewport.addEventListener('pointermove', (e) => {
  if (!panning) return;
  panX += e.clientX - lastX;
  panY += e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  applyTransform();
});
viewport.addEventListener('pointerup', () => { panning = false; viewport.classList.remove('panning'); });
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

function zoomAt(cx, cy, factor) {
  const newZoom = Math.min(3, Math.max(0.12, zoom * factor));
  const rect = viewport.getBoundingClientRect();
  const mx = cx - rect.left, my = cy - rect.top;
  panX = mx - (mx - panX) * (newZoom / zoom);
  panY = my - (my - panY) * (newZoom / zoom);
  zoom = newZoom;
  applyTransform();
}
document.getElementById('btn-zoom-in').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1.2));
document.getElementById('btn-zoom-out').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2));
document.getElementById('btn-fit').addEventListener('click', fitView);

function graphBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes.values()) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.el.offsetWidth); maxY = Math.max(maxY, n.y + n.el.offsetHeight);
  }
  return { minX, minY, maxX, maxY };
}

function fitView() {
  if (!nodes.size) { panX = 0; panY = 0; zoom = 1; applyTransform(); return; }
  const rect = viewport.getBoundingClientRect();
  if (rect.width < 200 || rect.height < 200) return;
  const { minX, minY, maxX, maxY } = graphBounds();
  const pad = 100;
  zoom = Math.min(1.4, (rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY));
  if (!isFinite(zoom)) zoom = 1;
  zoom = Math.max(0.12, Math.min(1.4, zoom));
  panX = rect.width / 2 - (minX + maxX) / 2 * zoom;
  panY = rect.height / 2 - (minY + maxY) / 2 * zoom;
  applyTransform();
  redrawEdges();
}

document.getElementById('btn-clear').addEventListener('click', () => {
  if (!nodes.size || !confirm('Remove all nodes?')) return;
  for (const id of [...nodes.keys()]) removeNode(id);
});

// Bottom dock ------------------------------------------------------------
document.getElementById('dock').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-add]');
  if (!btn) return;
  const rect = viewport.getBoundingClientRect();
  const cx = (rect.width / 2 - panX) / zoom - 130;
  const cy = (rect.height / 2 - panY) / zoom - 90;
  const offset = (nodes.size % 5) * 30;
  const node = addNode(btn.dataset.add, cx + offset, cy + offset);
  selectNode(node.id);
  redrawEdges();
});

// Quick add (double-click) ------------------------------------------------
const quickadd = document.getElementById('quickadd');
const qaInput = document.getElementById('qa-input');
const qaList = document.getElementById('qa-list');
let qaWorld = { x: 0, y: 0 };
let qaConnect = null; // when set: { from: {nodeId, portName, dir, type} } — add + auto-wire

viewport.addEventListener('dblclick', (e) => {
  if (e.target.closest('.node')) return;
  const vr = viewport.getBoundingClientRect();
  qaConnect = null;
  qaWorld = { x: (e.clientX - vr.left - panX) / zoom, y: (e.clientY - vr.top - panY) / zoom };
  showQuickAdd(e.clientX, e.clientY);
});

function showQuickAdd(clientX, clientY) {
  quickadd.hidden = false;
  quickadd.style.left = Math.min(clientX, innerWidth - 240) + 'px';
  quickadd.style.top = Math.min(clientY, innerHeight - 280) + 'px';
  qaInput.value = '';
  qaInput.placeholder = qaConnect ? 'Connect to…' : 'Search nodes…';
  renderQaList('');
  qaInput.focus();
}

// Drag off a pin and drop on empty canvas → offer compatible nodes to add + wire.
function openConnectorMenu(from, clientX, clientY) {
  const vr = viewport.getBoundingClientRect();
  qaWorld = { x: (clientX - vr.left - panX) / zoom, y: (clientY - vr.top - panY) / zoom };
  qaConnect = { from };
  showQuickAdd(clientX, clientY);
}

// node types compatible with the dragged pin → [{ type, port }] (port to wire on the new node)
function connectCandidates(from) {
  const out = [];
  for (const [type, def] of Object.entries(NODE_TYPES)) {
    let port = null;
    if (from.dir === 'out') {
      const p = def.inputs.find(i => i.type === from.type || i.type === 'any');
      if (p) port = p.name;
    } else {
      const o = def.outputs.find(o => from.type === 'any' || o.type === from.type);
      if (o) port = o.name;
    }
    if (port) out.push({ type, port });
  }
  return out;
}

function connectPorts(srcId, srcPort, dstId, dstPort, type) {
  if (srcId === dstId) return;
  const dstNode = nodes.get(dstId);
  const dstDef = NODE_TYPES[dstNode.type].inputs.find(i => i.name === dstPort);
  const max = dstDef?.multi || 1;
  const existing = edges.filter(e => e.to.node === dstId && e.to.port === dstPort);
  if (existing.some(e => e.from.node === srcId && e.from.port === srcPort)) return;
  if (max === 1) edges = edges.filter(e => !(e.to.node === dstId && e.to.port === dstPort));
  else if (existing.length >= max) return;
  edges.push({ id: 'e' + idCounter++, from: { node: srcId, port: srcPort }, to: { node: dstId, port: dstPort }, type });
  redrawEdges(); save();
}

function renderQaList(filter) {
  qaList.innerHTML = '';
  const f = filter.toLowerCase();
  const allowed = qaConnect ? connectCandidates(qaConnect.from) : null;
  const entries = allowed
    ? allowed.map(c => [c.type, NODE_TYPES[c.type], c.port])
    : Object.entries(NODE_TYPES).map(([t, d]) => [t, d, null]);
  for (const [type, def, port] of entries) {
    if (f && !def.title.toLowerCase().includes(f) && !type.toLowerCase().includes(f) && !def.desc.includes(f)) continue;
    const item = el('div', { class: 'qa-item', 'data-type': type });
    if (port) item.dataset.port = port;
    const dot = el('span', { class: 'hdot' });
    dot.style.setProperty('--hc', def.color);
    item.appendChild(dot);
    item.appendChild(document.createTextNode(def.title));
    item.appendChild(el('span', { class: 'desc' }, def.desc));
    item.addEventListener('click', () => quickAddType(type, port));
    qaList.appendChild(item);
  }
  qaList.querySelector('.qa-item')?.classList.add('active');
}

function quickAddType(type, port) {
  const connect = qaConnect;
  hideQuickAdd();
  const node = addNode(type, qaWorld.x - 130, qaWorld.y - 40);
  if (connect && port) {
    const from = connect.from;
    if (from.dir === 'out') connectPorts(from.nodeId, from.portName, node.id, port, from.type);
    else {
      const t = NODE_TYPES[type].outputs.find(o => o.name === port)?.type || from.type;
      connectPorts(node.id, port, from.nodeId, from.portName, t);
    }
  }
  selectNode(node.id);
  redrawEdges();
}

function hideQuickAdd() { quickadd.hidden = true; qaConnect = null; }
qaInput.addEventListener('input', () => renderQaList(qaInput.value));
qaInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideQuickAdd();
  if (e.key === 'Enter') {
    const first = qaList.querySelector('.qa-item.active') || qaList.querySelector('.qa-item');
    if (first) quickAddType(first.dataset.type, first.dataset.port);
  }
});

// Context menu -------------------------------------------------------------
const ctxmenu = document.getElementById('ctxmenu');
function openCtxMenu(node, x, y) {
  ctxmenu.innerHTML = '';
  const mk = (label, fn, cls) => {
    const b = el('button', cls ? { class: cls } : {}, label);
    b.addEventListener('click', () => { hideCtxMenu(); fn(); });
    ctxmenu.appendChild(b);
  };
  mk('▶ Run node', () => runGraph([node.id]));
  mk('Duplicate (Ctrl+D)', () => duplicateNode(node.id));
  if (node.out.media) mk('⬇ Download result', () => downloadNode(node));
  mk('Delete (Del)', () => removeNode(node.id), 'danger');
  ctxmenu.hidden = false;
  ctxmenu.style.left = Math.min(x, innerWidth - 170) + 'px';
  ctxmenu.style.top = Math.min(y, innerHeight - 180) + 'px';
}
function hideCtxMenu() { ctxmenu.hidden = true; }
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#ctxmenu')) hideCtxMenu();
  if (!e.target.closest('#quickadd') && !quickadd.hidden && !e.target.closest('#viewport')) hideQuickAdd();
});

// Minimap --------------------------------------------------------------
const minimap = document.getElementById('minimap');
const mmCtx = minimap.getContext('2d');
let mmScale = 1, mmOffX = 0, mmOffY = 0;

function drawMinimap() {
  const W = minimap.width, H = minimap.height;
  mmCtx.clearRect(0, 0, W, H);
  if (!nodes.size) return;
  const { minX, minY, maxX, maxY } = graphBounds();
  const vr = viewport.getBoundingClientRect();
  // include current view in bounds so the view rect is always visible
  const vx0 = -panX / zoom, vy0 = -panY / zoom;
  const vx1 = vx0 + vr.width / zoom, vy1 = vy0 + vr.height / zoom;
  const bx0 = Math.min(minX, vx0), by0 = Math.min(minY, vy0);
  const bx1 = Math.max(maxX, vx1), by1 = Math.max(maxY, vy1);
  const pad = 10;
  mmScale = Math.min((W - pad * 2) / (bx1 - bx0), (H - pad * 2) / (by1 - by0));
  mmOffX = pad - bx0 * mmScale + (W - pad * 2 - (bx1 - bx0) * mmScale) / 2;
  mmOffY = pad - by0 * mmScale + (H - pad * 2 - (by1 - by0) * mmScale) / 2;
  // nodes
  for (const n of nodes.values()) {
    mmCtx.fillStyle = NODE_TYPES[n.type].color + 'cc';
    mmCtx.fillRect(n.x * mmScale + mmOffX, n.y * mmScale + mmOffY,
      Math.max(3, n.el.offsetWidth * mmScale), Math.max(3, n.el.offsetHeight * mmScale));
  }
  // viewport rect
  mmCtx.strokeStyle = '#ffffff88';
  mmCtx.lineWidth = 1;
  mmCtx.strokeRect(vx0 * mmScale + mmOffX, vy0 * mmScale + mmOffY, (vx1 - vx0) * mmScale, (vy1 - vy0) * mmScale);
}

minimap.addEventListener('pointerdown', (e) => {
  const r = minimap.getBoundingClientRect();
  const wx = (e.clientX - r.left - mmOffX) / mmScale;
  const wy = (e.clientY - r.top - mmOffY) / mmScale;
  const vr = viewport.getBoundingClientRect();
  panX = vr.width / 2 - wx * zoom;
  panY = vr.height / 2 - wy * zoom;
  applyTransform();
});

// Skills (Claude Code-style reusable instruction packs) ------------------
let SKILLS = [];
try { SKILLS = JSON.parse(localStorage.getItem('artcanvas-skills') || '[]'); } catch { SKILLS = []; }
function saveSkills() {
  try { localStorage.setItem('artcanvas-skills', JSON.stringify(SKILLS)); } catch { /* ignore */ }
}

function skillsTextFor(node) {
  return (node.data.skills || [])
    .map(id => SKILLS.find(s => s.id === id))
    .filter(s => s && s.text)
    .map(s => `## Skill: ${s.name}\n${s.text}`)
    .join('\n\n');
}

function skillChecks(node, box) {
  box.appendChild(el('label', {}, 'Skills'));
  if (!SKILLS.length) {
    box.appendChild(el('div', { class: 'mini-hint' }, 'No skills yet — create them with the Skills button in the top bar.'));
    return;
  }
  for (const s of SKILLS) {
    const row = el('label', { class: 'chk' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = (node.data.skills || []).includes(s.id);
    cb.addEventListener('change', () => {
      node.data.skills = (node.data.skills || []).filter(x => x !== s.id);
      if (cb.checked) node.data.skills.push(s.id);
      save();
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(s.name));
    box.appendChild(row);
  }
}

// Modal ------------------------------------------------------------------
const overlay = document.getElementById('overlay');
const modalBody = document.getElementById('modal-body');
function openModal(title) {
  document.getElementById('modal-title').textContent = title;
  modalBody.innerHTML = '';
  overlay.hidden = false;
  return modalBody;
}
function closeModal() { overlay.hidden = true; }
document.getElementById('modal-close').addEventListener('click', closeModal);
overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeModal(); });

document.getElementById('btn-skills').addEventListener('click', () => {
  const body = openModal('Skills — reusable instruction packs');
  const render = () => {
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'modal-hint' },
      'A skill is a named block of instructions (style guides, brand rules, techniques). Attach skills to LLM and Agent nodes in their properties panel — they are injected as system instructions for the orchestrator and every sub-agent.'));
    for (const s of SKILLS) {
      const row = el('div', { class: 'skill-row' });
      const head = el('div', { class: 'skill-head' });
      const name = el('input', { type: 'text', placeholder: 'Skill name' });
      name.value = s.name;
      name.addEventListener('input', () => { s.name = name.value; saveSkills(); });
      const del = el('button', { class: 'danger' }, 'Delete');
      del.addEventListener('click', () => { SKILLS = SKILLS.filter(x => x !== s); saveSkills(); render(); });
      head.appendChild(name);
      head.appendChild(del);
      const text = el('textarea', { placeholder: 'Instructions the model should follow when this skill is attached…' });
      text.value = s.text;
      text.addEventListener('input', () => { s.text = text.value; saveSkills(); });
      row.appendChild(head);
      row.appendChild(text);
      body.appendChild(row);
    }
    const add = el('button', { class: 'primary' }, '＋ New skill');
    add.addEventListener('click', () => {
      SKILLS.push({ id: 's' + Date.now().toString(36), name: 'New skill', text: '' });
      saveSkills();
      render();
    });
    body.appendChild(add);
  };
  render();
});

// Projects (auto-saved, multiple) -----------------------------------------
let projects = { list: [], current: null };
let suspendSave = false;
const projKey = (id) => 'artcanvas-proj-' + id;
const newProjectId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function serializeGraph() {
  return {
    idCounter,
    nodes: [...nodes.values()].map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y, data: n.data })),
    edges,
    // persist the conversation, but not generated media (too large for localStorage)
    chat: chatHistory.map(m => ({ role: m.role, text: m.text, deliverable: m.deliverable || null })),
  };
}

function doSaveNow() {
  if (!projects.current || suspendSave) return;
  try {
    localStorage.setItem(projKey(projects.current), JSON.stringify(serializeGraph()));
    const meta = projects.list.find(p => p.id === projects.current);
    if (meta) meta.updatedAt = Date.now();
    saveProjectsMeta();
  } catch { /* quota exceeded — skip autosave */ }
  scheduleCloudPush();
}

// ---- cloud sync: mirror projects to the server's store (Supabase/disk) ----
let pushTimer = null;
function scheduleCloudPush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(cloudPush, 1500);
}
async function cloudPush() {
  if (!projects.current) return;
  try {
    const meta = projects.list.find(p => p.id === projects.current);
    const raw = localStorage.getItem(projKey(projects.current));
    if (!meta || !raw) return;
    await fetch('/api/projects/' + projects.current, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: meta.name, updatedAt: meta.updatedAt, graph: JSON.parse(raw) }),
    });
  } catch { /* offline — localStorage still has it */ }
}
async function cloudPull() {
  try {
    const remote = await (await fetch('/api/projects')).json();
    for (const rm of remote.list || []) {
      const local = projects.list.find(p => p.id === rm.id);
      if (!local || (rm.updatedAt || 0) > (local.updatedAt || 0)) {
        const proj = await (await fetch('/api/projects/' + rm.id)).json();
        if (proj?.graph) {
          try { localStorage.setItem(projKey(rm.id), JSON.stringify(proj.graph)); } catch { continue; }
          if (local) { local.name = rm.name; local.updatedAt = rm.updatedAt; }
          else projects.list.push({ id: rm.id, name: rm.name, updatedAt: rm.updatedAt });
        }
      }
    }
    // upload anything the server is missing or has stale
    for (const lp of projects.list) {
      const rm = (remote.list || []).find(p => p.id === lp.id);
      if (!rm || (lp.updatedAt || 0) > (rm.updatedAt || 0)) {
        const raw = localStorage.getItem(projKey(lp.id));
        if (raw) {
          fetch('/api/projects/' + lp.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: lp.name, updatedAt: lp.updatedAt, graph: JSON.parse(raw) }),
          }).catch(() => {});
        }
      }
    }
    saveProjectsMeta();
  } catch {
    toast('Cloud sync unavailable — working locally');
  }
}

let saveTimer = null;
function save() {
  if (suspendSave) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSaveNow, 400);
}

function saveProjectsMeta() {
  try { localStorage.setItem('artcanvas-projects', JSON.stringify(projects)); } catch { /* ignore */ }
}

function clearCanvas() {
  for (const n of nodes.values()) n.el.remove();
  nodes.clear();
  edges = [];
  chatHistory = [];
  clearSelection();
  redrawEdges();
  drawMinimap();
  updateEmptyHint();
}

function loadGraph(data) {
  if (!data?.nodes?.length) return false;
  idCounter = data.idCounter || 1;
  for (const n of data.nodes) {
    if (NODE_TYPES[n.type]) addNode(n.type, n.x, n.y, n.data, n.id);
  }
  edges = (data.edges || []).filter(e => nodes.has(e.from.node) && nodes.has(e.to.node));
  chatHistory = Array.isArray(data.chat) ? data.chat : [];
  renderChat();
  redrawEdges();
  return true;
}

function updateEmptyHint() {
  const h = document.getElementById('empty-hint');
  if (h) h.hidden = nodes.size > 0;
}

function link(a, ap, b, bp) {
  edges.push({
    id: 'e' + idCounter++,
    from: { node: a.id, port: ap },
    to: { node: b.id, port: bp },
    type: NODE_TYPES[a.type].outputs.find(o => o.name === ap).type,
  });
}

function openProject(id, opts = {}) {
  if (!opts.skipSaveCurrent) doSaveNow();
  projects.current = id;
  saveProjectsMeta();
  suspendSave = true;
  clearCanvas();
  const raw = localStorage.getItem(projKey(id));
  if (raw) { try { loadGraph(JSON.parse(raw)); } catch { /* start empty */ } }
  suspendSave = false;
  doSaveNow();
  updateProjectUI();
  renderProps(null);
  requestAnimationFrame(() => { fitView(); redrawEdges(); });
}

function createProject(name, build, opts = {}) {
  if (!opts.skipSaveCurrent) doSaveNow();
  const id = newProjectId();
  projects.list.push({ id, name, updatedAt: Date.now() });
  projects.current = id;
  saveProjectsMeta();
  suspendSave = true;
  clearCanvas();
  idCounter = 1;
  if (build) build(); // no builder → start with an empty canvas
  suspendSave = false;
  doSaveNow();
  updateProjectUI();
  renderProps(null);
  requestAnimationFrame(() => { fitView(); redrawEdges(); });
}

function updateProjectUI() {
  const sel = document.getElementById('project-select');
  sel.innerHTML = '';
  for (const p of projects.list) sel.appendChild(el('option', { value: p.id }, p.name));
  sel.value = projects.current;
}

document.getElementById('project-select').addEventListener('change', (e) => openProject(e.target.value));
document.getElementById('btn-new-project').addEventListener('click', () => {
  const name = prompt('Project name:', 'Untitled project');
  if (name !== null) createProject(name.trim() || 'Untitled project');
});
document.getElementById('btn-rename-project').addEventListener('click', () => {
  const meta = projects.list.find(p => p.id === projects.current);
  if (!meta) return;
  const name = prompt('Rename project:', meta.name);
  if (name !== null && name.trim()) { meta.name = name.trim(); saveProjectsMeta(); updateProjectUI(); }
});
document.getElementById('btn-del-project').addEventListener('click', () => {
  const meta = projects.list.find(p => p.id === projects.current);
  if (!meta || !confirm(`Delete project "${meta.name}"? This cannot be undone.`)) return;
  localStorage.removeItem(projKey(meta.id));
  projects.list = projects.list.filter(p => p.id !== meta.id);
  fetch('/api/projects/' + meta.id, { method: 'DELETE' }).catch(() => {});
  toast(`Deleted "${meta.name}"`);
  if (projects.list.length) {
    openProject(projects.list[0].id, { skipSaveCurrent: true });
  } else {
    projects.current = null;
    createProject('Untitled project');
  }
});

// Export / import -----------------------------------------------------------

// Templates -------------------------------------------------------------
const TEMPLATES = [
  {
    name: 'Generate image', desc: 'Prompt → Image model',
    build() {
      const p = addNode('prompt', 60, 200);
      const i = addNode('imageModel', 460, 170);
      link(p, 'text', i, 'prompt');
    },
  },
  {
    name: 'Image remix', desc: 'Upload + Prompt → Image model (img2img)',
    build() {
      const u = addNode('upload', 60, 80);
      const p = addNode('prompt', 60, 340);
      const i = addNode('imageModel', 460, 190);
      link(u, 'image', i, 'image'); link(p, 'text', i, 'prompt');
    },
  },
  {
    name: 'Image to video', desc: 'Prompt → Image model → Video model (first frame)',
    build() {
      const p = addNode('prompt', 60, 200);
      const i = addNode('imageModel', 420, 160);
      const vd = addNode('videoModel', 780, 160);
      link(p, 'text', i, 'prompt'); link(p, 'text', vd, 'prompt'); link(i, 'image', vd, 'image');
    },
  },
];

document.getElementById('btn-templates').addEventListener('click', () => {
  const body = openModal('Templates — start a new project from a pipeline');
  for (const t of TEMPLATES) {
    const card = el('div', { class: 'tpl-card' });
    card.appendChild(el('b', {}, t.name));
    card.appendChild(el('span', {}, t.desc));
    card.addEventListener('click', () => {
      closeModal();
      createProject(t.name, () => t.build());
    });
    body.appendChild(card);
  }
});

// Assets library (session) -----------------------------------------------
const assets = [];
const assetsPanel = document.getElementById('assets');
function addAsset(kind, src, label, thumb) {
  assets.unshift({ kind, src, label: (label || '').slice(0, 120), thumb: thumb || null });
  document.getElementById('assets-count').textContent = assets.length;
  if (!assetsPanel.hidden) renderAssets();
}
function renderAssets() {
  const grid = document.getElementById('assets-grid');
  grid.innerHTML = '';
  if (!assets.length) {
    grid.appendChild(el('div', { class: 'assets-empty' }, 'Nothing generated yet — run a graph and results collect here.'));
    return;
  }
  assets.forEach((a2, idx) => {
    let m;
    if (a2.kind === 'video') {
      m = el('video', { src: a2.src, title: a2.label, loop: '' });
      m.muted = true;
      m.addEventListener('pointerenter', () => m.play());
      m.addEventListener('pointerleave', () => m.pause());
    } else if (a2.kind === 'model') {
      m = a2.thumb
        ? el('img', { src: a2.thumb, title: a2.label + ' (3D — click to download .glb)' })
        : el('div', { class: 'asset-3d', title: a2.label }, '🧊');
    } else {
      m = el('img', { src: a2.src, title: a2.label });
    }
    m.title = (a2.label || '') + (a2.kind === 'model' ? '' : ' — click to view full size');
    m.addEventListener('click', () => {
      if (a2.kind === 'image' || a2.kind === 'video') { openLightbox({ kind: a2.kind, src: a2.src }); return; }
      const link2 = el('a', { href: a2.src, download: `artcanvas-asset-${assets.length - idx}.glb` });
      if (!a2.src.startsWith('data:')) link2.target = '_blank';
      link2.click();
    });
    grid.appendChild(m);
  });
}
document.getElementById('btn-assets').addEventListener('click', () => {
  assetsPanel.hidden = !assetsPanel.hidden;
  if (!assetsPanel.hidden) renderAssets();
});
document.getElementById('assets-close').addEventListener('click', () => { assetsPanel.hidden = true; });

// Agent chat --------------------------------------------------------------
let chatHistory = [];
let chatBusy = false;
const chatCfg = { model: '', imageModel: '', videoModel: '', aspect: '' };
const chatPanel = document.getElementById('chat');
const chatMsgs = document.getElementById('chat-msgs');
const chatInput = document.getElementById('chat-input');

// Reference attachments (images/videos) staged for the next message
let chatAttachments = [];
function renderChatAttachments() {
  const box = document.getElementById('chat-attachments');
  if (!box) return;
  box.innerHTML = '';
  box.hidden = !chatAttachments.length;
  chatAttachments.forEach((a, i) => {
    const chip = el('div', { class: 'attach-chip' });
    chip.appendChild(a.kind === 'video'
      ? Object.assign(el('video', { src: a.src }), { muted: true })
      : el('img', { src: a.src, title: a.name || '' }));
    const x = el('button', { type: 'button', title: 'Remove' }, '✕');
    x.addEventListener('click', () => { chatAttachments.splice(i, 1); renderChatAttachments(); });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}
function addChatAttachments(files) {
  for (const f of files) {
    if (chatAttachments.length >= 9) { toast('Up to 9 references at a time'); break; }
    const kind = (f.type || '').startsWith('video') ? 'video' : 'image';
    const fr = new FileReader();
    fr.onload = () => { chatAttachments.push({ kind, src: fr.result, name: f.name }); renderChatAttachments(); };
    fr.readAsDataURL(f);
  }
}
// place chat-generated media straight onto the canvas (no manual node building)
let chatDropOffset = 0;
function dropChatMediaOnCanvas(kind, src) {
  const rect = viewport.getBoundingClientRect();
  const cx = (rect.width / 2 - panX) / zoom - 130 + chatDropOffset;
  const cy = (rect.height / 2 - panY) / zoom - 90 + chatDropOffset;
  chatDropOffset = (chatDropOffset + 46) % 230;
  // Only images become canvas nodes; video stays in the chat + Assets.
  if (kind === 'image') addNode('upload', cx, cy, { image: src, title: 'Image' });
}

const CHAT_SYSTEM =
  `You are ArtCanvas's creative agent — a friendly creative director chatting inside a node-based AI design studio. ` +
  `Help the user figure out and produce what they want: image prompt packs, scripts, storyboards, cinematic videos, image series.\n` +
  `- Converse naturally. If the request is vague, ask one or two short clarifying questions (subject, style, mood, format, how many) before producing work.\n` +
  `- The user may attach reference images. When present, describe/honour them: match the subject, style, palette or composition, and weave that into the generation prompts.\n` +
  `- Text deliverables: set deliverable.kind to "prompts", "script" or "storyboard", give it a title, and put each item/scene/shot in shots — prompt is the full text of that item, caption a short label (e.g. "Scene 1 — INT. LIGHTHOUSE, NIGHT").\n` +
  `- When the user asks to generate, create, make, render or "put on the canvas" images (or a video), set kind to "images" (or "video") and put final, detailed generation prompts in shots (max 9) with consistent characters, style and lighting. PREFER generating over merely returning prompts — the app renders them straight onto the canvas. Do NOT ask to confirm unless the request is genuinely ambiguous.\n` +
  `- Use kind "prompts"/"script"/"storyboard" only when the user explicitly wants text to review rather than finished images.\n` +
  `- Otherwise set kind "none" with an empty shots array.\n` +
  `- ASPECT RATIO: for every image/video shot include an "aspect" field chosen to fit the request — 9:16 for phone/story/reel/portrait, 16:9 or 21:9 for cinematic/banner/wallpaper/landscape, 4:3 or 3:4 for standard photo, 1:1 ONLY for square posts/avatars/icons. Supported: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16. Never default to 1:1 unless a square is actually wanted; when unsure prefer 16:9.\n` +
  `Reply as JSON only: {"reply": "...", "deliverable": {"kind": "...", "title": "...", "shots": [{"prompt": "...", "caption": "...", "aspect": "16:9"}]}}. Keep replies concise and warm.`;

function chatModelSelect(kind, key) {
  const sel = el('select', { title: `${kind} model used by the chat agent` });
  const avail = MODELS.filter(m => m.kind === kind);
  for (const m of avail) {
    const opt = el('option', { value: m.id }, m.label + (m.available ? '' : ' (no key)'));
    if (!m.available) opt.disabled = true;
    sel.appendChild(opt);
  }
  const prefKey = kind === 'llm' ? 'llm:smart' : kind;
  const firstOk =
    (PREFS[prefKey] && avail.find(m => m.available && m.id === PREFS[prefKey])) ||
    (kind === 'llm' && avail.find(m => m.available && m.tier === 'smart')) ||
    avail.find(m => m.available) || avail[0];
  if (!chatCfg[key] || !avail.some(m => m.id === chatCfg[key])) chatCfg[key] = firstOk?.id || '';
  sel.value = chatCfg[key];
  sel.addEventListener('change', () => { chatCfg[key] = sel.value; setPref(prefKey, sel.value); });
  return sel;
}

function chatAspectSelect() {
  const sel = el('select', { title: 'Aspect ratio for generated images (Auto = the agent picks per request)' });
  for (const [val, label] of RATIO_OPTS) {
    sel.appendChild(el('option', { value: val }, val === 'auto' ? '⬗ Auto ratio' : label));
  }
  if (!chatCfg.aspect) chatCfg.aspect = PREFS['chat:aspect'] || 'auto';
  sel.value = chatCfg.aspect;
  sel.addEventListener('change', () => { chatCfg.aspect = sel.value; setPref('chat:aspect', sel.value); });
  return sel;
}

function buildChatCfg() {
  const cfg = document.getElementById('chat-cfg');
  cfg.innerHTML = '';
  cfg.appendChild(chatModelSelect('llm', 'model'));
  cfg.appendChild(chatModelSelect('image', 'imageModel'));
  cfg.appendChild(chatModelSelect('video', 'videoModel'));
  cfg.appendChild(chatAspectSelect());
}

// Lovart-style quick-start chips shown when the chat is empty
const CHAT_STARTERS = [
  ['🎬 Cinematic trailer', 'Write a cinematic trailer storyboard about … , then generate the shots as images'],
  ['📱 Instagram post', 'Design a bold 1:1 Instagram post visual about … — write the prompt, then generate it'],
  ['🖼 Logo design', 'Design a minimalist logo for … — propose 4 distinct directions, then generate them as images'],
  ['📦 Product shots', 'Create 4 professional product photos of … with consistent studio lighting and background'],
  ['🔁 Repurpose an idea', 'Repurpose this idea across platforms: … — write prompt variants for a 1:1 post, a 9:16 story and a 21:9 banner'],
  ['🎞 One-shot video', 'Create one cinematic 5-second video shot of … — write the perfect prompt first, then generate the video'],
];

function renderChat() {
  if (!chatMsgs) return;
  chatMsgs.innerHTML = '';
  if (!chatHistory.length) {
    const w = el('div', { class: 'cmsg agent' });
    w.appendChild(el('div', { class: 'cbubble' },
      'Hi! I’m your creative agent. Tell me what you’d like to make — a script, a prompt pack, a storyboard, a cinematic video, an image series — and we’ll shape it together.'));
    chatMsgs.appendChild(w);
    const box = el('div', { class: 'starters' });
    box.appendChild(el('div', { class: 'starters-title' }, 'Try one of these'));
    for (const [label, prompt] of CHAT_STARTERS) {
      const chip = el('button', { class: 'starter', type: 'button' }, label);
      chip.addEventListener('click', () => {
        chatInput.value = prompt;
        chatInput.focus();
        // put the caret on the "…" placeholder so the user types their subject
        const dots = chatInput.value.indexOf('…');
        if (dots >= 0) chatInput.setSelectionRange(dots, dots + 1);
        chatInput.dispatchEvent(new Event('input'));
      });
      box.appendChild(chip);
    }
    const allSkills = el('button', { class: 'starter ghost', type: 'button' }, '⚙ Manage skills');
    allSkills.addEventListener('click', () => document.getElementById('btn-skills').click());
    box.appendChild(allSkills);
    chatMsgs.appendChild(box);
    return;
  }
  for (const m of chatHistory) {
    const w = el('div', { class: 'cmsg ' + (m.role === 'user' ? 'user' : 'agent') });
    const b = el('div', { class: 'cbubble' + (m.pending ? ' thinking' : '') });
    b.textContent = m.text;
    if (m.attachments?.length) {
      const g = el('div', { class: 'cmedia refs' });
      for (const at of m.attachments) {
        g.appendChild(at.kind === 'video'
          ? Object.assign(el('video', { src: at.src, controls: '', loop: '' }), { muted: true })
          : el('img', { src: at.src, title: at.name || 'reference' }));
      }
      b.appendChild(g);
    }
    if (m.deliverable?.shots?.length) b.appendChild(renderDeliverable(m.deliverable));
    if (m.media?.length) {
      const g = el('div', { class: 'cmedia' });
      for (const it of m.media) {
        let mm;
        if (it.kind === 'video') { mm = el('video', { src: it.src, controls: '', loop: '', title: it.prompt }); mm.muted = true; }
        else mm = el('img', { src: it.src, title: it.prompt });
        mm.addEventListener('click', () => {
          const a = el('a', { href: it.src, download: `artcanvas-chat.${it.kind === 'video' ? 'mp4' : 'png'}` });
          if (!it.src.startsWith('data:')) a.target = '_blank';
          a.click();
        });
        g.appendChild(mm);
      }
      b.appendChild(g);
    }
    w.appendChild(b);
    chatMsgs.appendChild(w);
  }
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
}

function renderDeliverable(d) {
  const card = el('div', { class: 'deliv' });
  const head = el('div', { class: 'deliv-title' });
  head.appendChild(el('span', {}, `${d.kind.toUpperCase()} — ${d.title || 'Untitled'}`));
  const btns = el('div', { class: 'deliv-btns' });
  const fullText = d.shots.map((s, i) => `${s.caption || `#${i + 1}`}\n${s.prompt}`).join('\n\n');
  const copy = el('button', {}, 'Copy');
  copy.addEventListener('click', () => { navigator.clipboard?.writeText(fullText); copy.textContent = '✓'; setTimeout(() => copy.textContent = 'Copy', 1200); });
  const toCanvas = el('button', {}, 'To canvas');
  toCanvas.addEventListener('click', () => {
    const rect = viewport.getBoundingClientRect();
    const cx = (rect.width / 2 - panX) / zoom - 130;
    const cy = (rect.height / 2 - panY) / zoom - 90;
    const n = addNode('prompt', cx, cy, { text: fullText });
    selectNode(n.id);
    redrawEdges();
    toast('Added to canvas as a Prompt node');
  });
  btns.appendChild(copy);
  btns.appendChild(toCanvas);
  // Turn a set of prompts into actual images, dropped on the canvas.
  if (d.kind !== 'video') {
    const gen = el('button', { class: 'gen' }, '🎨 Generate on canvas');
    gen.addEventListener('click', () => generateDeliverable(d, gen));
    btns.appendChild(gen);
  }
  head.appendChild(btns);
  card.appendChild(head);
  const body = el('div', { class: 'deliv-body' });
  d.shots.forEach((s, i) => {
    const row = el('div', { class: 'deliv-shot' });
    row.appendChild(el('b', {}, s.caption || `#${i + 1}`));
    row.appendChild(el('p', {}, s.prompt));
    body.appendChild(row);
  });
  card.appendChild(body);
  return card;
}

async function sendChat(text) {
  if (chatBusy) return;
  chatBusy = true;
  document.getElementById('chat-send').disabled = true;
  const attachments = chatAttachments.slice();
  chatAttachments = []; renderChatAttachments();
  const refImgs = attachments.filter(a => a.kind === 'image').map(a => a.src);
  chatHistory.push({ role: 'user', text, attachments });
  const pending = { role: 'assistant', text: 'Thinking…', pending: true };
  chatHistory.push(pending);
  renderChat();
  try {
    // token diet: last 12 turns, long messages truncated, deliverables referenced by title only
    const transcript = chatHistory
      .filter(m => !m.pending)
      .slice(-12)
      .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text.length > 600 ? m.text.slice(0, 600) + '…' : m.text}${m.deliverable?.shots?.length ? `\n[delivered ${m.deliverable.kind}: ${m.deliverable.title}]` : ''}`)
      .join('\n');
    const r = await api(chatCfg.model, { prompt: transcript + '\nAgent:', system: CHAT_SYSTEM, format: 'chat', maxTokens: 4000, images: refImgs.length ? refImgs : undefined });
    let parsed;
    try { parsed = JSON.parse(r.text); } catch {
      const m = r.text.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch { /* fall through */ }
    }
    if (!parsed?.reply) parsed = { reply: r.text, deliverable: { kind: 'none', title: '', shots: [] } };
    const d = parsed.deliverable || { kind: 'none', shots: [] };
    pending.pending = false;
    pending.text = parsed.reply;
    if (d.kind !== 'none' && d.shots?.length) pending.deliverable = { kind: d.kind, title: d.title, shots: d.shots.slice(0, 9) };
    renderChat();
    save();
    if ((d.kind === 'images' || d.kind === 'video') && d.shots?.length) {
      await runChatGeneration(d.kind === 'video' ? 'video' : 'image', d.shots.slice(0, 9), refImgs);
    }
  } catch (err) {
    pending.pending = false;
    pending.text = '⚠ ' + err.message;
    renderChat();
  }
  chatBusy = false;
  document.getElementById('chat-send').disabled = false;
  chatInput.focus();
}

async function generateDeliverable(d, btn) {
  if (chatBusy) { toast('Busy — wait for the current task to finish'); return; }
  if (!d.shots?.length) return;
  chatBusy = true;
  document.getElementById('chat-send').disabled = true;
  if (btn) { btn.disabled = true; btn.textContent = '🎨 Generating…'; }
  await runChatGeneration('image', d.shots.slice(0, 9), null);
  chatBusy = false;
  document.getElementById('chat-send').disabled = false;
  if (btn) { btn.disabled = false; btn.textContent = '🎨 Generate on canvas'; }
}

async function runChatGeneration(kind, shots, refImgs) {
  const model = kind === 'video' ? chatCfg.videoModel : chatCfg.imageModel;
  const msg = { role: 'assistant', text: `Generating ${kind} 1/${shots.length}…`, media: [], pending: true };
  chatHistory.push(msg);
  renderChat();
  try {
    for (let i = 0; i < shots.length; i++) {
      msg.text = `Generating ${kind} ${i + 1}/${shots.length}…`;
      renderChat();
      const forced = chatCfg.aspect && chatCfg.aspect !== 'auto' ? chatCfg.aspect : null;
      const g = kind === 'video'
        ? await api(model, { prompt: shots[i].prompt, duration: shots[i].duration || '5', ratio: forced || shots[i].aspect || shots[i].ratio || '16:9', image: refImgs?.[0] })
        : await api(model, { prompt: shots[i].prompt, aspect: forced || shots[i].aspect || '16:9', images: refImgs?.length ? refImgs : undefined });
      const src = kind === 'video' ? g.video : g.image;
      msg.media.push({ kind, src, prompt: shots[i].prompt });
      addAsset(kind, src, shots[i].prompt);
      dropChatMediaOnCanvas(kind, src); // land it on the canvas — no manual nodes needed
      renderChat();
    }
    msg.text = `Done — ${msg.media.length} ${kind}${msg.media.length > 1 ? 's' : ''} generated, added to the canvas and your Assets.`;
  } catch (err) {
    msg.text = `⚠ Generation failed: ${err.message}`;
  }
  msg.pending = false;
  renderChat();
  save();
}

document.getElementById('btn-chat').addEventListener('click', () => {
  chatPanel.hidden = !chatPanel.hidden;
  if (!chatPanel.hidden) { buildChatCfg(); renderChat(); chatInput.focus(); }
});
document.getElementById('btn-director').addEventListener('click', openDirector);
document.getElementById('chat-close').addEventListener('click', () => { chatPanel.hidden = true; });
document.getElementById('chat-attach-btn').addEventListener('click', () => document.getElementById('chat-attach-input').click());
document.getElementById('chat-attach-input').addEventListener('change', (e) => { addChatAttachments(e.target.files); e.target.value = ''; });
document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || chatBusy) return;
  chatInput.value = '';
  chatInput.style.height = 'auto';
  sendChat(text);
});
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('chat-form').requestSubmit(); }
});
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 110) + 'px';
});

// Init -----------------------------------------------------------------
(async function init() {
  try { MODELS = await (await fetch('/api/models')).json(); } catch { MODELS = []; }
  // load or bootstrap projects (migrating the old single-graph save if present)
  try {
    const meta = JSON.parse(localStorage.getItem('artcanvas-projects'));
    if (meta?.list?.length) projects = meta;
  } catch { /* fresh start */ }
  if (!projects.list.length) {
    const id = newProjectId();
    projects = { list: [{ id, name: 'Untitled project', updatedAt: Date.now() }], current: id };
    const legacy = localStorage.getItem('artcanvas-graph');
    if (legacy) {
      localStorage.setItem(projKey(id), legacy);
      localStorage.removeItem('artcanvas-graph');
    }
    saveProjectsMeta();
  }
  if (!projects.list.some(p => p.id === projects.current)) projects.current = projects.list[0].id;
  await cloudPull(); // merge server-stored projects (newest wins) before opening
  if (!projects.list.some(p => p.id === projects.current)) projects.current = projects.list[0].id;
  applyTransform();

  // landing-page deep links: ?project=<id> | ?new=1 | ?template=<index>
  const params = new URLSearchParams(location.search);
  const wantProject = params.get('project');
  const wantTemplate = params.get('template');
  if (wantTemplate !== null && TEMPLATES[Number(wantTemplate)]) {
    const t = TEMPLATES[Number(wantTemplate)];
    createProject(t.name, () => t.build(), { skipSaveCurrent: true });
  } else if (params.get('new')) {
    createProject('Untitled project', null, { skipSaveCurrent: true });
  } else if (wantProject && projects.list.some(p => p.id === wantProject)) {
    openProject(wantProject, { skipSaveCurrent: true });
  } else {
    openProject(projects.current, { skipSaveCurrent: true });
  }
  if (location.search) history.replaceState({}, '', 'canvas.html');
})();
