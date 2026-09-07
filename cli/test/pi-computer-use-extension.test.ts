import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";

mock.module("@earendil-works/pi-ai", () => ({
  Type: {
    Object: (properties: unknown, options?: unknown) => ({ type: "object", properties, options }),
    Union: (items: unknown[]) => ({ anyOf: items }),
    Literal: (value: unknown) => ({ const: value }),
    Optional: (value: unknown) => ({ optional: value }),
    String: (options?: unknown) => ({ type: "string", options }),
    Number: () => ({ type: "number" }),
    Array: (items: unknown, options?: unknown) => ({ type: "array", items, options }),
  },
}));

const extensionUrl = pathToFileURL(join(import.meta.dir, "..", "..", "agents", "pi", "gdm-computer-use", "index.ts")).href;
const { installGdmComputerUse } = await import(extensionUrl);
const { RfbClient } = await import("../../agents/pi/gdm-computer-use/rfb.ts");
const { vncChallengeResponse } = await import("../../agents/pi/gdm-computer-use/auth.ts");
const { TartVmManager } = await import("../../agents/pi/gdm-computer-use/vm.ts");

const roots: string[] = [];
const oldTartPath = process.env.GDM_TART_PATH;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (oldTartPath === undefined) delete process.env.GDM_TART_PATH;
  else process.env.GDM_TART_PATH = oldTartPath;
});

class FakeBackend {
  calls: string[] = [];
  screenshotGate: Promise<void> | undefined;

  async status() { return { state: "ready" as const, vmName: "gdm-cu-vm", owned: true }; }
  async start() { this.calls.push("start"); }
  async stop() { this.calls.push("stop"); }
  async screenshot() {
    await this.screenshotGate;
    this.calls.push("screenshot");
    return { width: 1, height: 1, rgba: Buffer.from([10, 20, 30, 255]) };
  }
  async click(x: number, y: number) { this.calls.push(`click:${x},${y}`); }
  async typeText(text: string) { this.calls.push(`type:${text}`); }
  async pressKey(key: string, modifiers: readonly string[] | undefined) { this.calls.push(`key:${key}:${modifiers?.join("+") ?? ""}`); }
  async scroll(x: number, y: number, dx: number, dy: number) { this.calls.push(`scroll:${x},${y},${dx},${dy}`); }
  async drag(x: number, y: number, toX: number, toY: number) { this.calls.push(`drag:${x},${y},${toX},${toY}`); }
  async openApp(app: string) { this.calls.push(`open:${app}`); }
  async execGuest() { return ""; }
}

function setup(backend = new FakeBackend()) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
  };
  installGdmComputerUse(pi as any, backend as any);
  return { backend, tool: tools.get("gdm_computer_use"), handlers };
}

async function execute(tool: any, params: Record<string, unknown>, signal?: AbortSignal) {
  return await tool.execute("call", params, signal, undefined, {});
}

class Reader {
  constructor(private readonly socket: Socket) {}
  async read(bytes: number): Promise<Buffer> {
    while (true) {
      const chunk = this.socket.read(bytes) as Buffer | null;
      if (chunk) return chunk;
      if (this.socket.destroyed || this.socket.readableEnded) throw new Error("fake client closed");
      await Promise.race([once(this.socket, "readable"), once(this.socket, "close")]);
    }
  }
}

async function fakeServer(handler: (socket: Socket, reader: Reader) => Promise<void>, run: (port: number) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handler(socket, new Reader(socket)).catch(() => socket.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server did not bind");
  try {
    await run(address.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function authHandshake(socket: Socket, reader: Reader, width: number, height: number): Promise<void> {
  socket.write("RFB 003.008\n");
  await reader.read(12);
  socket.write(Buffer.from([1, 2]));
  await reader.read(1);
  const challenge = Buffer.alloc(16, 7);
  socket.write(challenge);
  expect(await reader.read(16)).toEqual(vncChallengeResponse("pass", challenge));
  socket.write(Buffer.alloc(4));
  await reader.read(1);
  const init = Buffer.alloc(24);
  init.writeUInt16BE(width, 0);
  init.writeUInt16BE(height, 2);
  init[4] = 32;
  init[5] = 24;
  init[7] = 1;
  init.writeUInt16BE(255, 8);
  init.writeUInt16BE(255, 10);
  init.writeUInt16BE(255, 12);
  init.writeUInt32BE(0, 20);
  socket.write(init);
  await reader.read(20);
  await reader.read(12);
}

describe("gdm-pi isolated Computer Use extension", () => {
  test("dispatches the single tool and returns guest screenshots as images", async () => {
    const app = setup();
    expect((await execute(app.tool, { action: "status" })).content[0].text).toContain("ready");
    const started = await execute(app.tool, { action: "start" });
    expect(started.content.map((item: any) => item.type)).toEqual(["text", "image"]);
    expect(started.content[1].mimeType).toBe("image/png");
    await execute(app.tool, { action: "click", x: 0, y: 0 });
    await execute(app.tool, { action: "type_text", text: "hello" });
    await execute(app.tool, { action: "press_key", key: "return", modifiers: ["cmd"] });
    await execute(app.tool, { action: "scroll", x: 0, y: 0, dx: 0, dy: 1 });
    await execute(app.tool, { action: "drag", x: 0, y: 0, toX: 0, toY: 0 });
    await execute(app.tool, { action: "open_app", app: "Terminal" });
    expect(app.backend.calls).toContain("click:0,0");
    expect(app.backend.calls).toContain("open:Terminal");
    await app.handlers.get("session_shutdown")?.();
    expect(app.backend.calls.at(-1)).toBe("stop");
  });

  test("rejects concurrent, cancelled, and malformed actions before backend mutation", async () => {
    const app = setup();
    let release!: () => void;
    app.backend.screenshotGate = new Promise<void>((resolve) => { release = resolve; });
    const first = execute(app.tool, { action: "screenshot" });
    await Promise.resolve();
    await expect(execute(app.tool, { action: "status" })).rejects.toThrow("busy");
    release();
    await first;

    const controller = new AbortController();
    controller.abort();
    await expect(execute(app.tool, { action: "status" }, controller.signal)).rejects.toThrow("cancelled");
    await expect(execute(app.tool, { action: "click", x: 0.5, y: 0 })).rejects.toThrow("x must be an integer");
    await expect(execute(app.tool, { action: "type_text" })).rejects.toThrow("text is required");
    expect(app.backend.calls.some((call) => call.startsWith("click:0.5"))).toBe(false);
  });

  test("fails closed on unauthenticated, oversized, out-of-bounds, and stalled RFB peers", async () => {
    await fakeServer(async (socket, reader) => {
      socket.write("RFB 003.008\n");
      await reader.read(12);
      socket.write(Buffer.from([1, 1]));
    }, async (port) => {
      await expect(RfbClient.connect({ host: "127.0.0.1", port, password: "pass" })).rejects.toThrow("authenticated");
    });

    await fakeServer(async (socket, reader) => {
      await authHandshake(socket, reader, 30_000, 30_000);
    }, async (port) => {
      await expect(RfbClient.connect({ host: "127.0.0.1", port, password: "pass" })).rejects.toThrow("out of bounds");
    });

    await fakeServer(async (socket, reader) => {
      await authHandshake(socket, reader, 2, 1);
      await reader.read(10);
      const update = Buffer.alloc(16);
      update[0] = 0;
      update.writeUInt16BE(1, 2);
      update.writeUInt16BE(0, 4);
      update.writeUInt16BE(0, 6);
      update.writeUInt16BE(3, 8);
      update.writeUInt16BE(1, 10);
      update.writeInt32BE(0, 12);
      socket.write(update);
    }, async (port) => {
      const client = await RfbClient.connect({ host: "127.0.0.1", port, password: "pass" });
      await expect(client.screenshot()).rejects.toThrow("bounds");
      await client.close();
    });

    await fakeServer(async (socket, reader) => {
      await authHandshake(socket, reader, 2, 1);
      await reader.read(10);
    }, async (port) => {
      const client = await RfbClient.connect({ host: "127.0.0.1", port, password: "pass" });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      await expect(client.screenshot(controller.signal)).rejects.toThrow("cancelled");
      await expect(client.screenshot()).rejects.toThrow("closed");
      await client.close();
    });
  }, 20_000);

  test("blocks an immediate short Tart fork before setsid escape can occur", async () => {
    const root = mkdtempSync(join(tmpdir(), "gdm-cu-command-descendant-"));
    roots.push(root);
    const tart = join(root, "tart");
    const token = `gdm-cu-command-descendant-${process.pid}`;
    writeFileSync(tart, `#!/usr/bin/env bash
if [ "\${1:-}" = list ]; then
  exec /usr/bin/python3 -c 'import os,socket,sys,time
pid=os.fork()
if pid:
 print("[{\\"Name\\":\\"gdm-cu-vm\\",\\"Running\\":false,\\"State\\":\\"Stopped\\"}]")
 sys.stdout.flush()
 os._exit(0)
os.setsid()
for fd in (0,1,2):
 try: os.close(fd)
 except OSError: pass
token="${token}"
s=socket.socket()
s.bind(("127.0.0.1",0))
s.listen()
time.sleep(120)'
fi
exit 99
`);
    chmodSync(tart, 0o755);
    process.env.GDM_TART_PATH = tart;
    const manager = new TartVmManager();
    const status = await manager.status();
    expect(status.state).toBe("not-installed");
    expect(status.lastError).toContain("Operation not permitted");
    expect(Bun.spawnSync(["/bin/ps", "-axo", "command="], { stdout: "pipe" }).stdout.toString()).not.toContain(token);
  }, 15_000);

  test("refuses to attach to a VM owned by another process", async () => {
    const root = mkdtempSync(join(tmpdir(), "gdm-cu-fake-tart-"));
    roots.push(root);
    const tart = join(root, "tart");
    writeFileSync(tart, `#!/usr/bin/env bash
if [ "\${1:-}" = list ]; then printf '[{"Name":"gdm-cu-vm","Running":true,"State":"Running"}]\\n'; exit 0; fi
exit 99
`);
    chmodSync(tart, 0o755);
    process.env.GDM_TART_PATH = tart;
    const manager = new TartVmManager();
    await expect(manager.start()).rejects.toThrow("another process");
  });

  test("kills its owned VM when the Tart process exposes a host TCP listener", async () => {
    const root = mkdtempSync(join(tmpdir(), "gdm-cu-listening-tart-"));
    roots.push(root);
    const tart = join(root, "tart");
    const token = `gdm-cu-immediate-listener-${process.pid}`;
    writeFileSync(tart, `#!/usr/bin/env bash
case "\${1:-}" in
  list) printf '[{"Name":"gdm-cu-vm","Running":false,"State":"Stopped"}]\\n' ;;
  run) exec /usr/bin/python3 -c 'import socket,time; token="${token}"; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); time.sleep(120)' ;;
  exec) end=$((SECONDS + 1)); while (( SECONDS < end )); do :; done; exit 0 ;;
  *) exit 99 ;;
esac
`);
    chmodSync(tart, 0o755);
    process.env.GDM_TART_PATH = tart;
    const manager = new TartVmManager();
    await expect(manager.start()).rejects.toThrow("exposed a host TCP listener");
    expect((await manager.status()).owned).toBe(false);
    expect(Bun.spawnSync(["/bin/ps", "-axo", "command="], { stdout: "pipe" }).stdout.toString()).not.toContain(token);
  }, 15_000);

  test("continuously detects a delayed descendant listener and removes the owned process groups", async () => {
    const root = mkdtempSync(join(tmpdir(), "gdm-cu-delayed-listener-"));
    roots.push(root);
    const tart = join(root, "tart");
    const rfb = join(root, "rfb.js");
    const token = `gdm-cu-delayed-listener-${process.pid}`;
    writeFileSync(rfb, `
let pending = Buffer.alloc(0);
const waits = [];
process.stdin.on("data", (chunk) => { pending = Buffer.concat([pending, chunk]); pump(); });
function pump() { while (waits.length && pending.length >= waits[0].bytes) { const next = waits.shift(); const value = pending.subarray(0, next.bytes); pending = pending.subarray(next.bytes); next.resolve(value); } }
function read(bytes) { return new Promise((resolve) => { waits.push({ bytes, resolve }); pump(); }); }
process.stdout.write("RFB 003.889\\n");
await read(12); process.stdout.write(Buffer.from([1, 2]));
await read(1); process.stdout.write(Buffer.alloc(16, 7));
await read(16); process.stdout.write(Buffer.alloc(4));
await read(1);
const init = Buffer.alloc(24); init.writeUInt16BE(1, 0); init.writeUInt16BE(1, 2); init[4]=32; init[5]=24; init[7]=1; init.writeUInt16BE(255,8); init.writeUInt16BE(255,10); init.writeUInt16BE(255,12); process.stdout.write(init);
await read(20); await read(12); await new Promise((resolve) => process.stdin.once("end", resolve));
`);
    writeFileSync(tart, `#!/usr/bin/env bash
case "\${1:-}" in
  list) printf '[{"Name":"gdm-cu-vm","Running":false,"State":"Stopped"}]\\n' ;;
  run)
    (sleep 3; exec /usr/bin/python3 -c 'import socket,time; token="${token}"; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); time.sleep(120)') &
    wait
    ;;
  exec)
    shift
    interactive=0
    if [ "\${1:-}" = -i ]; then interactive=1; shift; fi
    [ "\${1:-}" = gdm-cu-vm ] && shift
    if [ "\${1:-}" = /bin/cat ]; then printf 'gdm-computer-use-vsock-v1\\n'; exit 0; fi
    if [ "\${1:-}" = /usr/bin/nc ]; then exec '${process.execPath}' '${rfb}'; fi
    exit 0
    ;;
  *) exit 99 ;;
esac
`);
    chmodSync(tart, 0o755);
    process.env.GDM_TART_PATH = tart;
    const manager = new TartVmManager();
    await manager.start();
    let status = await manager.status();
    const deadline = Date.now() + 10_000;
    while (status.owned && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      status = await manager.status();
    }
    expect(status.owned).toBe(false);
    expect(status.lastError).toContain("exposed a host TCP listener");
    expect(Bun.spawnSync(["/bin/ps", "-axo", "command="], { stdout: "pipe" }).stdout.toString()).not.toContain(token);
  }, 20_000);
});
