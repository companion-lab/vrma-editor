// Minimal GLB container handling: parse a GLB into its glTF JSON + BIN chunk,
// modify the JSON (and optionally append image bytes to the BIN), and repack.
// Used by exportModel.ts to patch edits into the original file without
// re-exporting the scene (which would drop all VRM extensions).

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

export interface GlbData {
  json: Record<string, any>;
  /** Reference into the original buffer (must be copied before replacing the BIN). */
  bin: Uint8Array | null;
}

export function parseGlb(buffer: ArrayBuffer): GlbData {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 20 || dv.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('Not a binary glTF (GLB) file');
  }
  if (dv.getUint32(4, true) !== 2) {
    throw new Error('Unsupported GLB version (expected 2)');
  }
  const jsonLen = dv.getUint32(12, true);
  const jsonBytes = new Uint8Array(buffer, 20, jsonLen);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));
  let bin: Uint8Array | null = null;
  let offset = 20 + jsonLen;
  while (offset + 8 <= buffer.byteLength) {
    const len = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    if (type === CHUNK_BIN) {
      bin = new Uint8Array(buffer, offset + 8, len);
    }
    offset += 8 + len;
  }
  return { json, bin };
}

export function writeGlb(json: Record<string, any>, bin: Uint8Array | null): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = bin ? (4 - (bin.length % 4)) % 4 : 0;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin ? 8 + bin.length + binPad : 0);

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.length + i] = 0x20; // spec: pad with spaces

  if (bin) {
    let off = 20 + jsonBytes.length + jsonPad;
    dv.setUint32(off, bin.length + binPad, true);
    dv.setUint32(off + 4, CHUNK_BIN, true);
    out.set(bin, off + 8);
    for (let i = 0; i < binPad; i++) out[off + 8 + bin.length + i] = 0;
  }
  return out.buffer;
}

/** Copy the BIN into an editable buffer (parseGlb's bin aliases the source ArrayBuffer). */
export function copyBin(bin: Uint8Array | null): Uint8Array {
  return bin ? bin.slice() : new Uint8Array(0);
}

/**
 * Append image bytes to the BIN chunk and register an image + bufferView.
 * Returns the new image index; `bin` is replaced with a grown copy.
 */
export function appendImage(
  json: Record<string, any>,
  bin: Uint8Array,
  bytes: Uint8Array,
  mimeType: string,
): { imageIndex: number; bin: Uint8Array } {
  const pad = (4 - (bin.length % 4)) % 4;
  const newBin = new Uint8Array(bin.length + pad + bytes.length);
  newBin.set(bin, 0);
  newBin.set(bytes, bin.length + pad);

  const bufferViewIndex = (json.bufferViews ??= []).length;
  json.bufferViews.push({ buffer: 0, byteOffset: bin.length + pad, byteLength: bytes.length });
  json.buffers[0].byteLength = newBin.length;

  const imageIndex = (json.images ??= []).length;
  json.images.push({ bufferView: bufferViewIndex, mimeType });
  return { imageIndex, bin: newBin };
}

export function mimeTypeFor(fileName: string): string {
  if (/\.jpe?g$/i.test(fileName)) return 'image/jpeg';
  if (/\.webp$/i.test(fileName)) return 'image/webp';
  return 'image/png';
}
