import { getMic } from './audio'

/**
 * The voice lock: JARVIS answers one person.
 *
 * The wake word says *what* was said; nothing in the loop knew *who* said it,
 * so anyone in the room — a sibling, a video, a guest — could ask him to do
 * things. This module tells voices apart.
 *
 * It works by voiceprint. A speaker-verification model (WeSpeaker ResNet34,
 * trained on VoxCeleb for exactly this) turns a few seconds of speech into a
 * 256-number embedding that is close for the same voice and far for different
 * ones, whatever the words or the language.
 * Enrolment averages a handful of those into one voiceprint; after that every
 * utterance is embedded and compared by cosine similarity, and anything below
 * the threshold is dropped before it can become a turn.
 *
 * WavLM's x-vector head was tried first and is not good enough: on public
 * recordings different speakers scored 0.75–0.85 against same-speaker 0.90,
 * too close to set a threshold between. WeSpeaker put different speakers under
 * 0.2 and the same speaker above 0.5, even on a one-second clip.
 *
 * All of it runs in the browser. The model is downloaded once from Hugging Face
 * and cached by the browser; no audio ever leaves the machine for this, and
 * no account or key is needed. The voiceprint lives in localStorage.
 *
 * What it is not: a security boundary. A recording of your voice will pass.
 * It stops JARVIS answering other people; it does not stop someone determined.
 * The write gate in the bridge is still what protects anything that matters.
 */

const MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM'
const RATE = 16000

/** How much recent microphone audio is kept, for the engine that cannot hand
 *  us its own recording (the browser's SpeechRecognition). */
const RING_SECONDS = 12

/** Less voiced audio than this carries too little of a voice to judge. */
const MIN_VOICED_S = 0.35

const PRINT_KEY = 'jarvis.voiceprint'
const THRESHOLD_KEY = 'jarvis.voicelock.threshold'
/** Cosine similarity needed to count as you. Tunable from the panel (L);
 *  enrolment replaces it with one fitted to how consistent your samples were. */
export const DEFAULT_THRESHOLD = 0.42

export type Verdict = {
  ok: boolean
  /** Similarity to the voiceprint, or null when nothing was compared. */
  score: number | null
  why: string
}

type Print = { v: number[]; samples: number; at: number }

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Published on `window.__voicelock`, read by the diagnostics and lock panels. */
export const lockDiag = {
  enrolled: false,
  model: 'idle' as 'idle' | 'loading' | 'ready' | 'failed',
  /** 0..1 while the model downloads. */
  progress: 0,
  error: '',
  checks: 0,
  rejected: 0,
  lastScore: null as number | null,
  lastOk: true,
  lastWhy: '',
  /** Every "Test a voice" from the panel, for tuning the threshold. */
  tests: [] as { score: number | null; voiced: number; at: number }[],
  /** The last 40 live checks, newest last — why each was let in or kept out. */
  history: [] as { ok: boolean; score: number | null; why: string; at: number; heardS: number; voicedS: number }[],
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__voicelock = lockDiag
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function readPrint(): Float32Array | null {
  try {
    const raw = localStorage.getItem(PRINT_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Print
    return Array.isArray(p.v) && p.v.length ? Float32Array.from(p.v) : null
  } catch {
    return null
  }
}

let print: Float32Array | null = readPrint()
lockDiag.enrolled = print !== null

export const locked = () => print !== null

/**
 * True while the voice-lock panel is open. Half the enrolment lines start
 * with "Hey Jarvis", so the voice loop stands deaf meanwhile — otherwise he
 * wakes up and starts answering in the middle of the recording.
 */
let enrolling = false
export const isEnrolling = () => enrolling
export const setEnrolling = (on: boolean) => {
  enrolling = on
}

export function threshold(): number {
  try {
    const t = Number(localStorage.getItem(THRESHOLD_KEY))
    return t > 0 && t < 1 ? t : DEFAULT_THRESHOLD
  } catch {
    return DEFAULT_THRESHOLD
  }
}

export function setThreshold(t: number) {
  try {
    localStorage.setItem(THRESHOLD_KEY, String(t))
  } catch {
    /* private window — the default still applies */
  }
}

/** Turn the lock off: anyone can talk to him again. */
export function forget() {
  print = null
  lockDiag.enrolled = false
  try {
    localStorage.removeItem(PRINT_KEY)
  } catch {
    /* nothing stored */
  }
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

type Embedder = (pcm: Float32Array) => Promise<Float32Array>
let embedder: Promise<Embedder> | null = null

function loadModel(): Promise<Embedder> {
  if (embedder) return embedder
  lockDiag.model = 'loading'
  lockDiag.error = ''
  const files = new Map<string, number>()
  embedder = (async () => {
    const { AutoProcessor, AutoModel, env } = await import('@huggingface/transformers')
    // The runtime is served from our own origin (see ortRuntime in
    // vite.config.ts); the CDN it would otherwise fetch is refused by the CSP.
    const wasm = env.backends.onnx.wasm
    if (wasm) wasm.wasmPaths = '/ort/'
    const onProgress = (p: { status?: string; file?: string; progress?: number }) => {
      if (p.status !== 'progress' || !p.file) return
      files.set(p.file, (p.progress ?? 0) / 100)
      let sum = 0
      for (const v of files.values()) sum += v
      lockDiag.progress = sum / files.size
    }
    const processor = await AutoProcessor.from_pretrained(MODEL, {
      progress_callback: onProgress,
    })
    const model = await AutoModel.from_pretrained(MODEL, {
      progress_callback: onProgress,
    })
    lockDiag.model = 'ready'
    lockDiag.progress = 1
    return async (pcm: Float32Array) => {
      const inputs = await processor(pcm)
      // This export names its one output generically; it is the embedding.
      const out = (await model(inputs)) as { last_hidden_state: { data: Float32Array } }
      return normalise(Float32Array.from(out.last_hidden_state.data))
    }
  })().catch((err) => {
    lockDiag.model = 'failed'
    lockDiag.error = err instanceof Error ? err.message : String(err)
    embedder = null
    throw err
  })
  return embedder
}

/**
 * One inference at a time. The ONNX session refuses overlapping runs, and the
 * wake word, a barge-in check and an utterance can all arrive together.
 */
let queue: Promise<unknown> = Promise.resolve()
function embed(pcm: Float32Array): Promise<Float32Array> {
  const run = queue.then(async () => (await loadModel())(pcm))
  queue = run.catch(() => {})
  return run
}

function normalise(v: Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

/** Both inputs are unit vectors, so the dot product is the cosine. */
function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0
  for (let i = 0; i < a.length; i++) d += a[i] * b[i]
  return d
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

const ring = new Float32Array(RATE * RING_SECONDS)
let write = 0
let filled = 0
let tap: AudioContext | null = null
const audioListeners = new Set<(chunk: Float32Array) => void>()

/** Every chunk of 16kHz microphone audio as it arrives — wakeword.ts listens
 *  here, so the microphone is opened once for both. */
export function onAudio(fn: (chunk: Float32Array) => void): () => void {
  audioListeners.add(fn)
  void startTap()
  return () => audioListeners.delete(fn)
}

/**
 * Keep the last few seconds of the microphone at 16kHz.
 *
 * The ElevenLabs path hands us each segment as a recording, but the browser
 * recogniser keeps its audio to itself — so for that engine, "what did the last
 * utterance sound like" can only be answered from a copy we kept ourselves.
 * The barge-in check uses it on both engines.
 */
async function startTap() {
  if (tap) return
  const stream = await getMic()
  const ctx = new AudioContext({ sampleRate: RATE })
  tap = ctx
  void ctx.resume()
  const src = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(2048, 1, 1)
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0)
    for (let i = 0; i < d.length; i++) {
      ring[write] = d[i]
      write = (write + 1) % ring.length
    }
    filled = Math.min(ring.length, filled + d.length)
    if (audioListeners.size) {
      const copy = d.slice()
      for (const fn of audioListeners) fn(copy)
    }
  }
  // A processor only runs when connected to the output; a muted gain keeps the
  // microphone out of the speakers.
  const mute = ctx.createGain()
  mute.gain.value = 0
  src.connect(proc)
  proc.connect(mute)
  mute.connect(ctx.destination)
}

/** The last `ms` of microphone audio, oldest sample first. */
function recent(ms: number): Float32Array {
  const n = Math.min(filled, Math.round((ms / 1000) * RATE))
  const out = new Float32Array(n)
  let r = (write - n + ring.length) % ring.length
  for (let i = 0; i < n; i++) {
    out[i] = ring[r]
    r = (r + 1) % ring.length
  }
  return out
}

const FRAME = RATE / 50 // 20ms

function frameLevels(pcm: Float32Array): number[] {
  const out: number[] = []
  for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
    let s = 0
    for (let j = i; j < i + FRAME; j++) s += pcm[j] * pcm[j]
    out.push(Math.sqrt(s / FRAME))
  }
  return out
}

/**
 * Find the speech in a clip: trim the quiet either side, and measure how much
 * of what is left is actually voice.
 *
 * Silence around an utterance pulls every embedding towards the same "nobody"
 * point, so the ends are cut. The middle is left alone: splicing out the gaps
 * between words leaves a click at every join, and the model hears the clicks —
 * doing that dropped two halves of one recording to 0.35 similarity.
 *
 * The gate is relative to the loudest part of the clip and nothing else. It
 * used to be raised by the room's noise floor too, and in a noisy room with
 * automatic gain that floor sits close to speech — so real speech fell under
 * it and two checks in three were refused as "too short" without ever being
 * compared. Telling noise from a voice is the model's job, and it does it
 * well: a clip of room noise scores about 0.1 against a voiceprint.
 */
function speech(pcm: Float32Array): { clip: Float32Array; voicedS: number } {
  const F = FRAME
  const frames = frameLevels(pcm)
  if (!frames.length) return { clip: new Float32Array(0), voicedS: 0 }
  const sorted = [...frames].sort((a, b) => a - b)
  const loud = sorted[Math.floor(sorted.length * 0.95)]
  const gate = Math.max(0.002, loud * 0.12)
  let first = -1
  let last = -1
  let count = 0
  frames.forEach((e, k) => {
    if (e < gate) return
    if (first < 0) first = k
    last = k
    count++
  })
  if (first < 0) return { clip: new Float32Array(0), voicedS: 0 }
  // A little air either side keeps the first and last syllables whole.
  const pad = 5
  const from = Math.max(0, first - pad) * F
  const to = Math.min(frames.length, last + 1 + pad) * F
  return { clip: pcm.slice(from, to), voicedS: (count * F) / RATE }
}

/** A recorded segment, decoded and resampled to 16kHz mono. */
async function decode(blob: Blob): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, RATE, RATE)
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
  if (buf.numberOfChannels === 1) return buf.getChannelData(0)
  const out = new Float32Array(buf.length)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels
  }
  return out
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const OPEN: Verdict = { ok: true, score: null, why: 'voice lock off' }

function record(v: Verdict, pcm?: Float32Array): Verdict {
  lockDiag.checks++
  if (!v.ok) lockDiag.rejected++
  lockDiag.lastScore = v.score
  lockDiag.lastOk = v.ok
  lockDiag.lastWhy = v.why
  lockDiag.history.push({
    ok: v.ok,
    score: v.score,
    why: v.why,
    at: Date.now(),
    heardS: pcm ? pcm.length / RATE : 0,
    voicedS: pcm ? speech(pcm).voicedS : 0,
  })
  if (lockDiag.history.length > 40) lockDiag.history.shift()
  return v
}

/** Similarity of raw audio to the voiceprint, or null if too little voice. */
export async function score(pcm: Float32Array): Promise<number | null> {
  if (!print) return null
  const { clip, voicedS } = speech(pcm)
  if (voicedS < MIN_VOICED_S) return null
  return cosine(await embed(clip), print)
}

async function verifyPcm(pcm: Float32Array): Promise<Verdict> {
  if (!print) return OPEN
  try {
    const s = await score(pcm)
    if (s === null) return record({ ok: false, score: null, why: 'too short to recognise' }, pcm)
    const ok = s >= threshold()
    return record({ ok, score: s, why: ok ? 'your voice' : 'not your voice' }, pcm)
  } catch (err) {
    // Fail closed. With a voiceprint saved, "only me" is the promise — an
    // assistant that quietly starts answering everyone because a download
    // failed would break it without saying so.
    return record({
      ok: false,
      score: null,
      why: `voice lock unavailable: ${err instanceof Error ? err.message : err}`,
    })
  }
}

/** Check a recorded segment (the ElevenLabs path). */
export async function verifyAudio(blob: Blob): Promise<Verdict> {
  if (!print) return OPEN
  try {
    return await verifyPcm(await decode(blob))
  } catch {
    // A segment the browser cannot decode can still be judged from the ring.
    return verifyRecent(4000)
  }
}

/** Check the last `ms` of microphone audio (the browser-recogniser path). */
export function verifyRecent(ms: number): Promise<Verdict> {
  if (!print) return Promise.resolve(OPEN)
  return verifyPcm(recent(ms))
}

/**
 * Wait until `ms` of the speech that just started has been heard, then check it.
 * Used for barge-in, so someone else talking does not cut JARVIS off.
 */
export async function verifySoon(ms: number): Promise<Verdict> {
  if (!print) return OPEN
  await new Promise((r) => setTimeout(r, ms))
  return verifyRecent(ms + 200)
}

/**
 * Start listening for the lock: open the audio tap, and fetch the model now if
 * a voiceprint exists, so the first "Hey Jarvis" is not waiting on a download.
 */
export async function prepare(): Promise<void> {
  await startTap()
  if (print) void loadModel().catch(() => {})
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/** Record `ms` of microphone audio for enrolment or a test. */
export async function capture(ms: number): Promise<Float32Array> {
  await startTap()
  // The tap may have been created just now; let it fill before reading.
  await new Promise((r) => setTimeout(r, ms))
  return recent(ms)
}

/** Seconds of actual voice in a capture — for telling the user to speak up. */
export const voicedSeconds = (pcm: Float32Array) => speech(pcm).voicedS

/** Fetch the model ahead of enrolment, reporting progress through lockDiag. */
export const loadForEnrolment = () => loadModel().then(() => undefined)

/**
 * Save a voiceprint from several recordings.
 * Returns the lowest similarity between any two of them — how consistent the
 * samples were, which is also a good guide to where the threshold can sit.
 */
export async function enrol(samples: Float32Array[]): Promise<{ consistency: number }> {
  const embs: Float32Array[] = []
  for (const s of samples) {
    const { clip, voicedS } = speech(s)
    if (voicedS < MIN_VOICED_S) continue
    embs.push(await embed(clip))
  }
  if (embs.length < 2) throw new Error('Not enough speech was recorded. Speak a little louder and try again.')

  const mean = new Float32Array(embs[0].length)
  for (const e of embs) for (let i = 0; i < e.length; i++) mean[i] += e[i] / embs.length
  normalise(mean)

  let consistency = 1
  for (let i = 0; i < embs.length; i++)
    for (let j = i + 1; j < embs.length; j++) consistency = Math.min(consistency, cosine(embs[i], embs[j]))

  print = mean
  lockDiag.enrolled = true
  try {
    localStorage.setItem(
      PRINT_KEY,
      JSON.stringify({ v: Array.from(mean), samples: embs.length, at: Date.now() } satisfies Print),
    )
  } catch {
    /* kept for this page only */
  }
  return { consistency }
}
