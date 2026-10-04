// Test-only bridge: existing black-box CLI assertions execute the native binary.
// Pure TS helpers remain an independent oracle for stored schema/hash validation.
const native = process.env.GDM_NATIVE_TEST_BINARY;
if (!native) throw new Error("GDM_NATIVE_TEST_BINARY is required");
const originalSync = Bun.spawnSync.bind(Bun);
const originalAsync = Bun.spawn.bind(Bun);
function command(argv: readonly string[]): readonly string[] {
  if (argv.length > 1 && /[/\\]cli[/\\]src[/\\]cli\.ts$/.test(argv[1]!)) return [native!, ...argv.slice(2)];
  if (argv.length > 0 && /[/\\]cli[/\\]dist[/\\]gdm$/.test(argv[0]!)) return [native!, ...argv.slice(1)];
  return argv;
}
function call(original: (...args: any[]) => any, first: any, options?: any): any {
  return Array.isArray(first)
    ? original(command(first), options)
    : original({ ...first, cmd: command(first.cmd) });
}
Bun.spawnSync = ((first: any, options?: any) => call(originalSync, first, options)) as typeof Bun.spawnSync;
Bun.spawn = ((first: any, options?: any) => call(originalAsync, first, options)) as typeof Bun.spawn;
