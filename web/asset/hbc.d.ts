// Ambient type for the lazily-loaded ./hbc.js sibling chunk (built by
// web/build-api.mjs from web/asset/hbc/hbc-decoder.js).
export {};
declare module "./hbc.js" {
  export function isHbc(bytes: Uint8Array): boolean;
  export function decodeHbc(
    input: ArrayBuffer | Uint8Array,
    opts?: { verify?: boolean; verifyCrc?: boolean },
  ): Promise<{ data: Uint8Array; header: unknown }>;
}
