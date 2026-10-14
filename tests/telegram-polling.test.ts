import { expect, spyOn, test } from "bun:test";
import { Bot, GrammyError, HttpError } from "grammy";
import { ConversationStore } from "../server/chat/conversations";
import { TelegramBot } from "../server/channels/telegram/bot";
import { fixture, cleanup, waitUntil } from "./fixtures/durable";

async function pollingFixture(text = "/status") {
  const f = await fixture();
  const store = new ConversationStore(f.runtime);
  cleanup(() => store.close());
  const held = Promise.withResolvers<void>();
  cleanup(() => held.resolve());
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const method = new URL(request.url).pathname.split("/").at(-1)!;
    const body = await request.json() as Record<string, unknown>;
    calls.push({ method, body });
    let result: unknown = true;
    if (method === "getMe") result = { id: 77, is_bot: true, first_name: "Piko", username: "piko_bot" };
    if (method === "getUpdates") {
      if (body.limit === 1) result = []; // grammY's stop-time confirmation must not block.
      else if (Number(body.offset) <= 10) result = [{ update_id: 10, message: {
        message_id: 1, date: 1, chat: { id: 42, type: "private", first_name: "User" },
        from: { id: 42, is_bot: false, first_name: "User" }, text,
      } }];
      else { await held.promise; result = []; }
    }
    if (method === "sendMessage" || method === "sendRichMessage") result = { message_id: 3 };
    return Response.json({ ok: true, result });
  } });
  cleanup(() => server.stop(true));
  const sdk = new Bot("77:test", { client: { apiRoot: `http://127.0.0.1:${server.port}`, timeoutSeconds: 2 } });
  let failures = 0;
  const telegram = new TelegramBot({ token: "77:test", userId: "42" }, store, f.runtime, sdk, () => { failures++; });
  cleanup(async () => { await telegram.stopInput(); await telegram.close(); });
  return { ...f, store, sdk, telegram, calls, failures: () => failures };
}

const apiError = (code: number) => new GrammyError("test failure", {
  ok: false, error_code: code, description: "private API detail",
}, "getUpdates", {});

test("grammY owns webhook removal, polling cursor and stop-time confirmation", async () => {
  const f = await pollingFixture();
  await f.telegram.start();
  await waitUntil(() => f.calls.filter(call => call.method === "getUpdates").length >= 2);
  const polls = f.calls.filter(call => call.method === "getUpdates");
  expect(polls.slice(0, 2).map(call => call.body.offset)).toEqual([1, 11]);
  expect(polls[0]!.body.allowed_updates).toEqual(["message", "callback_query"]);
  const removal = f.calls.find(call => call.method === "deleteWebhook");
  expect(removal).toBeDefined();
  expect(removal!.body.drop_pending_updates).not.toBe(true);
  await f.telegram.stopInput();
  expect(f.sdk.isRunning()).toBe(false);
  expect(f.calls.some(call => call.method === "getUpdates" && call.body.limit === 1 && call.body.offset === 11)).toBe(true);
  expect(f.failures()).toBe(0);
});

test("grammY polling recovers after more than three consecutive network failures", async () => {
  const f = await pollingFixture();
  let attempts = 0;
  f.sdk.api.config.use(async (prev, method, payload, signal) => {
    if (method === "getUpdates" && ++attempts <= 4)
      throw new HttpError("simulated transport failure", new Error("private network detail"));
    return prev(method, payload, signal);
  });
  await f.telegram.start();
  // grammY waits about three seconds per failed poll; each progress wait has its own deadline.
  for (let target = 1; target <= 5; target++) await waitUntil(() => attempts >= target);
  await waitUntil(() => f.calls.some(call => call.method === "sendMessage"));
  expect(f.failures()).toBe(0);
  expect(f.sdk.isRunning()).toBe(true);
  await f.telegram.stopInput();
  expect(f.sdk.isRunning()).toBe(false);
}, 20_000);

test("a failed update is logged safely and does not stop subsequent polling", async () => {
  const f = await pollingFixture("Task");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  cleanup(() => warning.mockRestore());
  f.store.submit = async () => { throw new Error("private admission detail"); };
  await f.telegram.start();
  await waitUntil(() => f.calls.some(call => call.method === "getUpdates" && call.body.offset === 11));
  expect(warning.mock.calls.flat().join(" ")).toContain("Telegram update failed");
  expect(warning.mock.calls.flat().join(" ")).not.toContain("private admission detail");
  expect((await f.store.snapshot()).messages).toEqual([]);
  expect(f.failures()).toBe(0);
  expect(f.sdk.isRunning()).toBe(true);
});

for (const code of [401, 409]) {
  test(`fatal polling API ${code} invokes the service failure handler`, async () => {
    const f = await pollingFixture();
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    cleanup(() => warning.mockRestore());
    f.sdk.api.config.use(async (prev, method, payload, signal) => {
      if (method === "getUpdates") throw apiError(code);
      return prev(method, payload, signal);
    });
    await f.telegram.start();
    await waitUntil(() => f.failures() === 1);
    expect(f.sdk.isRunning()).toBe(false);
    expect(warning.mock.calls.flat().join(" ")).toContain(`API ${code}`);
    expect(warning.mock.calls.flat().join(" ")).not.toContain("private API detail");
  });
}

test("startup failure invokes the same service failure handler", async () => {
  const f = await pollingFixture();
  f.sdk.api.config.use(async (prev, method, payload, signal) => {
    if (method === "setMyCommands") throw apiError(401);
    return prev(method, payload, signal);
  });
  await f.telegram.start();
  expect(f.failures()).toBe(1);
  expect(f.sdk.isRunning()).toBe(false);
});

test("shutdown cancels startup without requesting a service restart", async () => {
  const f = await pollingFixture();
  const entered = Promise.withResolvers<void>();
  f.sdk.api.config.use(async (prev, method, payload, signal) => {
    if (method === "setMyCommands") {
      entered.resolve();
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) reject(new Error("cancelled"));
        else signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    }
    return prev(method, payload, signal);
  });
  const starting = f.telegram.start();
  await entered.promise;
  await f.telegram.stopInput();
  await starting;
  expect(f.failures()).toBe(0);
  expect(f.calls.some(call => call.method === "deleteWebhook" || call.method === "getUpdates")).toBe(false);
});
