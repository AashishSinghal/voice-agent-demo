/**
 * A minimal ZIP writer.
 *
 * Store-only, no compression. The bulk of a debug bundle is Opus audio, which
 * is already compressed and gains nothing from deflate, so the only thing a
 * zip library would add here is a dependency. The format's stored variant is
 * small and fully specified.
 *
 * Writes the classic 32-bit structures, which every unzip understands. That
 * caps an entry at 4 GB — a call recording is measured in megabytes.
 */

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP stores timestamps in the DOS format: two-second resolution, from 1980. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date:
      ((Math.max(date.getFullYear(), 1980) - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_OF_CENTRAL_DIRECTORY = 22;

export function createZip(entries: ZipEntry[], modified = new Date()): Blob {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(modified);

  const prepared = entries.map((entry) => ({
    nameBytes: encoder.encode(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
  }));

  const localSize = prepared.reduce(
    (total, entry) => total + LOCAL_HEADER + entry.nameBytes.length + entry.data.length,
    0
  );
  const centralSize = prepared.reduce(
    (total, entry) => total + CENTRAL_HEADER + entry.nameBytes.length,
    0
  );

  const buffer = new ArrayBuffer(localSize + centralSize + END_OF_CENTRAL_DIRECTORY);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let offset = 0;
  const localOffsets: number[] = [];

  for (const entry of prepared) {
    localOffsets.push(offset);

    view.setUint32(offset, 0x04034b50, true); // local file header
    view.setUint16(offset + 4, 20, true); // version needed
    view.setUint16(offset + 6, 0, true); // flags
    view.setUint16(offset + 8, 0, true); // method: stored
    view.setUint16(offset + 10, stamp.time, true);
    view.setUint16(offset + 12, stamp.date, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true); // compressed
    view.setUint32(offset + 22, entry.data.length, true); // uncompressed
    view.setUint16(offset + 26, entry.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // extra length
    offset += LOCAL_HEADER;

    bytes.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;

    bytes.set(entry.data, offset);
    offset += entry.data.length;
  }

  const centralStart = offset;

  prepared.forEach((entry, index) => {
    view.setUint32(offset, 0x02014b50, true); // central directory header
    view.setUint16(offset + 4, 20, true); // version made by
    view.setUint16(offset + 6, 20, true); // version needed
    view.setUint16(offset + 8, 0, true); // flags
    view.setUint16(offset + 10, 0, true); // method: stored
    view.setUint16(offset + 12, stamp.time, true);
    view.setUint16(offset + 14, stamp.date, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true); // extra
    view.setUint16(offset + 32, 0, true); // comment
    view.setUint16(offset + 34, 0, true); // disk number
    view.setUint16(offset + 36, 0, true); // internal attributes
    view.setUint32(offset + 38, 0, true); // external attributes
    view.setUint32(offset + 42, localOffsets[index], true);
    offset += CENTRAL_HEADER;

    bytes.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
  });

  view.setUint32(offset, 0x06054b50, true); // end of central directory
  view.setUint16(offset + 4, 0, true); // this disk
  view.setUint16(offset + 6, 0, true); // disk with central directory
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true); // comment length

  return new Blob([buffer], { type: 'application/zip' });
}
