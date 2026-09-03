// GLB container (binary glTF 2.0). Splits a blob into the JSON chunk (parsed)
// and the optional BIN chunk (a view — no copy). Also handles a plain .gltf
// (JSON only) with an external or data-URI buffer.
//
// Format: 12-byte header (magic "glTF", u32 version=2, u32 length) then
// chunks: [u32 chunkLength][u32 chunkType][chunkData]. JSON chunk = 0x4E4F534A,
// BIN chunk = 0x004E4942.

const MAGIC = 0x46546c67;       // "glTF" little-endian
const CHUNK_JSON = 0x4e4f534a;  // "JSON"
const CHUNK_BIN = 0x004e4942;   // "BIN\0"

export interface GltfContainer {
  /** the parsed glTF 2.0 JSON */
  json: any;
  /** the GLB BIN chunk, or the resolved data-URI buffer, or null */
  bin: Uint8Array | null;
}

export function isGLB(bytes: Uint8Array): boolean {
  return bytes.length >= 12 &&
    new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === MAGIC;
}

export function parseContainer(bytes: Uint8Array): GltfContainer {
  if (isGLB(bytes)) return parseGLB(bytes);
  // plain .gltf — JSON text; buffers resolved separately by the caller/decoder
  const json = JSON.parse(new TextDecoder().decode(bytes));
  const bin = resolveEmbeddedBuffer(json);
  return { json, bin };
}

function parseGLB(bytes: Uint8Array): GltfContainer {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new GlbError("not a GLB (bad magic)");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new GlbError(`unsupported GLB version ${version} (need 2)`);
  const declaredLength = dv.getUint32(8, true);
  if (declaredLength > bytes.byteLength) throw new GlbError("GLB truncated (length > blob)");

  let offset = 12;
  let json: any = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= declaredLength) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (dataStart + chunkLength > bytes.byteLength) throw new GlbError("GLB chunk overruns blob");
    const data = bytes.subarray(dataStart, dataStart + chunkLength);
    if (chunkType === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(data));
    } else if (chunkType === CHUNK_BIN) {
      bin = data; // view, not a copy
    }
    // unknown chunk types are skipped per spec
    offset = dataStart + chunkLength;
  }
  if (!json) throw new GlbError("GLB has no JSON chunk");
  if (json.asset?.version && !String(json.asset.version).startsWith("2")) {
    throw new GlbError(`glTF asset version ${json.asset.version} (need 2.x)`);
  }
  // if the single buffer has no uri, it is the BIN chunk
  if (!bin && json.buffers?.[0] && json.buffers[0].uri == null) {
    throw new GlbError("glTF buffer 0 has no uri but there is no BIN chunk");
  }
  return { json, bin: bin ?? resolveEmbeddedBuffer(json) };
}

/** resolve `buffers[0].uri` when it is a base64 data URI (external files are the
 *  caller's job) */
function resolveEmbeddedBuffer(json: any): Uint8Array | null {
  const uri: string | undefined = json.buffers?.[0]?.uri;
  if (!uri) return null;
  const m = /^data:.*?;base64,(.*)$/.exec(uri);
  if (!m) return null; // external file — decoder will report it as ignored
  return base64ToBytes(m[1]);
}

/** portable base64 → bytes. `atob` is global in browsers and Node ≥ 16. */
export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class GlbError extends Error {
  constructor(msg: string) { super(`GLB: ${msg}`); this.name = "GlbError"; }
}
