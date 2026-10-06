import { deflateSync } from "node:zlib";

export type RgbaFrame = {
  readonly width: number;
  readonly height: number;
  readonly rgba: Buffer;
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 8 * 1024 * 1024;

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.allocUnsafe(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

export function encodePng(frame: RgbaFrame): Buffer {
  const expected = frame.width * frame.height * 4;
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width <= 0 || frame.height <= 0) {
    throw new Error("PNG dimensions are invalid");
  }
  if (frame.rgba.length !== expected) throw new Error("PNG framebuffer size does not match its dimensions");

  const stride = frame.width * 4;
  const scanlines = Buffer.allocUnsafe((stride + 1) * frame.height);
  for (let row = 0; row < frame.height; row += 1) {
    const outputOffset = row * (stride + 1);
    scanlines[outputOffset] = 0;
    frame.rgba.copy(scanlines, outputOffset + 1, row * stride, (row + 1) * stride);
  }

  const header = Buffer.allocUnsafe(13);
  header.writeUInt32BE(frame.width, 0);
  header.writeUInt32BE(frame.height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const png = Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  if (png.length > MAX_PNG_BYTES) throw new Error("PNG screenshot exceeds the 8 MiB limit");
  return png;
}
