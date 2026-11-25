import * as speaker from './speaker'

/**
 * "Hey Saji", recognised from the sound itself rather than from a transcript.
 *
 * Why this exists. The wake word used to be found in what the transcriber
 * wrote down, and a transcriber has never heard of Saji: with an Indian accent
 * it comes back as Sushi, Sergey, Sadie, Saggy — or "Hey, said she" — and a
 * name that only works when the spelling happens to come out right does not
 * work. There is no pretrained "Hey Saji" model to download, so this builds a
 * personal one from your own recordings, in the browser, in a few seconds.
 *
 * How. openWakeWord ships two small, general models (Apache-2.0): one turns
 * audio into a mel spectrogram, the other turns 0.76s of spectrogram into a
 * 96-number "what did that sound like" vector, every 80ms. Its pretrained wake
 * words are classifiers on top of those vectors. Here the classifier is
 * replaced by template matching: each of your recordings of "Hey Saji" becomes
 * a short sequence of those vectors, and the live stream is compared against
 * every template with dynamic time warping, so saying it faster or slower
 * still matches. A handful of recordings is enough because the vectors already
 * capture the sound; nothing is trained.
 *
 * It is tuned to your voice saying it, which is the point — and the voice lock
 * still checks who is speaking before anything is acted on.
 *
 * Everything runs locally. No audio leaves the machine for this.
 */

const RATE = 16000
/** New audio per step: 80ms, the embedding model's hop. */
const HOP = 1280
/** The mel model needs 480 samples of context to produce 8 frames from 1280. */
const MEL_CONTEXT = 480
/** One embedding looks at 76 mel frames (~0.76s). */
const WINDOW = 76
const MEL_BINS = 32
const EMB = 96

const STORE_KEY = 'jarvis.wakeword'
const THRESHOLD_KEY = 'jarvis.wakeword.threshold'
const DEFAULT_THRESHOLD = 0.55
/** After a detection, ignore the rest of the same phrase. */
const REFRACTORY_MS = 1500
/** A live match may take at most this many times as long as the template. */
const MAX_STRETCH = 2

type Ort = typeof import('onnxruntime-web')
type Session = import('onnxruntime-web').InferenceSession

type Stored = { templates: number[][][]; mean?: number[]; at: number }

export const wakeDiag = {
  /** 'off' until there are templates; then loading → ready, or failed. */
  model: 'off' as 'off' | 'loading' | 'ready' | 'failed',
  error: '',
  templates: 0,
  /** Best score in the last second, for the meter in the L panel. */
  live: 0,
  /** Highest score seen since load — how close a miss came. */
  peak: 0,
  fires: 0,
  lastFire: 0,
  lastScore: 0,
  history: [] as { at: number; score: number }[],
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__wakeword = wakeDiag
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

let ort: Ort | null = null
let mel: Session | null = null
let emb: Session | null = null
let loading: Promise<void> | null = null

function loadModels(): Promise<void> {
  if (loading) return loading
  wakeDiag.model = 'loading'
  loading = (async () => {
    const o = await import('onnxruntime-web')
    // The same runtime files speaker.ts uses, served locally: the CSP refuses
    // the CDN this would otherwise fetch them from.
    o.env.wasm.wasmPaths = '/ort/'
    o.env.wasm.numThreads = 1
    const opts = { executionProviders: ['wasm'] }
    const [m, e] = await Promise.all([
      o.InferenceSession.create('/models/oww/melspectrogram.onnx', opts),
      o.InferenceSession.create('/models/oww/embedding_model.onnx', opts),
    ])
    ort = o
    mel = m
    emb = e
    wakeDiag.model = 'ready'
  })().catch((err) => {
    wakeDiag.model = 'failed'
    wakeDiag.error = String((err as Error)?.message ?? err)
    loading = null
    throw err
  })
  return loading
}

/** Audio in [-1, 1] → mel frames, flat [frames × 32], openWakeWord's scaling. */
async function melFrames(pcm: Float32Array): Promise<Float32Array> {
  const x = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) x[i] = pcm[i] * 32767
  const out = await mel!.run({ input: new ort!.Tensor('float32', x, [1, x.length]) })
  const d = out.output.data as Float32Array
  const y = new Float32Array(d.length)
  for (let i = 0; i < d.length; i++) y[i] = d[i] / 10 + 2
  return y
}

/** Embeddings for every 76-frame window starting at 0, 8, 16, … */
async function embeddings(frames: Float32Array): Promise<Float32Array[]> {
  const n = frames.length / MEL_BINS
  const starts: number[] = []
  for (let s = 0; s + WINDOW <= n; s += 8) starts.push(s)
  if (!starts.length) return []
  const batch = new Float32Array(starts.length * WINDOW * MEL_BINS)
  starts.forEach((s, b) =>
    batch.set(frames.subarray(s * MEL_BINS, (s + WINDOW) * MEL_BINS), b * WINDOW * MEL_BINS),
  )
  const out = await emb!.run({
    input_1: new ort!.Tensor('float32', batch, [starts.length, WINDOW, MEL_BINS, 1]),
  })
  const d = out.conv2d_19.data as Float32Array
  return starts.map((_, b) => d.slice(b * EMB, (b + 1) * EMB))
}

function unit(v: Float32Array): Float32Array {
  let s = 0
  for (const x of v) s += x * x
  const k = 1 / (Math.sqrt(s) || 1)
  return v.map((x) => x * k)
}

/**
 * Every embedding of anything shares a large common part — two unrelated
 * sounds score 0.7 against each other raw — so the average embedding of your
 * room and voice is taken off before comparing. What is left is what makes
 * "Hey Saji" sound unlike everything else you say.
 */
let mean = new Float32Array(EMB)
function feat(v: Float32Array): Float32Array {
  return unit(v.map((x, i) => x - mean[i]))
}

function dist(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < EMB; i++) s += a[i] * b[i]
  return 1 - s
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

let templates: Float32Array[][] = []
let threshold_ = DEFAULT_THRESHOLD

function loadStored() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Stored
      templates = s.templates.map((t) => t.map((f) => new Float32Array(f)))
      if (s.mean) mean = new Float32Array(s.mean)
    }
    const t = Number(localStorage.getItem(THRESHOLD_KEY))
    if (t > 0 && t < 1) threshold_ = t
  } catch {
    templates = []
  }
  wakeDiag.templates = templates.length
}
loadStored()

export const enrolled = () => templates.length > 0
export const threshold = () => threshold_
export function setThreshold(t: number) {
  threshold_ = t
  try {
    localStorage.setItem(THRESHOLD_KEY, String(t))
  } catch {
    /* private window */
  }
}

export function forget() {
  templates = []
  wakeDiag.templates = 0
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* private window */
  }
}

/** Where the phrase is in a recording, in samples, by loudness. */
function bounds(pcm: Float32Array): [number, number] | null {
  const F = 320 // 20ms
  const lv: number[] = []
  for (let i = 0; i + F <= pcm.length; i += F) {
    let s = 0
    for (let j = i; j < i + F; j++) s += pcm[j] * pcm[j]
    lv.push(Math.sqrt(s / F))
  }
  if (!lv.length) return null
  const sorted = [...lv].sort((a, b) => a - b)
  const loud = sorted[Math.floor(sorted.length * 0.95)]
  const floor = sorted[Math.floor(sorted.length * 0.1)]
  const gate = floor + (loud - floor) * 0.2
  let a = lv.findIndex((v) => v > gate)
  let b = lv.length - 1 - [...lv].reverse().findIndex((v) => v > gate)
  if (a < 0 || b <= a) return null
  return [a * F, (b + 1) * F]
}

/**
 * One recording → one template: the embeddings whose window ends inside the
 * phrase, from a quarter-second in to just after it finishes. Earlier windows
 * are mostly the silence before you spoke, and would match any silence.
 */
async function template(
  pcm: Float32Array,
): Promise<{ keep: Float32Array[]; all: Float32Array[] } | null> {
  const b = bounds(pcm)
  if (!b) return null
  const [s, e] = b
  if (e - s < 0.3 * RATE || e - s > 2.2 * RATE) return null
  // Enough audio before the phrase for the first window to reach back over it.
  const from = Math.max(0, s - Math.round(0.9 * RATE))
  const to = Math.min(pcm.length, e + Math.round(0.2 * RATE))
  const clip = pcm.subarray(from, to)
  const all = await embeddings(await melFrames(clip))
  // Window k ends at sample (8k + 76) × 160 + 480 of the clip.
  const endOf = (k: number) => from + (8 * k + WINDOW) * 160 + MEL_CONTEXT
  const keep = all.filter((_, k) => endOf(k) >= s + 0.25 * RATE && endOf(k) <= e + 0.2 * RATE)
  return keep.length >= 4 ? { keep, all } : null
}

/**
 * Score a whole sequence against one template — the best match ending
 * anywhere in it. Used to calibrate; the live detector does the same thing
 * one frame at a time.
 */
function bestMatch(seq: Float32Array[], t: Float32Array[]): number {
  const m = new Matcher(t)
  let best = 0
  for (const f of seq) best = Math.max(best, m.push(f))
  return best
}

export type Enrolment = { kept: number; self: number; other: number; threshold: number }

/**
 * Build templates from recordings of the wake phrase, and pick a threshold
 * between how well they match each other and how well other speech matches
 * them. `negatives` are recordings of you saying something else.
 */
export async function enrol(phrases: Float32Array[], negatives: Float32Array[]): Promise<Enrolment> {
  await loadModels()
  const raw: Float32Array[][] = []
  const pool: Float32Array[] = []
  for (const p of phrases) {
    const t = await template(p)
    if (!t) continue
    raw.push(t.keep)
    pool.push(...t.all)
  }
  const negs: Float32Array[][] = []
  for (const n of negatives) {
    const seq = await embeddings(await melFrames(n))
    negs.push(seq)
    pool.push(...seq)
  }
  const m = new Float32Array(EMB)
  for (const v of pool) for (let i = 0; i < EMB; i++) m[i] += v[i] / pool.length
  mean = m
  const ts = raw.map((t) => t.map(feat))
  if (ts.length < 3) throw new Error(`only ${ts.length} recordings had a clear phrase in them — record a few more`)

  // How alike your own recordings are: each one against all the others.
  const self: number[] = []
  for (let i = 0; i < ts.length; i++) {
    const others = ts.filter((_, j) => j !== i)
    self.push(combine(others.map((o) => bestMatch(ts[i], o))))
  }
  // How alike other speech looks.
  let other = 0
  for (const n of negs) {
    const seq = n.map(feat)
    other = Math.max(other, combine(ts.map((t) => bestMatch(seq, t))))
  }
  self.sort((a, b) => a - b)
  const low = self[Math.floor(self.length * 0.2)]
  // Well above other speech, and four-fifths of the way to your own recordings:
  // in testing, near-rhymes ("Hey Sanjay") sat at about 0.8 of a real match.
  const t = Math.round(Math.min(0.85, Math.max(0.4, other + 0.15, low * 0.8)) * 100) / 100

  templates = ts
  wakeDiag.templates = ts.length
  setThreshold(t)
  try {
    const s: Stored = {
      templates: ts.map((x) => x.map((f) => Array.from(f))),
      mean: Array.from(mean),
      at: Date.now(),
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(s))
  } catch {
    /* too big or private window: it still works until reload */
  }
  void start()
  return { kept: ts.length, self: low, other, threshold: t }
}

/** Several templates' scores → one: the mean of the best three, so one odd
 *  recording can neither carry a false match nor veto a real one. */
function combine(scores: number[]): number {
  const s = [...scores].sort((a, b) => b - a).slice(0, 3)
  return s.reduce((a, b) => a + b, 0) / (s.length || 1)
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Subsequence DTW, one live frame at a time. The template must be crossed
 * from start to end; where in the stream it starts is free. Steps: diagonal,
 * stay on a template frame (you said it slower), or skip one (faster). No
 * step crosses the template without consuming live audio, so the whole phrase
 * cannot be "matched" against one instant.
 */
class Matcher {
  private cost: Float64Array
  private len: Int32Array
  private t: Float32Array[]
  constructor(t: Float32Array[]) {
    this.t = t
    this.cost = new Float64Array(t.length).fill(Infinity)
    this.len = new Int32Array(t.length)
  }
  /** Feed one frame; returns the similarity of the best full match ending here. */
  push(f: Float32Array): number {
    const n = this.t.length
    const pc = this.cost
    const pl = this.len
    const cost = new Float64Array(n).fill(Infinity)
    const len = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const d = dist(this.t[i], f)
      if (i === 0) {
        cost[0] = d
        len[0] = 1
        continue
      }
      let best = Infinity
      let bl = 0
      const cand = (c: number, l: number) => {
        if (l + 1 > n * MAX_STRETCH) return
        if (best === Infinity || c / l < best / bl) {
          best = c
          bl = l
        }
      }
      if (pc[i - 1] < Infinity) cand(pc[i - 1], pl[i - 1])
      if (pc[i] < Infinity) cand(pc[i], pl[i])
      if (i >= 2 && pc[i - 2] < Infinity) cand(pc[i - 2], pl[i - 2])
      if (best < Infinity) {
        cost[i] = best + d
        len[i] = bl + 1
      }
    }
    this.cost = cost
    this.len = len
    const c = cost[n - 1]
    return c < Infinity ? 1 - c / len[n - 1] : 0
  }
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

let running = false
let pending = new Float32Array(0)
let context = new Float32Array(0)
let melBuf = new Float32Array(0)
let matchers: Matcher[] = []
let busy = false
let lastFireAt = -Infinity
const fires: number[] = []
const listeners = new Set<(at: number) => void>()

/** Called with the detection time (performance.now) each time it hears it. */
export function onWake(fn: (at: number) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Did it hear the phrase between these two performance.now times? */
export function firedBetween(from: number, to: number): number | null {
  for (let i = fires.length - 1; i >= 0; i--) if (fires[i] >= from && fires[i] <= to) return fires[i]
  return null
}

/** Start listening, if there is anything to listen for. Safe to call often. */
export async function start(): Promise<void> {
  if (running) return
  if (!enrolled()) {
    console.info('[jarvis] wake word detector: OFF — no "Hey Saji" recordings saved yet (L panel)')
    return
  }
  running = true
  try {
    await loadModels()
  } catch (err) {
    console.info(`[jarvis] wake word detector: FAILED to load — ${(err as Error)?.message ?? err}`)
    running = false
    return
  }
  console.info(`[jarvis] wake word detector: ON · ${templates.length} recordings · threshold ${threshold_.toFixed(2)}`)
  matchers = templates.map((t) => new Matcher(t))
  speaker.onAudio((chunk) => {
    if (!enrolled()) return
    const next = new Float32Array(pending.length + chunk.length)
    next.set(pending)
    next.set(chunk, pending.length)
    pending = next
    if (!busy) void drain()
  })
}

async function drain() {
  busy = true
  try {
    while (pending.length >= HOP) {
      const hop = pending.slice(0, HOP)
      pending = pending.slice(HOP)
      const input = new Float32Array(context.length + HOP)
      input.set(context)
      input.set(hop, context.length)
      context = input.slice(-MEL_CONTEXT)
      if (input.length < HOP + MEL_CONTEXT) continue
      const fr = await melFrames(input)
      const m = new Float32Array(Math.min(melBuf.length + fr.length, (WINDOW + 8) * MEL_BINS))
      const joined = new Float32Array(melBuf.length + fr.length)
      joined.set(melBuf)
      joined.set(fr, melBuf.length)
      m.set(joined.subarray(joined.length - m.length))
      melBuf = m
      if (melBuf.length < WINDOW * MEL_BINS) continue
      const [r] = await embeddings(melBuf.subarray(melBuf.length - WINDOW * MEL_BINS))
      const e = feat(r)
      if (matchers.length !== templates.length) matchers = templates.map((t) => new Matcher(t))
      const score = combine(matchers.map((mt) => mt.push(e)))
      const now = performance.now()
      wakeDiag.live = Math.max(score, wakeDiag.live * 0.92)
      wakeDiag.peak = Math.max(wakeDiag.peak, score)
      if (score >= threshold_ && now - lastFireAt > REFRACTORY_MS && !speaker.isEnrolling()) {
        lastFireAt = now
        fires.push(now)
        if (fires.length > 20) fires.shift()
        wakeDiag.fires++
        wakeDiag.lastFire = Date.now()
        wakeDiag.lastScore = score
        wakeDiag.history.push({ at: Date.now(), score })
        console.info(`[jarvis] wake word detector fired · score ${score.toFixed(2)}`)
        if (wakeDiag.history.length > 40) wakeDiag.history.shift()
        for (const fn of listeners) fn(now)
      }
    }
  } catch (err) {
    wakeDiag.error = String((err as Error)?.message ?? err)
  } finally {
    busy = false
  }
}

/** Load the models ahead of recording, so the first save is not a wait. */
export const prepare = () => loadModels()
