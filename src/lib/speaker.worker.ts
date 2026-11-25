/**
 * The voice lock's model, off the main thread. See speaker.ts for what it is
 * and workerRpc.ts for why it lives here.
 */
import { AutoProcessor, AutoModel, env } from '@huggingface/transformers'
import { emit, serve } from './workerRpc'

type Processor = Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>
type Model = Awaited<ReturnType<typeof AutoModel.from_pretrained>>

let loaded: Promise<{ processor: Processor; model: Model }> | null = null

function load(name: string) {
  if (loaded) return loaded
  // The runtime is served from our own origin (see ortRuntime in
  // vite.config.ts); the CDN it would otherwise fetch is refused by the CSP.
  const wasm = env.backends.onnx.wasm
  if (wasm) wasm.wasmPaths = '/ort/'
  const files = new Map<string, number>()
  const onProgress = (p: { status?: string; file?: string; progress?: number }) => {
    if (p.status !== 'progress' || !p.file) return
    files.set(p.file, (p.progress ?? 0) / 100)
    let sum = 0
    for (const v of files.values()) sum += v
    emit({ type: 'progress', value: sum / files.size })
  }
  loaded = (async () => {
    const processor = await AutoProcessor.from_pretrained(name, { progress_callback: onProgress })
    const model = await AutoModel.from_pretrained(name, { progress_callback: onProgress })
    return { processor, model }
  })()
  loaded.catch(() => {
    loaded = null
  })
  return loaded
}

serve({
  async load({ model }) {
    await load(String(model))
    return {}
  },
  async embed({ model: name, pcm }) {
    const { processor, model } = await load(String(name))
    const inputs = await processor(pcm as Float32Array)
    // This export names its one output generically; it is the embedding.
    const out = (await model(inputs)) as { last_hidden_state: { data: Float32Array } }
    const data = Float32Array.from(out.last_hidden_state.data)
    return { result: data, transfer: [data.buffer] }
  },
})
