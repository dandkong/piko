import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { McpClient, StdioTransport, StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp";
import { logInfo, logWarn } from "../../logging";
import type { McpServer } from "./config";

function expand(value: string, env: Record<string, string | undefined>, field: string): string {
  if (value.startsWith("!")) throw new Error(`MCP ${field}: command substitution is not supported`);
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    if (env[key] === undefined) throw new Error(`MCP ${field}: environment variable ${key} is missing`);
    return env[key]!;
  });
}
function homePath(value: string): string { return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value; }

/** Owns MCP connections and their lifetime, independently of the Agent runtime. */
export class McpConnections {
  private readonly clients = new Map<string, McpClient>();
  private readonly openings = new Map<string, Promise<McpClient>>();
  private readonly instructions = new Map<string, string>();
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly servers: McpServer[], private readonly env: Record<string, string | undefined>,
    private readonly cwd: string, private readonly onTools: (server: McpServer, tools: Tool[]) => void) {}

  async start(): Promise<void> {
    await Promise.all(this.servers.filter(s => s.entry.config.enabled !== false).map(s => this.connect(s).catch(() => undefined)));
    this.timer = setInterval(() => {
      for (const server of this.servers) if (server.entry.config.enabled !== false && !this.clients.has(server.name))
        void this.connect(server).catch(() => undefined);
    }, 30_000);
    this.timer.unref();
  }
  instructionsFor(server: string): string | undefined { return this.instructions.get(server); }
  connect(server: McpServer): Promise<McpClient> {
    const current = this.clients.get(server.name);
    if (current?.connectionState === "connected") return Promise.resolve(current);
    const existing = this.openings.get(server.name);
    if (existing) return existing;
    const opening = this.open(server).finally(() => this.openings.delete(server.name));
    this.openings.set(server.name, opening);
    return opening;
  }
  private async open(server: McpServer): Promise<McpClient> {
    if (this.closed) throw new Error("MCP is shutting down");
    const { config } = server.entry;
    const client = new McpClient({ name: "piko", version: "0.1.0", requestTimeoutMs: (config.timeout ?? 60) * 1000 });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const transport = server.entry.kind === "stdio"
        ? new StdioTransport({ command: homePath(server.entry.config.command), args: server.entry.config.args?.map(homePath),
            cwd: resolve(this.cwd, homePath(server.entry.config.cwd ?? ".")), inheritEnv: false,
            env: { ...Object.fromEntries(Object.entries(this.env).filter((e): e is [string, string] => e[1] !== undefined)),
              ...Object.fromEntries(Object.entries(server.entry.config.env ?? {}).map(([key, value]) => [key, expand(value, this.env, `${server.name}.env.${key}`)])) }, stderr: "pipe" })
        : new StreamableHttpTransport({ url: server.entry.config.url,
            headers: Object.fromEntries(Object.entries(server.entry.config.headers ?? {}).map(([key, value]) => [key, expand(value, this.env, `${server.name}.headers.${key}`)])) });
      await Promise.race([client.connect(transport), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("MCP connection timed out")), Math.min((config.timeout ?? 60) * 1000, 10_000));
      })]);
      if (timeout) clearTimeout(timeout);
      if (this.closed) throw new Error("MCP is shutting down");
      const tools = await client.listTools();
      if (this.closed) throw new Error("MCP is shutting down");
      this.clients.set(server.name, client);
      if (client.instructions) this.instructions.set(server.name, client.instructions);
      else this.instructions.delete(server.name);
      client.onClose(() => { if (this.clients.get(server.name) === client) this.clients.delete(server.name); });
      client.onNotification("notifications/tools/list_changed", () => {
        void client.listTools().then(tools => { if (!this.closed && this.clients.get(server.name) === client) this.onTools(server, tools); })
          .catch(() => logWarn("mcp.tools.refresh_failed", { server: server.name }));
      });
      this.onTools(server, tools);
      logInfo("mcp.connected", { server: server.name, tools: tools.length });
      return client;
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      await client.close().catch(() => undefined);
      logWarn("mcp.connection.failed", { server: server.name, reason: error instanceof Error && error.message.includes("environment variable") ? "missing environment variable" : "connection unavailable or authentication required" });
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.clients.values()].map(client => client.close()));
    await Promise.allSettled([...this.openings.values()]);
    await Promise.allSettled([...this.clients.values()].map(client => client.close()));
    this.clients.clear();
  }
}
