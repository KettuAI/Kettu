// The script engine: QuickJS compiled to WebAssembly. The module is compiled once per process and
// instantiated once per plugin, so each plugin has a linear memory of its own.

import variant from '@jitl/quickjs-wasmfile-release-sync'
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core'

// Node's types name no WebAssembly global.
declare const WebAssembly: { compile(bytes: Uint8Array<ArrayBuffer>): Promise<object> }

export interface Engine {
  /** A fresh instance of the engine, sharing nothing with any other. */
  instantiate(): Promise<QuickJSWASMModule>
}

/** Compiles the engine from the bytes of its WebAssembly file. */
export async function loadEngine(wasm: Uint8Array<ArrayBuffer>): Promise<Engine> {
  const wasmModule = await WebAssembly.compile(wasm)
  const compiled = newVariant(variant, { wasmModule })
  return { instantiate: () => newQuickJSWASMModuleFromVariant(compiled) }
}
