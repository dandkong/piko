import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { loadPikoConfig } from "../server/config";

const root = resolve(import.meta.dir, "..");
const mobileRoot = resolve(root, "apps/mobile");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun run dev [--web | --android | --ios]\nStarts API + Expo on port 8081. Ctrl+C stops both.");
  process.exit(0);
}

const port = 8081;
const piko = loadPikoConfig();
const config = piko.http;
const env = {
  ...process.env,
  PIKO_CORS_ORIGINS: [...new Set([
    ...config.allowedOrigins,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ])].join(","),
};
const children: ChildProcess[] = [];
let stopping = false;

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  if (process.platform === "win32") {
    // Stop only the process tree launched by this command, including Metro workers.
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    if (result.error || result.status !== 0) child.kill("SIGKILL");
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited,
    new Promise<void>((done) => {
      timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            if (process.platform === "win32") child.kill("SIGKILL");
            else process.kill(-child.pid!, "SIGKILL");
          } catch { /* The child may have exited just before the timeout. */ }
        }
        done();
      }, 3000);
    }),
  ]);
  clearTimeout(timer);
}

async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (children.length) console.log("\n[Piko] Stopping API and Expo…");
  await Promise.all(children.map(stopChild));
  process.exit(code);
}

process.on("SIGINT", () => { void stop(130); });
process.on("SIGTERM", () => { void stop(143); });

function start(name: string, command: string, commandArgs: string[], cwd: string, interactive = false): ChildProcess {
  const child = spawn(command, commandArgs, {
    cwd, env, stdio: [interactive ? "inherit" : "ignore", "inherit", "inherit"],
    detached: process.platform !== "win32", windowsHide: true,
  });
  children.push(child);
  child.once("error", (error) => { console.error(`[${name}] ${error.message}`); void stop(1); });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    console.log(`[${name}] Exited${signal ? ` (${signal})` : ` with code ${code}`}.`);
    void stop(code ?? 1);
  });
  return child;
}

async function checkPort(host: string, port: number, name: string): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${name} port: ${port}`);
  await new Promise<void>((done, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`${name} port ${port} is unavailable. Stop the existing service before running this command.`)));
    probe.listen({ host, port, exclusive: true }, () => probe.close((error) => error ? reject(error) : done()));
  });
}

try {
  if (args.some((arg) => arg === "--port" || arg === "-p" || arg.startsWith("--port="))) {
    throw new Error("The combined dev command uses Expo port 8081. Use dev:mobile for a custom Expo port.");
  }
  await checkPort(config.hostname, config.port, "API");
  await checkPort("127.0.0.1", port, "Expo");
  await checkPort("localhost", port, "Expo");
  console.log(`[Piko] Starting API on port ${config.port} and Expo on port ${port}.`);
  start("API", process.execPath, ["--watch", "server/index.ts"], root);

  // Let the API become ready before Expo opens a client that loads its history.
  const host = config.hostname === "0.0.0.0" || config.hostname === "::" ? "127.0.0.1" : config.hostname;
  const healthUrl = `http://${host.includes(":") ? `[${host}]` : host}:${config.port}/api/health`;
  let ready = false;
  const deadline = Date.now() + 30_000;
  while (!stopping && Date.now() < deadline) {
    try { ready = (await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* API is still starting. */ }
    if (ready) break;
    await Bun.sleep(200);
  }
  if (!ready) throw new Error("API did not become ready within 30 seconds. Check the API logs above.");
  if (!stopping) start("Expo", "node", [resolve(mobileRoot, "node_modules/expo/bin/cli"), "start", "--port", String(port), ...args], mobileRoot, true);
} catch (error) {
  console.error(`[Piko] ${error instanceof Error ? error.message : String(error)}`);
  await stop(1);
}
