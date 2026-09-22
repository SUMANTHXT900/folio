/// <reference types="vite/client" />

declare const __FOLIO_VERSION__: string

declare module 'mammoth' {
  interface MammothResult {
    value: string
    messages: unknown[]
  }
  interface MammothOptions {
    arrayBuffer?: ArrayBuffer
    path?: string
  }
  export function convertToHtml(options: MammothOptions): Promise<MammothResult>
  const mammoth: { convertToHtml: typeof convertToHtml }
  export default mammoth
}

declare module '*.mjs?url' {
  const src: string
  export default src
}
