import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { vncChallengeResponse } from "./auth.ts";
import { keysymsForText, keysymForModifier, keysymForNamedKey, normalizeModifiers } from "./keys.ts";
import type { RgbaFrame } from "./png.ts";

const CLIENT_RFB_VERSION = "RFB 003.008\n";
const ACCEPTED_RFB_VERSIONS = new Set([CLIENT_RFB_VERSION, "RFB 003.889\n"]);
const MAX_WIDTH = 4096;
const MAX_HEIGHT = 2560;
const MAX_FRAME_BYTES = MAX_WIDTH * MAX_HEIGHT * 4;
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES + 64 * 1024;
const DESKTOP_SIZE_ENCODING = -223;

type PendingRead = {
  readonly bytes: number;
  readonly resolve: (value: Buffer) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
};

class DuplexBytes {
  private buffer = Buffer.alloc(0);
  private pending: PendingRead | undefined;
  private failure: Error | undefined;

  constructor(private readonly stream: Duplex) {
    stream.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      if (this.buffer.length + chunk.length > MAX_BUFFER_BYTES) {
        this.fail(new Error("RFB receive buffer exceeded its limit"));
        stream.destroy();
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    stream.on("error", (error) => this.fail(error));
    stream.on("close", () => this.fail(new Error("RFB connection closed")));
  }

  async read(bytes: number, timeoutMs = 5000, signal?: AbortSignal): Promise<Buffer> {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_BUFFER_BYTES) throw new Error("RFB read size is invalid");
    if (this.failure) throw this.failure;
    if (signal?.aborted) throw new Error("RFB operation cancelled");
    if (this.pending) throw new Error("Concurrent RFB reads are not allowed");
    if (this.buffer.length >= bytes) return this.take(bytes);

    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error("RFB read timed out"));
        this.stream.destroy();
      }, timeoutMs);
      const onAbort = signal === undefined ? undefined : () => {
        if (this.pending?.resolve !== resolve) return;
        this.fail(new Error("RFB operation cancelled"));
        this.stream.destroy();
      };
      if (onAbort) signal!.addEventListener("abort", onAbort, { once: true });
      this.pending = { bytes, resolve, reject, timer, ...(signal ? { signal, onAbort } : {}) };
    });
  }

  private take(bytes: number): Buffer {
    const output = this.buffer.subarray(0, bytes);
    this.buffer = this.buffer.subarray(bytes);
    return output;
  }

  private pump(): void {
    const pending = this.pending;
    if (!pending || this.buffer.length < pending.bytes) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve(this.take(pending.bytes));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    pending.reject(error);
  }
}

export type RfbConnectionOptions = {
  readonly host: string;
  readonly port: number;
  readonly password: string | Buffer;
  readonly signal?: AbortSignal;
};

export class RfbClient {
  private readonly bytes: DuplexBytes;
  private width = 0;
  private height = 0;
  private rgba = Buffer.alloc(0);
  private pointerX = 0;
  private pointerY = 0;
  private pointerMask = 0;
  private readonly heldKeys = new Set<number>();

  private constructor(private readonly stream: Duplex) {
    this.bytes = new DuplexBytes(stream);
  }

  static async connect(options: RfbConnectionOptions): Promise<RfbClient> {
    if (options.host !== "127.0.0.1") throw new Error("RFB host must be 127.0.0.1");
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("RFB port is invalid");
    RfbClient.validatePassword(options.password);
    if (options.signal?.aborted) throw new Error("RFB operation cancelled");

    const socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error("RFB connect timed out"));
      }, 5000);
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        socket.destroy();
        reject(new Error("RFB operation cancelled"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        options.signal?.removeEventListener("abort", onAbort);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      socket.connect(options.port, options.host);
    });
    return await RfbClient.connectStream(socket, options.password, options.signal);
  }

  static async connectStream(stream: Duplex, password: string | Buffer, signal?: AbortSignal): Promise<RfbClient> {
    RfbClient.validatePassword(password);
    if (stream.destroyed) throw new Error("RFB stream is closed");
    if (signal?.aborted) throw new Error("RFB operation cancelled");
    const client = new RfbClient(stream);
    try {
      await client.handshake(password, signal);
      return client;
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  dimensions(): { readonly width: number; readonly height: number } {
    return { width: this.width, height: this.height };
  }

  async screenshot(signal?: AbortSignal): Promise<RgbaFrame> {
    this.ensureOpen();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.write(this.framebufferRequest(), signal);
      for (let message = 0; message < 16; message += 1) {
        const type = (await this.bytes.read(1, 5000, signal))[0]!;
        if (type === 0) {
          const updated = await this.readFramebufferUpdate(signal);
          if (updated) return { width: this.width, height: this.height, rgba: Buffer.from(this.rgba) };
          break;
        }
        if (type === 2) continue;
        if (type === 3) {
          await this.readServerClipboard(signal);
          continue;
        }
        throw new Error(`Unsupported RFB server message type: ${type}`);
      }
    }
    throw new Error("RFB server did not provide framebuffer pixels");
  }

  async click(x: number, y: number, button: "left" | "right" | "middle" = "left", clickCount: 1 | 2 = 1, signal?: AbortSignal): Promise<void> {
    this.validatePoint(x, y);
    const mask = button === "left" ? 1 : button === "middle" ? 2 : 4;
    for (let count = 0; count < clickCount; count += 1) {
      await this.pointer(x, y, mask, signal);
      await delay(50, signal);
      await this.pointer(x, y, 0, signal);
      if (clickCount === 2 && count === 0) await delay(100, signal);
    }
  }

  async typeText(text: string, signal?: AbortSignal): Promise<void> {
    for (const keysym of keysymsForText(text)) {
      await this.key(keysym, true, signal);
      await delay(4, signal);
      await this.key(keysym, false, signal);
      await delay(4, signal);
    }
  }

  async pressKey(name: string, modifiers: readonly string[] | undefined, signal?: AbortSignal): Promise<void> {
    const normalized = normalizeModifiers(modifiers);
    const keysym = keysymForNamedKey(name);
    try {
      for (const modifier of normalized) await this.key(keysymForModifier(modifier), true, signal);
      if (normalized.length > 0) await delay(20, signal);
      await this.key(keysym, true, signal);
      await delay(20, signal);
      await this.key(keysym, false, signal);
      await delay(20, signal);
    } finally {
      for (const modifier of [...normalized].reverse()) await this.key(keysymForModifier(modifier), false).catch(() => {});
    }
  }

  async scroll(x: number, y: number, dx: number, dy: number, signal?: AbortSignal): Promise<void> {
    this.validatePoint(x, y);
    if (![dx, dy].every((value) => Number.isInteger(value) && value >= -20 && value <= 20)) {
      throw new Error("Guest scroll ticks must be integers from -20 to 20");
    }
    const pulses: number[] = [];
    const add = (value: number, negativeMask: number, positiveMask: number) => {
      for (let count = 0; count < Math.abs(value); count += 1) pulses.push(value < 0 ? negativeMask : positiveMask);
    };
    add(dy, 16, 8);
    add(dx, 32, 64);
    await this.pointer(x, y, 0, signal);
    for (const mask of pulses) {
      await this.pointer(x, y, mask, signal);
      await this.pointer(x, y, 0, signal);
    }
  }

  async drag(x: number, y: number, toX: number, toY: number, button: "left" | "right" | "middle" = "left", signal?: AbortSignal): Promise<void> {
    this.validatePoint(x, y);
    this.validatePoint(toX, toY);
    const mask = button === "left" ? 1 : button === "middle" ? 2 : 4;
    const distance = Math.max(Math.abs(toX - x), Math.abs(toY - y));
    const steps = Math.max(1, Math.ceil(distance / 20));
    await this.pointer(x, y, mask, signal);
    try {
      for (let step = 1; step <= steps; step += 1) {
        const nextX = Math.round(x + ((toX - x) * step) / steps);
        const nextY = Math.round(y + ((toY - y) * step) / steps);
        await delay(15, signal);
        await this.pointer(nextX, nextY, mask, signal);
      }
    } finally {
      await this.pointer(toX, toY, 0).catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.releaseAll().catch(() => {});
    this.stream.destroy();
  }

  private async handshake(password: string | Buffer, signal?: AbortSignal): Promise<void> {
    const version = (await this.bytes.read(12, 5000, signal)).toString("ascii");
    if (!ACCEPTED_RFB_VERSIONS.has(version)) throw new Error(`Unsupported RFB version: ${JSON.stringify(version)}`);
    await this.write(Buffer.from(CLIENT_RFB_VERSION, "ascii"), signal);

    const count = (await this.bytes.read(1, 5000, signal))[0]!;
    if (count === 0) throw new Error(`RFB server rejected negotiation: ${await this.readReason(signal)}`);
    const securityTypes = await this.bytes.read(count, 5000, signal);
    if (!securityTypes.includes(2)) throw new Error("RFB server did not offer authenticated VNC security");
    await this.write(Buffer.from([2]), signal);
    const challenge = await this.bytes.read(16, 5000, signal);
    await this.write(vncChallengeResponse(password, challenge), signal);
    const securityResult = (await this.bytes.read(4, 5000, signal)).readUInt32BE();
    if (securityResult !== 0) throw new Error(`RFB authentication failed: ${await this.readReason(signal)}`);

    await this.write(Buffer.from([1]), signal);
    const serverInit = await this.bytes.read(24, 5000, signal);
    this.resize(serverInit.readUInt16BE(0), serverInit.readUInt16BE(2));
    const nameBytes = serverInit.readUInt32BE(20);
    if (nameBytes > 4096) throw new Error("RFB desktop name exceeds its limit");
    await this.bytes.read(nameBytes, 5000, signal);
    await this.write(this.pixelFormatMessage(), signal);
    await this.write(this.encodingMessage(), signal);
  }

  private async readReason(signal?: AbortSignal): Promise<string> {
    const length = (await this.bytes.read(4, 5000, signal)).readUInt32BE();
    if (length > 4096) throw new Error("RFB failure reason exceeds its limit");
    return (await this.bytes.read(length, 5000, signal)).toString("utf8");
  }

  private pixelFormatMessage(): Buffer {
    const message = Buffer.alloc(20);
    message[0] = 0;
    message[4] = 32;
    message[5] = 24;
    message[6] = 0;
    message[7] = 1;
    message.writeUInt16BE(255, 8);
    message.writeUInt16BE(255, 10);
    message.writeUInt16BE(255, 12);
    message[14] = 16;
    message[15] = 8;
    message[16] = 0;
    return message;
  }

  private encodingMessage(): Buffer {
    const message = Buffer.alloc(12);
    message[0] = 2;
    message.writeUInt16BE(2, 2);
    message.writeInt32BE(0, 4);
    message.writeInt32BE(DESKTOP_SIZE_ENCODING, 8);
    return message;
  }

  private framebufferRequest(): Buffer {
    const message = Buffer.alloc(10);
    message[0] = 3;
    message[1] = 0;
    message.writeUInt16BE(0, 2);
    message.writeUInt16BE(0, 4);
    message.writeUInt16BE(this.width, 6);
    message.writeUInt16BE(this.height, 8);
    return message;
  }

  private async readFramebufferUpdate(signal?: AbortSignal): Promise<boolean> {
    const header = await this.bytes.read(3, 5000, signal);
    const rectangleCount = header.readUInt16BE(1);
    if (rectangleCount > 64) throw new Error("RFB framebuffer update has too many rectangles");
    let pixelsUpdated = false;
    for (let index = 0; index < rectangleCount; index += 1) {
      const rectangle = await this.bytes.read(12, 5000, signal);
      const x = rectangle.readUInt16BE(0);
      const y = rectangle.readUInt16BE(2);
      const width = rectangle.readUInt16BE(4);
      const height = rectangle.readUInt16BE(6);
      const encoding = rectangle.readInt32BE(8);
      if (encoding === DESKTOP_SIZE_ENCODING) {
        if (x !== 0 || y !== 0) throw new Error("RFB DesktopSize rectangle has a nonzero origin");
        this.resize(width, height);
        continue;
      }
      if (encoding !== 0) throw new Error(`Unsupported RFB encoding: ${encoding}`);
      this.validateRectangle(x, y, width, height);
      const raw = await this.bytes.read(width * height * 4, 5000, signal);
      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          const input = (row * width + column) * 4;
          const output = ((y + row) * this.width + x + column) * 4;
          this.rgba[output] = raw[input + 2]!;
          this.rgba[output + 1] = raw[input + 1]!;
          this.rgba[output + 2] = raw[input]!;
          this.rgba[output + 3] = 255;
        }
      }
      pixelsUpdated = true;
    }
    return pixelsUpdated;
  }

  private async readServerClipboard(signal?: AbortSignal): Promise<void> {
    const header = await this.bytes.read(7, 5000, signal);
    const length = header.readUInt32BE(3);
    if (length > 32 * 1024) throw new Error("RFB server clipboard exceeds its limit");
    await this.bytes.read(length, 5000, signal);
  }

  private resize(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_WIDTH || height > MAX_HEIGHT) {
      throw new Error(`RFB framebuffer dimensions are out of bounds: ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.rgba = Buffer.alloc(width * height * 4);
  }

  private validateRectangle(x: number, y: number, width: number, height: number): void {
    if (width < 1 || height < 1 || x + width > this.width || y + height > this.height) {
      throw new Error("RFB rectangle exceeds framebuffer bounds");
    }
  }

  private validatePoint(x: number, y: number): void {
    if (![x, y].every(Number.isInteger) || x < 0 || y < 0 || x >= this.width || y >= this.height) {
      throw new Error(`Guest point is outside the ${this.width}x${this.height} framebuffer`);
    }
  }

  private async pointer(x: number, y: number, mask: number, signal?: AbortSignal): Promise<void> {
    this.pointerX = x;
    this.pointerY = y;
    this.pointerMask = mask;
    const message = Buffer.alloc(6);
    message[0] = 5;
    message[1] = mask;
    message.writeUInt16BE(x, 2);
    message.writeUInt16BE(y, 4);
    await this.write(message, signal);
  }

  private async key(keysym: number, down: boolean, signal?: AbortSignal): Promise<void> {
    const message = Buffer.alloc(8);
    message[0] = 4;
    message[1] = down ? 1 : 0;
    message.writeUInt32BE(keysym >>> 0, 4);
    await this.write(message, signal);
    if (down) this.heldKeys.add(keysym);
    else this.heldKeys.delete(keysym);
  }

  private async releaseAll(): Promise<void> {
    for (const keysym of [...this.heldKeys]) await this.key(keysym, false).catch(() => {});
    if (this.pointerMask !== 0) await this.pointer(this.pointerX, this.pointerY, 0).catch(() => {});
  }

  private async write(data: Buffer, signal?: AbortSignal): Promise<void> {
    this.ensureOpen();
    if (signal?.aborted) throw new Error("RFB operation cancelled");
    if (this.stream.write(data)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.stream.destroy();
        reject(new Error("RFB write timed out"));
      }, 5000);
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        this.stream.destroy();
        reject(new Error("RFB operation cancelled"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.stream.off("drain", onDrain);
        signal?.removeEventListener("abort", onAbort);
      };
      this.stream.once("drain", onDrain);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private ensureOpen(): void {
    if (this.stream.destroyed) throw new Error("RFB connection is closed");
  }

  private static validatePassword(password: string | Buffer): void {
    const bytes = typeof password === "string" ? Buffer.byteLength(password, "utf8") : password.length;
    if (bytes === 0 || bytes > 128) throw new Error("RFB password is invalid");
  }
}

export async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("RFB operation cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      cleanup();
      reject(new Error("RFB operation cancelled"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type { RgbaFrame };
