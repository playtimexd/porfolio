# ArtCanvas Studio — node-based multi-provider AI design tool

Weavy-style node graph editor: wire **Prompt → LLM → Image Model → Output**, or
**Prompt + Image Upload → Video Model**, pick a model per node, and run the graph.

## Run

```
node server.js
```

Open http://localhost:3000 — this is the **home page**: hero, feature overview, template
quick-starts, and your auto-saved project list. The editor lives at `/canvas.html` and
opens via the home page (Open Studio / ＋ New project / a template / a project card).
New projects start with a completely **empty canvas**. Zero dependencies, Node 18+.

## Storage & deployment

**Projects sync to the server automatically** (as well as the browser's localStorage):
- No config → stored on local disk in `./data`
- Cloud → set `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET` in `.env`
  (free Supabase project + a private storage bucket named `artcanvas`)

**Deploy** — the repo ships with a `Dockerfile` (works on Railway / Fly.io / any container
host) and a `render.yaml` blueprint:
1. Push this repo to GitHub
2. On [render.com](https://render.com): New → Blueprint → select the repo
3. Fill the env vars (API keys + Supabase) when prompted — never commit `.env`
4. Done: the landing page, canvas, agent chat and project sync are all served by the one
   Node process

## Providers & keys (.env)

| Provider | Key | Models (kind, tier) |
|---|---|---|
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | claude-opus-4-8 (llm, smart), claude-haiku-4-5 (llm, fast) |
| OpenAI | `OPENAI_API_KEY` | gpt-5.5 (llm, smart), gpt-5.4-mini (llm, fast), gpt-image-2 / 1.5 / 1 (image), sora-2 / sora-2-pro (video) |
| Google Gemini | `GEMINI_API_KEY` | gemini-2.5-pro (llm, smart), gemini-2.5-flash (llm, fast), gemini-2.5-flash-image (image) |
| Seedance (BytePlus ModelArk) | `SEEDANCE_API_KEY` | set `SEEDANCE_MODEL` to the exact id from your Ark console |

### Token optimization (task-based model routing)

Every LLM has a **tier** (`smart` / `fast`), and each task uses the cheapest tier that
does the job well, with a per-task output cap:

| Task | Default tier | Output cap |
|---|---|---|
| Chat agent (creative director) | smart | 4,000 tokens |
| Agent orchestrator (writes the shot script) | smart | 4,000 tokens |
| Sub-agents (per-shot refinement) | **fast — auto-routed** to the same provider's cheap model | 800 tokens each |
| LLM node (prompt rewriting) | fast (default; switchable) | 2,000 tokens |

The chat also trims its context (last 12 turns, long messages truncated, past
deliverables referenced by title only) to keep input tokens down. Overrides: pick any
model in the dropdowns; sub-agents always follow the orchestrator's provider at the fast
tier. Env overrides: `CHAT_MODEL_FAST`, `ANTHROPIC_MODEL`, etc.

Models with no key configured appear disabled ("no key") in node dropdowns.

## Adding a future model / provider

Open `server.js`:

1. **Existing provider** — add one line to the `MODELS` registry:
   `{ id: 'new-model-id', label: 'Nice Name', provider: 'openai', kind: 'image' }`
2. **New provider** — add an entry to `providers` implementing the kinds it supports
   (`llm(model, {prompt})`, `image(model, {prompt, image, aspect})`,
   `video(model, {prompt, image, duration, ratio})`), plus its key in `KEYS`.

The frontend picks up new models automatically via `/api/models`.

## Node types

- **Prompt** — type directly inside the node (or in the properties panel) → `text`
- **LLM** — enhances/transforms text (instruction + input) → `text`
- **Image Model** — `prompt` (+ optional `image` refs) → `image`. Aspect ratios from 21:9
  to 9:16 (Gemini honours all of them; GPT Image maps to its nearest canvas) and quality
  Auto / Standard 1K / High 2K / Ultra 4K (Gemini `imageSize`; GPT `quality`).
- **Video Model** — `prompt` (+ optional first-frame `image`) → `video`; long-polls until
  done. Ratios 16:9 / 21:9 / 4:3 / 1:1 / 3:4 / 9:16 and quality Auto / 720p / 1080p
  (1080p-class needs Sora 2 Pro or Seedance).
- **Image Upload** — local file → `image`
- **Agent** — `brief` → an orchestrator LLM (Claude by default) writes a script of N
  sequential shot prompts with consistent characters/style, then the node generates every
  shot (images or videos) into a gallery; outputs the `script` as text. Two modes:
  - *Orchestrator only* — one LLM call writes all shot prompts
  - *Orchestrator + sub-agents* — the orchestrator plans the series, then each shot is
    handed to its own sub-agent LLM call (run in parallel) that specialises on that one
    shot while keeping series continuity — the Claude Code orchestrator/sub-agent pattern.
  Attach **Skills** to guide the orchestrator and all sub-agents.
- **Output** — previews text/image/video, download button

## Connections

Wires are typed (purple = text, blue = image, orange = video); an input accepts a matching
type, and Output accepts anything. Outputs can fan out to many inputs; an input holds one
wire (reconnecting replaces it); self-loops and cycles are rejected.

| From → To | LLM | Image Model | Video Model | Agent | Output |
|---|---|---|---|---|---|
| **Prompt / LLM / Agent script** (text) | prompt | prompt | prompt | brief | ✓ |
| **Upload / Image Model** (image) | image (vision, up to 9) | image (edit / img2img, up to 9) | image (first frame; up to 9, Sora uses 1) | reference (up to 9) | ✓ |
| **Video Model** (video) | — | — | — | — | ✓ |

Image inputs work end-to-end: LLMs receive the image for vision (describe/critique),
GPT Image uses the edits endpoint for image-to-image, Sora takes it as the first-frame
reference, Gemini and Seedance use their native image inputs.

## Agent chat (💬 Chat button)

A conversational creative director, Lovart-style. Tell it what you want to make — a script,
a prompt pack, a storyboard, a cinematic video, an image series — and it asks short
clarifying questions, then delivers:

- **Text deliverables** (prompts / script / storyboard) appear as cards in the chat with
  per-scene captions, a **Copy** button, and **To canvas** (drops the whole deliverable
  into a Prompt node so you can wire it into a pipeline).
- **Generation**: when you ask it to generate, it produces the shots and renders each
  image/video right in the chat (max 9 per request) — results also land in Assets.
- The three selectors at the top pick which LLM (Claude recommended), image model and
  video model the chat agent uses.
- Conversations are saved per project (media excluded to keep storage small).

## Projects, skills & library

- **Projects** — top-bar selector with ＋ new / ✎ rename / 🗑 delete. Every project
  auto-saves to localStorage on each change and persists until you delete it.
- **Skills** (Claude Code-style) — reusable instruction packs (name + instructions) managed
  via the Skills button. Attach them to LLM and Agent nodes in the properties panel; they
  are injected as system instructions for the LLM, the orchestrator, and every sub-agent.
- **Templates** — one-click starter pipelines: Enhance & generate, Agent storyboard,
  Image remix, Image to video. Each opens as a new project.
- **Assets** — every generated image/video this session collects in the Assets drawer
  (left panel); click any thumbnail to download.
- **Export / Import** — ⤓ downloads the current project as JSON (including uploads);
  ⤒ imports one as a new project. Use this to share or back up workflows.

## Editor (Weavy-style)

- **Bottom dock** — add nodes; or **double-click the canvas** for a searchable quick-add palette
- **Right properties panel** — settings for the selected node (prompt text, model, aspect, duration…)
- **Image-first nodes** — the generated media is the node body; pins sit on the side edges (colors = data type)
- **⋯ menu on each node** — Run / Duplicate / Download / Delete
- **Minimap** (bottom-right) — click to jump; white rectangle is the current view
- Wires animate while a node is generating; errors show inline on the node
- Shortcuts: `Ctrl+D` duplicate · `Del` delete · `F` fit view · scroll = zoom · drag canvas = pan
- Editable workflow name in the top bar; graph autosaves to localStorage
