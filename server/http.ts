export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function withCors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", "Origin");
  else if (!vary.toLowerCase().split(/,\s*/).includes("origin")) headers.set("Vary", `${vary}, Origin`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
