import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { json, readJsonBody } from "./http";

const COOKIE = "piko_session";
const LIFETIME = 30 * 24 * 60 * 60;

/** Authentication is independent of the Durable conversation and its lifetime. */
export function createAuth(key: string, allowedOrigins: string[] = [], allowedHosts: string[] = [], secureCookie = false) {
  if (!key.trim()) throw new Error("PIKO_ACCESS_KEY is required.");
  const sign = (value: string) => createHmac("sha256", key).update(value).digest("base64url");
  const equal = (a: string, b: string) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const valid = (token: string | undefined) => {
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 3 || !/^\d+$/.test(parts[0]!)) return false;
    return Number(parts[0]) > Date.now() && equal(sign(`${parts[0]}.${parts[1]}`), parts[2]!);
  };
  const tokenFor = (request: Request) => {
    const bearer = request.headers.get("authorization");
    if (bearer?.startsWith("Bearer ")) return bearer.slice(7);
    return request.headers.get("cookie")?.split(/;\s*/).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  };
  const originAllowed = (request: Request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (host !== "localhost" && !isIP(host) && !allowedHosts.includes(host)) return false;
      const origin = request.headers.get("origin");
      if (!origin) return true;
      const source = new URL(origin);
      return source.origin === url.origin || allowedOrigins.includes(source.origin);
    } catch { return false; }
  };
  let failures = 0, blockedUntil = 0;
  return {
    allowedOrigin: originAllowed,
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (!originAllowed(request)) return json({ error: "Origin not allowed." }, 403);
      if (url.pathname === "/api/auth/session" && request.method === "GET") return json({ authenticated: valid(tokenFor(request)) });
      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        if (Date.now() < blockedUntil) return json({ error: "Too many attempts." }, 429);
        let input: unknown;
        try { input = await readJsonBody(request, 4096); } catch { return json({ error: "Invalid request." }, 400); }
        const password = input && typeof input === "object" && "key" in input ? (input as { key: unknown }).key : undefined;
        if (typeof password !== "string" || !equal(password, key)) {
          if (++failures >= 5) { failures = 0; blockedUntil = Date.now() + 30_000; }
          return json({ error: "Invalid access key." }, 401);
        }
        failures = 0;
        const value = `${Date.now() + LIFETIME * 1000}.${randomBytes(24).toString("base64url")}`;
        const token = `${value}.${sign(value)}`;
        const native = request.headers.get("x-piko-client") === "native";
        const response = json(native ? { token } : { authenticated: true });
        if (!native) response.headers.set("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${LIFETIME}${url.protocol === "https:" || secureCookie ? "; Secure" : ""}`);
        return response;
      }
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        const response = json({ ok: true });
        response.headers.set("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        return response;
      }
      if ((url.pathname === "/api" || url.pathname.startsWith("/api/")) && !valid(tokenFor(request))) return json({ error: "Authentication required." }, 401);
      return undefined;
    },
  };
}
