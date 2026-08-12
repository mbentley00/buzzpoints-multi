// A minimal ZIP reader/writer, so a backup is one file you can keep rather than
// three dozen downloads. Deflate comes from the platform's CompressionStream, so
// this stays dependency-free; if a browser lacks it the entries are stored
// uncompressed, which still produces a valid archive.

export interface ZipEntry { name: string; data: Uint8Array }

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, EOCD = 0x06054b50;

// CRC-32, table built once. Every entry carries one and unzippers check it, so a
// truncated or corrupted backup fails loudly instead of restoring garbage.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(data: Uint8Array): Promise<{ body: Uint8Array; method: number }> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return { body: data, method: 0 };
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CS("deflate-raw"));
    return { body: new Uint8Array(await new Response(stream).arrayBuffer()), method: 8 };
  } catch { return { body: data, method: 0 }; }
}
async function inflate(data: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return data;
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) throw new Error("This browser can't decompress the archive.");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// DOS date/time, which is what the format stores.
function dosStamp(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export async function zipFiles(entries: ZipEntry[], now = new Date()): Promise<Blob> {
  const { time, date } = dosStamp(now);
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const { body, method } = await deflate(e.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL, true);
    local.setUint16(4, 20, true);      // version needed
    local.setUint16(6, 0x800, true);   // flags: bit 11 = the name is UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);      // extra
    parts.push(local.buffer, name, body as BlobPart);

    const cd = new Uint8Array(46 + name.length);
    const v = new DataView(cd.buffer);
    v.setUint32(0, CENTRAL, true);
    v.setUint16(4, 20, true);          // version made by
    v.setUint16(6, 20, true);          // version needed
    v.setUint16(8, 0x800, true);       // same UTF-8 flag in the directory
    v.setUint16(10, method, true);
    v.setUint16(12, time, true);
    v.setUint16(14, date, true);
    v.setUint32(16, crc, true);
    v.setUint32(20, body.length, true);
    v.setUint32(24, e.data.length, true);
    v.setUint16(28, name.length, true);
    v.setUint32(42, offset, true);     // where the local header starts
    cd.set(name, 46);
    central.push(cd);

    offset += 30 + name.length + body.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, EOCD, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end.buffer], { type: "application/zip" });
}

export async function unzipFiles(buf: ArrayBuffer): Promise<ZipEntry[]> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  // The central directory is found from the end-of-archive record, which sits at
  // the very end (no trailing comment in anything we write).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i--)
    if (view.getUint32(i, true) === EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error("That file isn't a zip archive.");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== CENTRAL) throw new Error("This archive's directory is damaged.");
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // The local header repeats the name/extra lengths, and its extra field can
    // differ from the central one — always read them from the local header.
    const lNameLen = view.getUint16(local + 26, true);
    const lExtraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    out.push({ name, data: await inflate(bytes.subarray(start, start + compSize), method) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
