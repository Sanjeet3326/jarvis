/**
 * The wake word's two openWakeWord models, off the main thread. See
 * wakeword.ts for what they do and workerRpc.ts for why they live here.
 */
import * as ort from 'onnxruntime-web'
import { serve } from './workerRpc'

const WINDOW = 76
const MEL_BINS = 32
const EMB = 96

let sessions: Promise<[ort.InferenceSession, ort.InferenceSession]> | null = null

function load() {
  if (sessions) return sessions
  // The same runtime files the voice lock uses, served locally: the CSP
  // refuses the CDN this would otherwise fetch them from.
  ort.env.wasm.wasmPaths = '/ort/'
  ort.env.wasm.numThreads = 1
  const opts = { executionProviders: ['wasm'] }
  sessions = Promise.all([
    ort.InferenceSession.create('/models/oww/melspectrogram.onnx', opts),
    ort.InferenceSession.create('/models/oww/embedding_model.onnx', opts),
  ])
  sessions.catch(() => {
    sessions = null
  })
  return sessions
}

serve({
  async load() {
    await load()
    return {}
  },
  /** Audio in [-1, 1] → mel frames, flat [frames × 32], openWakeWord's scaling. */
  async mel({ pcm }) {
    const [mel] = await load()
    const a = pcm as Float32Array
    const x = new Float32Array(a.length)
    for (let i = 0; i < a.length; i++) x[i] = a[i] * 32767
    const out = await mel.run({ input: new ort.Tensor('float32', x, [1, x.length]) })
    const d = out.output.data as Float32Array
    const y = new Float32Array(d.length)
    for (let i = 0; i < d.length; i++) y[i] = d[i] / 10 + 2
    return { result: y, transfer: [y.buffer] }
  },
  /** Embeddings for every 76-frame window starting at 0, 8, 16 … flat [n × 96]. */
  async embed({ frames }) {
    const [, emb] = await load()
    const f = frames as Float32Array
    const n = f.length / MEL_BINS
    const starts: number[] = []
    for (let s = 0; s + WINDOW <= n; s += 8) starts.push(s)
    if (!starts.length) return { result: new Float32Array(0) }
    const batch = new Float32Array(starts.length * WINDOW * MEL_BINS)
    starts.forEach((s, b) =>
      batch.set(f.subarray(s * MEL_BINS, (s + WINDOW) * MEL_BINS), b * WINDOW * MEL_BINS),
    )
    const out = await emb.run({
      input_1: new ort.Tensor('float32', batch, [starts.length, WINDOW, MEL_BINS, 1]),
    })
    const d = Float32Array.from((out.conv2d_19.data as Float32Array).subarray(0, starts.length * EMB))
    return { result: d, transfer: [d.buffer] }
  },
})
