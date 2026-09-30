export type ServerConfig = {
  hostname: string;
  port: number;
  allowedOrigins: ReadonlySet<string>;
  idleSessionMs: number;
  maxSessions: number;
  maxRequestBytes: number;
};

export function readServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    hostname: env.PIKO_HOST ?? "127.0.0.1",
    port: Number(env.PIKO_PORT ?? 8787),
    allowedOrigins: new Set((env.PIKO_CORS_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean)),
    idleSessionMs: 30 * 60 * 1000,
    maxSessions: 32,
    maxRequestBytes: 64_000,
  };
}
