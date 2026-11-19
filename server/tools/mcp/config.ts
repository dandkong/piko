import { join } from "node:path";
import { mcpNamespace, validateMcpServerConfig, type McpServerConfigResult } from "@earendil-works/pi-mcp";
import { readJsonValue } from "../../config/files";

type Exposure = "direct" | "deferred" | "hidden";
export type McpServer = { name: string; entry: Exclude<McpServerConfigResult, { kind: "invalid" }>; exposure: Exposure; overrides: Record<string, Exposure> };
const exposures = new Set(["direct", "deferred", "hidden"]);
function exposure(value: unknown, field: string): Exposure {
  if (typeof value !== "string" || !exposures.has(value)) {
    const unsupported = value === "codemode" || value === "codemode-deferred" ? ` ${value}` : "";
    throw new Error(`Invalid MCP configuration at ${field}: unsupported exposure${unsupported}`);
  }
  return value as Exposure;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

export function readMcpConfig(home: string): McpServer[] {
  const path = join(home, "config", "mcp.json");
  const raw = readJsonValue(path, { mcpServers: {} });
  if (!object(raw) || !object(raw.mcpServers) || Object.keys(raw).some(k => k !== "mcpServers")) throw new Error(`Invalid MCP configuration in ${path}`);
  const namespaces = new Set<string>();
  return Object.entries(raw.mcpServers).map(([name, value]) => {
    const entry = validateMcpServerConfig(name, value);
    if (entry.kind === "invalid") throw new Error(`Invalid MCP server ${JSON.stringify(name)}: ${entry.error}`);
    const namespace = mcpNamespace(name);
    if (namespaces.has(namespace)) throw new Error(`Duplicate MCP server namespace: ${name}`);
    namespaces.add(namespace);
    const allowed = new Set(["type", "command", "args", "env", "cwd", "url", "headers", "enabled", "description", "timeout", "exposure", "toolExposure"]);
    for (const key of Object.keys(entry.config)) if (!allowed.has(key)) throw new Error(`Invalid MCP configuration at ${name}.${key}: unsupported field`);
    const mode = entry.config.exposure === undefined ? "deferred" : exposure(entry.config.exposure, `${name}.exposure`);
    const overrides: Record<string, Exposure> = {};
    if (entry.config.toolExposure !== undefined) {
      if (!object(entry.config.toolExposure)) throw new Error(`Invalid MCP configuration at ${name}.toolExposure`);
      for (const [pattern, value] of Object.entries(entry.config.toolExposure)) overrides[pattern] = exposure(value, `${name}.toolExposure.${pattern}`);
    }
    return { name, entry, exposure: mode, overrides };
  });
}
export function toolExposure(server: McpServer, tool: string): Exposure {
  if (Object.hasOwn(server.overrides, tool)) return server.overrides[tool]!;
  for (const [pattern, mode] of Object.entries(server.overrides)) {
    if (!pattern.includes("*")) continue;
    const regex = new RegExp(`^${pattern.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    if (regex.test(tool)) return mode;
  }
  return server.exposure;
}
