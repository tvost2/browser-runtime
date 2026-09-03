'use strict';

// Decodificador .hbc PRA NAVEGADOR — porta fiel (só o caminho de DECODE) do
// pipeline de reconstrução que roda em Node em compression-engine/{formats,
// motor,metabolic,cognition-3d}. Sem Buffer, sem require — só Web APIs
// (DecompressionStream, crypto.subtle, TypedArray) pra rodar direto no
// browser via <script type="module">.
//
// Verificado na prática (não assumido): NENHUM navegador atual (testado
// Chromium 151, ago/2026) suporta brotli em DecompressionStream — só
// deflate/gzip. Como o motor de compressão escolhe brotli pra praticamente
// todo bloco de GLB real, isso tornaria a extensão inútil sem um decoder
// próprio. Em vez de reimplementar Brotli do zero (Huffman + dicionário
// estático de ~120KB — grande demais pra valer a pena reinventar), vendorizamos
// o decoder de referência oficial do Google (MIT, js/decode.js do repo
// google/brotli) em vendor-brotli-decode.js — usado como fallback SEMPRE que
// o navegador não suportar 'br' nativo (o que hoje é sempre; o caminho nativo
// fica pronto pra quando/se algum navegador vier a suportar, sem custo
// extra). deflate/gzip/packbits/raw seguem via API nativa / código próprio.

// ?cb= força busca fresca caso um CDN/proxy na frente (ex: Cloudflare)
// tenha cacheado uma resposta antiga de erro pra esse arquivo — sem isso,
// uma falha transitória de deploy vira um 404 "permanente" até o cache
// expirar sozinho.
import { BrotliDecode } from './vendor-brotli-decode.js';

const MAGIC = 0x31434248; // 'HBC1' little-endian
const HEADER_OFFSET = 10; // 4 (magic) + 1 (version) + 1 (flags) + 4 (headerLen)
const FORMAT_VERSION = 1;
const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian

const CODEC = { RAW: 0, DEFLATE: 1, GZIP: 2, BROTLI: 3, PACKBITS: 4 };
const TRANSFORM = { NONE: 0, WORD_RLE: 1, LINE_DEDUP: 2, GLB_SPLIT: 3 };

// ---------------------------------------------------------------------
// utilidades de bytes
// ---------------------------------------------------------------------

function readUVarint(buf, pos) {
  let result = 0, shift = 1, byte;
  do {
    byte = buf[pos++];
    result += (byte & 0x7f) * shift;
    shift *= 128;
  } while (byte & 0x80);
  return [result, pos];
}

function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function bytesToLatin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
function latin1ToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// ---------------------------------------------------------------------
// CRC-32 — mesma tabela/algoritmo do fallback puro-JS de core/checksum.js
// ---------------------------------------------------------------------

let CRC_TABLE = null;
function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
function crc32(bytes) {
  if (!CRC_TABLE) CRC_TABLE = buildCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------
// codecs (formats/codecs.js) — deflate/gzip/brotli via Compression Streams,
// packbits portado à mão (é só RLE, não precisa de API nenhuma)
// ---------------------------------------------------------------------

async function decompressStream(bytes, format) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(`este navegador não suporta DecompressionStream (precisa pra decodificar "${format}")`);
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// brotli: tenta a API nativa primeiro (nenhum navegador suporta hoje, mas
// não custa nada deixar pronto), cai pro decoder vendorizado sempre que
// não suportar — que é o caminho real em todo navegador atual.
async function brotliDecode(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      return await decompressStream(bytes, 'br');
    } catch {
      // segue pro fallback
    }
  }
  const int8 = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  const decoded = BrotliDecode(int8);
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.length);
}

// rlen: tamanho esperado da saída (já sabido pelo índice do container) —
// evita crescer um array dinamicamente, escreve direto no tamanho final.
function packbitsDecode(buf, rlen) {
  const out = new Uint8Array(rlen);
  let i = 0, o = 0;
  const n = buf.length;
  while (i < n) {
    const header = buf[i++];
    if (header === 128) continue;
    if (header < 128) {
      const count = header + 1;
      out.set(buf.subarray(i, i + count), o);
      i += count; o += count;
    } else {
      const count = 257 - header;
      const val = buf[i++];
      out.fill(val, o, o + count);
      o += count;
    }
  }
  return out;
}

async function decodeCodec(codecId, bytes, rlen) {
  switch (codecId) {
    case CODEC.RAW: return bytes;
    case CODEC.DEFLATE: return decompressStream(bytes, 'deflate-raw');
    case CODEC.GZIP: return decompressStream(bytes, 'gzip');
    case CODEC.BROTLI: return brotliDecode(bytes);
    case CODEC.PACKBITS: return packbitsDecode(bytes, rlen);
    default: throw new Error(`codec .hbc desconhecido: ${codecId}`);
  }
}

// ---------------------------------------------------------------------
// transform-engine (cognition-3d) — split (de-interleave de plano de byte)
// e delta (soma-prefixo), ambos bijetivos e portados byte-a-byte do original
// ---------------------------------------------------------------------

function splitReverse(buf, E) {
  const n = buf.length;
  const count = Math.floor(n / E);
  const out = new Uint8Array(n);
  for (let plane = 0; plane < E; plane++) {
    const base = plane * count;
    let dst = plane;
    for (let i = 0; i < count; i++) { out[dst] = buf[base + i]; dst += E; }
  }
  for (let r = count * E; r < n; r++) out[r] = buf[r];
  return out;
}

const DELTA_MOD = { 1: 0x100, 2: 0x10000, 4: 0x100000000 };
function readLE(buf, off, W) {
  if (W === 1) return buf[off];
  if (W === 2) return buf[off] | (buf[off + 1] << 8);
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
function writeLE(buf, val, off, W) {
  buf[off] = val & 0xff;
  if (W >= 2) buf[off + 1] = (val >>> 8) & 0xff;
  if (W >= 4) { buf[off + 2] = (val >>> 16) & 0xff; buf[off + 3] = (val >>> 24) & 0xff; }
}
function deltaReverse(buf, W) {
  const m = DELTA_MOD[W];
  const count = Math.floor(buf.length / W);
  const out = Uint8Array.from(buf);
  let prev = 0;
  for (let i = 0; i < count; i++) {
    const off = i * W;
    const d = readLE(buf, off, W);
    let cur = prev + d;
    if (cur >= m) cur -= m;
    writeLE(out, cur, off, W);
    prev = cur;
  }
  return out;
}
function reverseOps(buf, ops) {
  let cur = buf;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    cur = op.t === 'split' ? splitReverse(cur, op.e) : deltaReverse(cur, op.w);
  }
  return cur;
}
function reverseCognition(descriptor, data) {
  if (!descriptor || !descriptor.ranges || !descriptor.ranges.length) return data;
  const out = Uint8Array.from(data);
  for (const r of descriptor.ranges) {
    const slice = out.subarray(r.off, r.off + r.len);
    out.set(reverseOps(slice, r.ops), r.off);
  }
  return out;
}

// ---------------------------------------------------------------------
// semantic-compressor.js — WORD_RLE / LINE_DEDUP (texto/código; GLB real
// quase sempre usa TRANSFORM.NONE aqui, mas portamos os dois por completude)
// ---------------------------------------------------------------------

function wordRleDecode(buf) {
  let pos = 0, numGroups;
  [numGroups, pos] = readUVarint(buf, pos);
  const tokens = [];
  for (let g = 0; g < numGroups; g++) {
    let count, len;
    [count, pos] = readUVarint(buf, pos);
    [len, pos] = readUVarint(buf, pos);
    const tok = bytesToLatin1(buf.subarray(pos, pos + len));
    pos += len;
    for (let k = 0; k < count; k++) tokens.push(tok);
  }
  return latin1ToBytes(tokens.join(' '));
}
function lineDedupDecode(buf) {
  let pos = 0, dictLen;
  [dictLen, pos] = readUVarint(buf, pos);
  const dict = [];
  for (let i = 0; i < dictLen; i++) {
    let len;
    [len, pos] = readUVarint(buf, pos);
    dict.push(bytesToLatin1(buf.subarray(pos, pos + len)));
    pos += len;
  }
  let refLen;
  [refLen, pos] = readUVarint(buf, pos);
  const lines = new Array(refLen);
  for (let i = 0; i < refLen; i++) {
    let id;
    [id, pos] = readUVarint(buf, pos);
    lines[i] = dict[id];
  }
  return latin1ToBytes(lines.join('\n'));
}
function semanticDecode(transformId, buf) {
  if (transformId === TRANSFORM.NONE) return buf;
  if (transformId === TRANSFORM.WORD_RLE) return wordRleDecode(buf);
  if (transformId === TRANSFORM.LINE_DEDUP) return lineDedupDecode(buf);
  throw new Error(`transformação semântica .hbc desconhecida: ${transformId}`);
}

// ---------------------------------------------------------------------
// motor/indexer.js — localizar blocos + reexpandir refs de dedup
// ---------------------------------------------------------------------

function expandRefs(seg) {
  if (seg.identityRefs) return Array.from({ length: seg.blockCount }, (_, i) => i);
  return seg.refs;
}

async function rebuildSegment(payload, seg, { verifyCrc = true } = {}) {
  const uniqueBlocks = [];
  for (const b of seg.uniqueBlocks) {
    const start = b.off, end = b.off + b.clen;
    if (end > payload.length) throw new Error(`índice .hbc aponta além do payload (bloco em ${start}).`);
    const compData = payload.subarray(start, end);

    if (verifyCrc) {
      const actual = crc32(compData);
      if (actual !== (b.crc >>> 0)) {
        throw new Error(`corrupção detectada: CRC de bloco não confere (esperado ${b.crc}, obtido ${actual}).`);
      }
    }

    const raw = await decodeCodec(b.codec, compData, b.rlen);
    if (raw.length !== b.rlen) {
      throw new Error(`tamanho de bloco inconsistente após decodificar (esperado ${b.rlen}, obtido ${raw.length}).`);
    }
    uniqueBlocks.push(raw);
  }

  const refs = expandRefs(seg);
  const blocks = refs.map((i) => uniqueBlocks[i]);
  const transformed = concatBytes(blocks);

  let data = semanticDecode(seg.transform, transformed);
  data = reverseCognition(seg.cog, data);
  return data;
}

// ---------------------------------------------------------------------
// integrations/glb-adapter.js — remonta o GLB a partir dos segmentos JSON/BIN
// ---------------------------------------------------------------------

function reassembleGlb(container, segmentMap) {
  const chunkBuffers = container.chunks.map((c) => {
    const data = segmentMap[c.seg];
    if (!data) throw new Error(`segmento GLB ausente no .hbc: ${c.seg}`);
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, c.length, true);
    head.set(latin1ToBytes(c.type).subarray(0, 4), 4);
    return concatBytes([head, data]);
  });
  const trailing = container.trailing ? segmentMap[container.trailing] : new Uint8Array(0);
  const body = concatBytes([...chunkBuffers, trailing]);

  const header = new Uint8Array(12);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, GLB_MAGIC, true);
  hv.setUint32(4, container.version, true);
  hv.setUint32(8, 12 + body.length, true);
  return concatBytes([header, body]);
}

// ---------------------------------------------------------------------
// formats/container.js — unpack (o header em si é sempre brotli, fixo)
// ---------------------------------------------------------------------

function isHbc(bytes) {
  return bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === MAGIC;
}

async function unpackContainer(bytes) {
  if (bytes.length < HEADER_OFFSET) throw new Error('arquivo .hbc corrompido: menor que o cabeçalho.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('assinatura inválida: isso não é um arquivo .hbc.');
  const version = view.getUint8(4);
  if (version !== FORMAT_VERSION) throw new Error(`versão de formato .hbc não suportada: ${version}.`);
  const headerLen = view.getUint32(6, true);
  const headerEnd = HEADER_OFFSET + headerLen;
  if (headerEnd > bytes.length) throw new Error('arquivo .hbc corrompido: cabeçalho truncado.');

  const headerComp = bytes.subarray(HEADER_OFFSET, headerEnd);
  const headerJsonBytes = await brotliDecode(headerComp);
  const header = JSON.parse(new TextDecoder('utf-8').decode(headerJsonBytes));
  const payload = bytes.subarray(headerEnd);
  return { header, payload };
}

// ---------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------

/**
 * Decodifica um .hbc (ArrayBuffer/Uint8Array) de volta pro dado original.
 * Pra .glb.hbc, `data` sai como um GLB binário válido, pronto pra qualquer
 * parser glTF (Babylon, three.js, model-viewer).
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{verify?: boolean, verifyCrc?: boolean}} [opts] verify: confere
 *   SHA-256 final contra o header (default true — mais seguro, custa um
 *   hash do tamanho do arquivo). verifyCrc: confere CRC-32 por bloco.
 * @returns {Promise<{data: Uint8Array, header: Object}>}
 */
async function decodeHbc(input, opts = {}) {
  const { verify = true, verifyCrc = true } = opts;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  const { header, payload } = await unpackContainer(bytes);

  const segmentMap = {};
  for (const seg of header.segments) {
    segmentMap[seg.name] = await rebuildSegment(payload, seg, { verifyCrc });
  }

  let data;
  const strategy = header.container && header.container.strategy;
  if (strategy === 'glb-split') {
    data = reassembleGlb(header.container, segmentMap);
  } else {
    data = segmentMap.main;
  }

  if (verify && header.original && header.original.sha256) {
    const actual = await sha256Hex(data);
    if (actual !== header.original.sha256) {
      throw new Error('falha de verificação: o dado reconstruído .hbc não confere com o original (SHA-256).');
    }
  }

  return { data, header };
}

const Cube3VaultHbcDecoder = { decodeHbc, isHbc };

// também pendura em window pra uso direto via <script type="module"> sem
// bundler (import/export continuam disponíveis normalmente pra quem usa).
if (typeof window !== 'undefined') window.Cube3VaultHbcDecoder = Cube3VaultHbcDecoder;

export { decodeHbc, isHbc };
export default Cube3VaultHbcDecoder;
