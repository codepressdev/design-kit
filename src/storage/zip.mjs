/**
 * Zips a kit folder and unzips one, with Node's zlib and no other
 * dependency. The archive is deterministic: entries sorted by path, every
 * timestamp 1980-01-01, so the same kit always zips to the same bytes.
 * ZIP64 end records are written and read when a kit has 65,535 or more
 * files; a single file must stay under 4 GB.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 a zip entry records. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1)
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Every regular file under `dir`, as forward-slash paths relative to it. */
function filesUnder(dir) {
  const files = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        files.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walk(dir);
  return files.sort();
}

const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

/** The folder `dir`, zipped, as one Buffer. */
export function zipDirectory(dir) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const path of filesUnder(dir)) {
    const data = readFileSync(join(dir, path));
    const name = Buffer.from(path, "utf8");
    const deflated = deflateRawSync(data);
    // Stored when deflating does not help (fonts, images).
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    if (data.length >= MAX32 || body.length >= MAX32)
      throw new Error(`${path} is too large to zip (4 GB or more)`);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const zip64Offset = offset >= MAX32;
    const extra = zip64Offset ? Buffer.alloc(12) : Buffer.alloc(0);
    if (zip64Offset) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(offset), 4);
    }
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(zip64Offset ? 45 : 20, 4); // version made by
    header.writeUInt16LE(zip64Offset ? 45 : 20, 6); // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(zip64Offset ? MAX32 : offset, 42);
    central.push(header, name, extra);
    offset += local.length + name.length + body.length;
  }
  const count = central.length / 3;
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const centralOffset = offset;
  const tail = [];
  const zip64 =
    count >= MAX16 || centralOffset >= MAX32 || centralSize >= MAX32;
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(0, 20);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(centralSize), 40);
    record.writeBigUInt64LE(BigInt(centralOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? MAX16 : count, 8);
  end.writeUInt16LE(zip64 ? MAX16 : count, 10);
  end.writeUInt32LE(zip64 ? MAX32 : centralSize, 12);
  end.writeUInt32LE(zip64 ? MAX32 : centralOffset, 16);
  end.writeUInt16LE(0, 20);
  tail.push(end);
  return Buffer.concat([...parts, ...central, ...tail]);
}

/** Where the end-of-central-directory record starts, or -1. */
function findEnd(zip) {
  const last = Math.max(0, zip.length - 22 - MAX16);
  for (let i = zip.length - 22; i >= last; i -= 1)
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

/**
 * The entries of a zip: `[{path, data}]`. Throws on anything it cannot
 * read: a damaged archive, an encrypted entry, or an unknown method.
 */
export function readZip(zip) {
  const end = findEnd(zip);
  if (end < 0) throw new Error("not a zip archive (no end record)");
  let count = zip.readUInt16LE(end + 10);
  let centralOffset = zip.readUInt32LE(end + 16);
  if (
    (count === MAX16 || centralOffset === MAX32) &&
    end >= 20 &&
    zip.readUInt32LE(end - 20) === 0x07064b50
  ) {
    const record = Number(zip.readBigUInt64LE(end - 20 + 8));
    if (zip.readUInt32LE(record) !== 0x06064b50)
      throw new Error("not a zip archive (bad ZIP64 record)");
    count = Number(zip.readBigUInt64LE(record + 32));
    centralOffset = Number(zip.readBigUInt64LE(record + 48));
  }
  const entries = [];
  let at = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50)
      throw new Error("damaged zip archive (bad central directory)");
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    let compressed = zip.readUInt32LE(at + 20);
    let size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    let local = zip.readUInt32LE(at + 42);
    const path = zip.toString("utf8", at + 46, at + 46 + nameLength);
    // ZIP64 extra field: the 64-bit values, in order, for the 32-bit
    // fields that are 0xffffffff.
    let extraAt = at + 46 + nameLength;
    const extraEnd = extraAt + extraLength;
    while (extraAt + 4 <= extraEnd) {
      const id = zip.readUInt16LE(extraAt);
      const length = zip.readUInt16LE(extraAt + 2);
      if (id === 0x0001) {
        let field = extraAt + 4;
        if (size === MAX32) {
          size = Number(zip.readBigUInt64LE(field));
          field += 8;
        }
        if (compressed === MAX32) {
          compressed = Number(zip.readBigUInt64LE(field));
          field += 8;
        }
        if (local === MAX32) local = Number(zip.readBigUInt64LE(field));
      }
      extraAt += 4 + length;
    }
    at = extraEnd + commentLength;
    if (path.endsWith("/")) continue;
    if (flags & 1) throw new Error(`${path}: encrypted entries are not read`);
    if (zip.readUInt32LE(local) !== 0x04034b50)
      throw new Error(`damaged zip archive (${path} has no local header)`);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + compressed);
    let data;
    if (method === 0) data = body;
    else if (method === 8) data = inflateRawSync(body);
    else throw new Error(`${path}: compression method ${method} is not read`);
    if (data.length !== size || crc32(data) !== crc)
      throw new Error(`damaged zip archive (${path} fails its checksum)`);
    entries.push({ path, data });
  }
  return entries;
}

/**
 * Unzips `zip` into `dir`. An entry whose path is absolute or climbs out of
 * `dir` (`..`) is refused before anything is written.
 */
export function unzipTo(zip, dir) {
  const root = resolve(dir);
  const entries = readZip(zip);
  for (const { path } of entries) {
    const target = resolve(root, path);
    if (
      /^[\\/]/.test(path) ||
      /^[A-Za-z]:/.test(path) ||
      !`${target}`.startsWith(`${root}${sep}`)
    )
      throw new Error(`refusing the zip entry ${path}: it is outside the kit`);
  }
  mkdirSync(root, { recursive: true });
  for (const { path, data } of entries) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return entries.length;
}
