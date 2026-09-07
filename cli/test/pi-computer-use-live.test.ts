import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { encodePng } from "../../agents/pi/gdm-computer-use/png.ts";
import { delay } from "../../agents/pi/gdm-computer-use/rfb.ts";
import { TartVmManager } from "../../agents/pi/gdm-computer-use/vm.ts";

const live = process.env.GDM_CU_LIVE === "1" ? test : test.skip;

function frontmost(): string {
  const result = Bun.spawnSync(["/usr/bin/lsappinfo", "front"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function stableFrontmost(): Promise<string> {
  const deadline = Date.now() + 15_000;
  let candidate = frontmost();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await delay(100);
    const current = frontmost();
    if (current !== candidate) {
      candidate = current;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= 3000) return candidate;
  }
  throw new Error("host frontmost app did not remain stable for 3 seconds");
}

function tartTcpListeners(): string {
  const processList = Bun.spawnSync(["/bin/ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "pipe" });
  if (processList.exitCode !== 0) throw new Error(processList.stderr.toString());
  const pids = processList.stdout.toString().split(/\r?\n/u).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    if (!match || !match[2]!.includes("tart") || !match[2]!.includes("gdm-cu-vm")) return [];
    return [match[1]!];
  });
  if (pids.length === 0) throw new Error("owned Tart process is missing");
  const listeners = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listeners.exitCode !== 0 && listeners.exitCode !== 1) throw new Error(listeners.stderr.toString());
  return listeners.stdout.toString().trim();
}

live("keeps host focus unchanged while real Tart VNC types only inside the guest", async () => {
  const baseline = await stableFrontmost();
  const sampler = Bun.spawn([
    "/bin/bash", "-c",
    "while :; do /usr/bin/lsappinfo front; printf '\\036'; sleep 0.1; done",
  ], { stdout: "pipe", stderr: "pipe" });
  const samplesPromise = new Response(sampler.stdout).text();
  const manager = new TartVmManager();
  const guestPath = `/tmp/gdmcu-proof-${process.pid}-${Date.now()}.txt`;
  const sentinel = "G";

  try {
    expect(existsSync(guestPath)).toBe(false);
    await manager.start();
    expect(tartTcpListeners()).toBe("");
    let observed = "";
    for (let attempt = 0; attempt < 3 && observed !== sentinel; attempt += 1) {
      await manager.execGuest(["/usr/bin/killall", "TextEdit"]).catch(() => {});
      await delay(1000);
      await manager.execGuest(["/bin/rm", "-f", guestPath]);
      await manager.execGuest(["/usr/bin/touch", guestPath]);
      await manager.execGuest([
        "/usr/bin/sudo", "/bin/launchctl", "asuser", "501",
        "/usr/bin/open", "-a", "TextEdit", guestPath,
      ]);
      await delay(3000);
      await manager.screenshot();
      await manager.click(600, 300);
      await manager.typeText(sentinel);
      await manager.pressKey("s", ["cmd"]);
      await delay(500);
      await manager.pressKey("s", ["cmd"]);
      await delay(2500);
      observed = (await manager.execGuest(["/bin/cat", guestPath])).trim();
    }
    expect(observed).toBe(sentinel);
    expect(existsSync(guestPath)).toBe(false);
    await manager.execGuest(["/bin/rm", "-f", guestPath]);
    await manager.openApp("TextEdit");
    const frame = await manager.screenshot();
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
    expect(encodePng(frame).subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(tartTcpListeners()).toBe("");
    await manager.stop();
    await manager.stop();
    expect((await manager.status()).state).toBe("stopped");
  } finally {
    await manager.stop().catch(() => {});
    sampler.kill("SIGTERM");
    await sampler.exited;
  }

  const samples = (await samplesPromise).split("\u001e").map((sample) => sample.trim()).filter(Boolean);
  expect(samples.length).toBeGreaterThan(5);
  expect(new Set(samples)).toEqual(new Set([baseline]));
}, 300_000);
