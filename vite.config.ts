import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Serve the ONNX runtime the voice lock runs its model on, from our own origin.
 *
 * transformers.js imports it from jsDelivr by default, which the CSP in
 * index.html refuses (no CDN in script-src, for the reasons scripts/start.mjs
 * gives for MediaPipe) — so the lock would never get a model and, being
 * fail-closed, would ignore everyone. Copying it into public/ does not work
 * either: Vite will not let code import a file from public/. So it is served
 * straight out of node_modules, ahead of Vite's own handling, at the path
 * src/lib/speaker.ts points the runtime at. Exactly the lockfile's bytes.
 */
function ortRuntime(): Plugin {
  const dir = 'node_modules/@huggingface/transformers/dist'
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const name = basename((req.url ?? '').split('?')[0])
    const file = join(dir, name)
    if (!/^ort-wasm[\w.-]*\.(mjs|wasm)$/.test(name) || !existsSync(file)) return next()
    res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
    createReadStream(file).pipe(res)
  }
  return {
    name: 'jarvis-ort-runtime',
    configureServer: (server) => void server.middlewares.use('/ort', serve),
    configurePreviewServer: (server) => void server.middlewares.use('/ort', serve),
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ortRuntime()],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
    // The desktop app's own files and its log are not part of the page.
    // Watching them crashes Vite on Windows when a file is held open (EBUSY),
    // and the log changes many times a second.
    watch: { ignored: ['**/electron/**', '**/logs/**'] },
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers', 'onnxruntime-web'],
  },
})
