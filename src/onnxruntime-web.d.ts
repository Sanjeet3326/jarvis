// onnxruntime-web ships types, but its package.json "exports" hides them from
// bundler resolution. They are onnxruntime-common's, re-exported.
declare module 'onnxruntime-web' {
  export * from 'onnxruntime-common'
}
