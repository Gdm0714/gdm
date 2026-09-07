import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { encodeAppleVncPassword, vncChallengeResponse } from "../../agents/pi/gdm-computer-use/auth.ts";
import { encodePng } from "../../agents/pi/gdm-computer-use/png.ts";
import { RfbClient } from "../../agents/pi/gdm-computer-use/rfb.ts";
import { createSessionPassword } from "../../agents/pi/gdm-computer-use/vm.ts";

class Reader {
  constructor(private readonly socket: Socket) {}

  async read(bytes: number): Promise<Buffer> {
    while (true) {
      const chunk = this.socket.read(bytes) as Buffer | null;
      if (chunk) return chunk;
      await once(this.socket, "readable");
    }
  }
}

function serverInit(width: number, height: number): Buffer {
  const message = Buffer.alloc(24);
  message.writeUInt16BE(width, 0);
  message.writeUInt16BE(height, 2);
  message[4] = 32;
  message[5] = 24;
  message[7] = 1;
  message.writeUInt16BE(255, 8);
  message.writeUInt16BE(255, 10);
  message.writeUInt16BE(255, 12);
  message[14] = 16;
  message[15] = 8;
  message.writeUInt32BE(0, 20);
  return message;
}

function rawUpdate(width: number, height: number, pixels: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header[0] = 0;
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(width, 8);
  header.writeUInt16BE(height, 10);
  header.writeInt32BE(0, 12);
  return Buffer.concat([header, pixels]);
}

async function withRfbServer<T>(handler: (socket: Socket, reader: Reader) => Promise<void>, run: (port: number) => Promise<T>): Promise<T> {
  let serverError: Error | undefined;
  const server = createServer((socket) => {
    handler(socket, new Reader(socket)).catch((error) => {
      serverError = error;
      socket.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake RFB server did not bind TCP");
  try {
    const result = await run(address.port);
    if (serverError) throw serverError;
    return result;
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function handshake(socket: Socket, reader: Reader, password: string, version = "RFB 003.008\n"): Promise<void> {
  socket.write(version);
  expect((await reader.read(12)).toString("ascii")).toBe("RFB 003.008\n");
  socket.write(Buffer.from([1, 2]));
  expect(await reader.read(1)).toEqual(Buffer.from([2]));
  const challenge = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  socket.write(challenge);
  expect(await reader.read(16)).toEqual(vncChallengeResponse(password, challenge));
  socket.write(Buffer.alloc(4));
  expect(await reader.read(1)).toEqual(Buffer.from([1]));
  socket.write(serverInit(2, 1));
  expect((await reader.read(20))[0]).toBe(0);
  const encodings = await reader.read(12);
  expect(encodings[0]).toBe(2);
  expect(encodings.readInt32BE(4)).toBe(0);
  expect(encodings.readInt32BE(8)).toBe(-223);
}

describe("gdm-pi Computer Use RFB primitives", () => {
  test("uses all 8 CSPRNG bytes and encodes Apple legacy VNC authentication", () => {
    const random = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x88, 0xaa, 0xdd, 0xff]);
    const password = createSessionPassword((bytes) => {
      expect(bytes).toBe(8);
      return random;
    });
    expect(password).toEqual(random);
    expect(password).not.toBe(random);
    expect(encodeAppleVncPassword("gdmtest1").toString("ascii")).toBe("70503C1AEEDBB1D3FF1C39567390ADCA");
    expect(() => encodeAppleVncPassword("123456789")).toThrow("1-8 UTF-8 bytes");
    const response = vncChallengeResponse("secret", Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"));
    expect(response.toString("hex")).toBe("ee22539f33a5983ec12f9c2edbc995dd");
  });

  test("negotiates authenticated raw framebuffer and emits guest-only input messages", async () => {
    const events: Buffer[] = [];
    await withRfbServer(async (socket, reader) => {
      await handshake(socket, reader, "test-pass", "RFB 003.889\n");
      expect((await reader.read(10))[0]).toBe(3);
      socket.write(rawUpdate(2, 1, Buffer.from([0, 0, 255, 0, 0, 255, 0, 0])));
      while (!socket.destroyed) {
        const type = (await reader.read(1))[0]!;
        const remaining = type === 4 ? 7 : type === 5 ? 5 : 0;
        if (remaining === 0) throw new Error(`unexpected client message ${type}`);
        events.push(Buffer.concat([Buffer.from([type]), await reader.read(remaining)]));
      }
    }, async (port) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      await once(socket, "connect");
      const client = await RfbClient.connectStream(socket, "test-pass");
      const frame = await client.screenshot();
      expect(frame).toEqual({
        width: 2,
        height: 1,
        rgba: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]),
      });
      const png = encodePng(frame);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      await client.click(1, 0);
      await client.typeText("A\n");
      await client.pressKey("left", ["cmd"]);
      await client.scroll(1, 0, 0, 1);
      await client.close();
    });
    expect(events.some((event) => event[0] === 5 && event[1] === 1)).toBe(true);
    expect(events.some((event) => event[0] === 4 && event.readUInt32BE(4) === 0x41)).toBe(true);
    expect(events.some((event) => event[0] === 4 && event.readUInt32BE(4) === 0xffeb)).toBe(true);
    expect(events.some((event) => event[0] === 5 && event[1] === 8)).toBe(true);
  });
});
