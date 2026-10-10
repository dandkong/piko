import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Bot, GrammyError } from "grammy";
import { ChatRepository } from "../server/domain/chat-repository";
import { ConversationStore } from "../server/chat/conversations";
import { ChatRun } from "../server/chat/run";
import { defaultServerConfig } from "../server/config";
import { createApp } from "../server/app";
import type { ChatRuntime, ChatSession } from "../server/runtime/types";
import type { Message, StreamEvent } from "../shared/chat";
import { TelegramChannel, type TelegramMessage } from "../server/channels/telegram/channel";
import { TelegramBot } from "../server/channels/telegram/bot";
import { TelegramReply, deliverRun, splitReply, TELEGRAM_RICH_LIMIT, TELEGRAM_PLAIN_LIMIT } from "../server/channels/telegram/output";
import { isFormatError, telegramRequest, TelegramApi, type TelegramTransport } from "../server/channels/telegram/api";
import { waitUntil, fixture, repository, cleanup } from "./fixtures/durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class Session implements ChatSession {
  isStreaming = false;
  messages: Message[] = [];
  calls = 0;
  aborts = 0;
  private listeners = new Set<(event: StreamEvent) => void>();
  private finish?: () => void;
  subscribe(listener: (event: StreamEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async prompt(text: string, run?: { id: string }) {
    this.calls++; this.isStreaming = true;
    this.messages.push({ id: `u${this.calls}`, role: "user", content: text, createdAt: 1, runId: run?.id });
    this.emit({ type: "delta", text: "initial" });
    await new Promise<void>(resolve => { this.finish = resolve; });
    this.messages.push({ id: `a${this.calls}`, role: "assistant", content: "answer", createdAt: 2, runId: run?.id });
    this.isStreaming = false;
  }
  emit(event: StreamEvent) { for (const listener of this.listeners) listener(event); }
  async abort() { this.aborts++; this.finish?.(); }
  dispose() {}
}

class Transport implements TelegramTransport {
  messages = new Map<string, { text: string; rich: boolean }>();
  writes: { chatId: string; text: string; rich: boolean; replyTo?: string }[] = [];
  deleted: string[] = [];
  failure?: unknown;
  block?: Promise<void>;
  count = 0;
  async send(chatId: string, text: string, rich: boolean, replyTo?: string) {
    this.writes.push({ chatId, text, rich, replyTo });
    await this.block;
    if (this.failure) throw this.failure;
    const id = String(++this.count); this.messages.set(id, { text, rich }); return id;
  }
  async edit(_chatId: string, id: string, text: string, rich: boolean) {
    await this.block;
    if (this.failure) throw this.failure;
    this.messages.set(id, { text, rich });
  }
  async remove(_chatId: string, id: string) { this.deleted.push(id); this.messages.delete(id); }
  async typing() {}
}

const input = { botId: "77", chatId: "42", actorId: "42", messageId: "1" };
const message: TelegramMessage = { chatId: "42", actorId: "42", messageId: "1", chatType: "private", text: "from TG" };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "piko-tg-test-"));
  cleanups.push(() => {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  });
  const repo = new ChatRepository(join(root, "piko.sqlite"), root);
  cleanups.push(() => repo.close());
  const session = new Session();
  let historyReads = 0;
  const runtime: ChatRuntime = { isModelReady: async () => true, createSession: async () => session,
    readHistory: async () => {
      historyReads++;
      const runs = new Map<string, { message: string; text: string }>();
      for (const item of session.messages) {
        const entry = runs.get(item.runId!) ?? { message: "", text: "" };
        if (item.role === "user") entry.message = item.content; else entry.text += item.content;
        runs.set(item.runId!, entry);
      }
      return { messages: session.messages, runs };
    },
    describe: async () => ({ runtime: "pi-durable", models: [], profiles: {},
      skills: [{ name: "test-skill", description: "helpful", path: "secret-path", disableModelInvocation: false }],
      plugins: [{ name: "test-plugin", path: "secret-path", tools: ["test-tool"] }] }),
  };
  const store = new ConversationStore(runtime.createSession, defaultServerConfig(), repo, runtime.readHistory);
  cleanups.push(() => store.close());
  const api = new Transport();
  const channel = new TelegramChannel({ botId: "77", username: "piko_bot", userId: "42" }, store, runtime, api, 5);
  cleanups.push(async () => { channel.stopAccepting(); await store.close(); await channel.drain(100); });
  return { root, repo, session, runtime, store, api, channel, get historyReads() { return historyReads; } };
}

describe("Telegram shared main conversation", () => {
  test("unauthorized commands, groups, topics and business messages never read history or reserve inputs", async () => {
    const s = setup();
    let reads = 0;
    s.runtime.describe = async () => { reads++; throw new Error("must not read"); };
    for (const overrides of [{ actorId: "99", text: "/recent" }, { actorId: "99", text: "/skills" },
      { chatType: "group" }, { topic: true }, { business: true }]) await s.channel.handle({ ...message, ...overrides });
    expect(reads).toBe(0); expect(s.historyReads).toBe(0); expect(s.session.calls).toBe(0); expect(s.api.writes).toEqual([]);
    expect(s.repo.db.query("SELECT * FROM telegram_inputs").all()).toEqual([]);
  });

  test("TG input uses the RN main history, duplicate delivery executes once and cross-channel stop works", async () => {
    const s = setup();
    await s.channel.handle(message);
    await waitUntil(() => s.session.calls === 1);
    await s.channel.handle(message);
    expect(s.session.calls).toBe(1);
    const app = createApp({ config: defaultServerConfig(), runtime: s.runtime, conversations: s.store });
    const response = await app(new Request(`http://localhost/api/sessions/${s.store.main.sessionId}`));
    expect((await response.json()).messages[0].content).toBe("from TG");
    await s.channel.handle({ ...message, messageId: "2", text: "/stop" });
    await waitUntil(() => !s.session.isStreaming);
    expect(s.session.aborts).toBe(1);
    await waitUntil(() => [...s.api.messages.values()].some(item => item.text.includes("回复已停止")));
    expect(s.api.writes[0].chatId).toBe("42");
  });

  test("RN replies are not pushed to TG; native history can be queried and TG can stop RN", async () => {
    const s = setup(); const id = crypto.randomUUID();
    const run = await s.store.startRun(s.store.main.sessionId, id, "from RN");
    await waitUntil(() => s.session.calls === 1);
    expect(s.api.writes).toEqual([]);
    await s.channel.handle({ ...message, text: "/recent" });
    await waitUntil(() => s.api.writes.length > 0);
    expect(s.api.writes[0].text).toContain("from RN");
    await s.channel.handle({ ...message, text: "/stop", messageId: "2" });
    await waitUntil(() => !run.active);
    expect(run.snapshot.status).toBe("cancelled");
  });

  test("two-channel concurrent admission accepts one and remembers the busy rejection", async () => {
    const s = setup();
    const results = await Promise.allSettled([s.store.startRun(s.store.main.sessionId, crypto.randomUUID(), "RN"), s.store.startTelegram(input, "TG")]);
    const tg = results[1]; expect(tg.status).toBe("fulfilled");
    const tgResult = (tg as PromiseFulfilledResult<Awaited<ReturnType<typeof s.store.startTelegram>>>).value;
    expect((results[0].status === "fulfilled" ? 1 : 0) + (tgResult.disposition === "accepted" ? 1 : 0)).toBe(1);
    await waitUntil(() => s.session.calls === 1);
    const busyInput = { ...input, messageId: "busy" };
    expect((await s.store.startTelegram(busyInput, "later")).disposition).toBe("busy");
    await (await s.store.run(s.store.main.sessionId))!.cancel();
    await waitUntil(() => !s.session.isStreaming);
    expect(await s.store.startTelegram(busyInput, "later")).toMatchObject({ disposition: "busy", duplicate: true, runId: null });
    expect(s.session.calls).toBe(1);
  });

  test("accepted receipts survive restart, uncertain input is not replayed and no bodies are persisted", async () => {
    const s = setup(); const receipt = s.repo.admitTelegram(s.store.main.sessionId, input, "sensitive input", false, false);
    expect(receipt.disposition).toBe("accepted");
    s.repo.close();
    const reopened = new ChatRepository(join(s.root, "piko.sqlite"), s.root);
    cleanups.push(() => reopened.close());
    const restored = new ConversationStore(s.runtime.createSession, defaultServerConfig(), reopened, s.runtime.readHistory);
    cleanups.push(() => restored.close());
    const replay = await restored.startTelegram(input, "sensitive input");
    expect(replay).toMatchObject({ duplicate: true, runId: receipt.runId });
    expect(replay.run?.snapshot).toMatchObject({ status: "failed", errorCode: "interrupted", message: "" });
    expect(s.session.calls).toBe(0);
    await expect(restored.startTelegram(input, "changed")).rejects.toThrow("already used");
    expect(JSON.stringify(reopened.db.query("SELECT * FROM telegram_inputs").all())).not.toContain("sensitive input");
  });

  test("receipt failure rolls back its Run and invalid input remains rejected", async () => {
    const s = setup();
    s.repo.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON telegram_inputs BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;");
    await expect(s.store.startTelegram(input, "hello")).rejects.toThrow("receipt failed");
    expect(s.repo.latest(s.store.main.sessionId)).toBeUndefined();
    s.repo.db.exec("DROP TRIGGER reject_receipt");
    expect((await s.store.startTelegram(input, " ")).disposition).toBe("invalid");
    expect((await s.store.startTelegram(input, " ")).duplicate).toBe(true);
    expect(s.session.calls).toBe(0);
  });

  test("slow response delivery does not delay stop admission; commands/media do not become model input", async () => {
    const s = setup(); const gate = Promise.withResolvers<void>(); s.api.block = gate.promise;
    await s.channel.handle(message);
    await waitUntil(() => s.api.writes.length > 0);
    await s.channel.handle({ ...message, text: "/stop", messageId: "2" });
    expect(s.session.aborts).toBe(1);
    gate.resolve();
    for (const text of ["/skills", "/plugins", "/help", "/new", "/help@other_bot", undefined]) {
      await s.channel.handle({ ...message, text, messageId: String(Math.random()) });
    }
    await s.channel.drain(100);
    expect(s.session.calls).toBe(1);
    expect(s.api.writes.some(item => item.text.includes("test-skill"))).toBe(true);
    expect(s.api.writes.some(item => item.text.includes("secret-path"))).toBe(false);
  });

  test("replayed stop commands cannot cancel a later RN Run", async () => {
    const s = setup();
    const stop = { ...message, messageId: "stop", text: "/stop" };
    await s.channel.handle(stop);
    const run = await s.store.startRun(s.store.main.sessionId, crypto.randomUUID(), "later RN");
    await waitUntil(() => s.session.calls === 1);
    await s.channel.handle(stop);
    expect(run.active).toBe(true); expect(s.session.aborts).toBe(0);
    const freshStop = { ...stop, messageId: "fresh-stop" };
    await s.channel.handle(freshStop);
    await waitUntil(() => !run.active);
    const next = await s.store.startRun(s.store.main.sessionId, crypto.randomUUID(), "next RN");
    await waitUntil(() => s.session.calls === 2);
    await s.channel.handle(freshStop);
    expect(next.active).toBe(true); expect(s.session.aborts).toBe(1);
  });
});

describe("Telegram rendering and network errors", () => {
  const error = (code: number, description: string, retry_after?: number) => new GrammyError("failure", {
    ok: false, error_code: code, description, parameters: retry_after === undefined ? {} : { retry_after },
  }, "sendMessage", {});

  test("long code/Unicode responses respect limits and replacement removes stale segments", async () => {
    const text = "```ts\n" + "😀code\n".repeat(9000) + "```\nend";
    const chunks = splitReply(text, TELEGRAM_RICH_LIMIT);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_RICH_LIMIT);
      expect(chunk).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    const api = new Transport(); const reply = new TelegramReply(api, "42", "1");
    await reply.update(text); expect(api.messages.size).toBe(chunks.length);
    await reply.update("corrected", true);
    expect(api.messages.size).toBe(1); expect(api.deleted.length).toBe(chunks.length - 1);
    expect([...api.messages.values()]).toEqual([{ text: "corrected", rich: true }]);
    await reply.update(""); expect(api.messages.size).toBe(0);
  });

  test("rich replies stream as one large message while explicit plain output preserves literal text", async () => {
    const body = "## Heading\n\n| Name | Value |\n| --- | --- |\n| Piko | Rich |\n\n" + "正文😀\n".repeat(1300);
    const api = new Transport(); const reply = new TelegramReply(api, "42", "1");
    await reply.update(body);
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]).toMatchObject({ rich: true, replyTo: "1" });
    expect(api.messages.get("1")?.text).toContain("| Piko | Rich |");
    await reply.update(body, true);
    expect(api.messages.get("1")).toEqual({ text: body, rich: true });
    const literal = "```unfinished\n**do not format**\n" + "output😀\n".repeat(1000);
    const plain = new Transport();
    await new TelegramReply(plain, "42", "1", "plain").update(literal);
    expect(plain.writes.length).toBeGreaterThan(1);
    expect(plain.writes.every(item => !item.rich && item.text.length <= TELEGRAM_PLAIN_LIMIT)).toBe(true);
    expect(plain.writes.map(item => item.text).join("")).toBe(literal);
    expect(plain.writes[0].replyTo).toBe("1");
    expect(plain.writes.slice(1).every(item => item.replyTo === undefined)).toBe(true);
  });

  test("SDK sends and edits Rich Markdown from the first partial reply and finalizes raw output", async () => {
    const calls: { method: string; body: Record<string, any> }[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      calls.push({ method: new URL(request.url).pathname.split("/").at(-1)!, body: await request.json() });
      return Response.json({ ok: true, result: { message_id: 3 } });
    } });
    cleanups.push(() => server.stop(true));
    const api = new TelegramApi(new Bot("77:test", { client: { apiRoot: `http://127.0.0.1:${server.port}` } }));
    cleanups.push(() => api.controller.abort());
    const reply = new TelegramReply(api, "42", "1");
    await reply.update("## Heading\n\n**partial");
    expect(calls[0]).toMatchObject({ method: "sendRichMessage", body: {
      chat_id: "42", rich_message: { markdown: "## Heading\n\n**partial**" }, reply_parameters: { message_id: 1 },
    } });
    const partial = "**partial** [reference](https://exa";
    await reply.update(partial);
    expect(calls[1]).toMatchObject({ method: "editMessageText", body: { message_id: 3, rich_message: { markdown: "**partial** reference" } } });
    expect(calls[1].body).not.toHaveProperty("text");
    await reply.update(partial, true);
    expect(calls[2]).toMatchObject({ method: "editMessageText", body: { rich_message: { markdown: partial } } });
    const count = calls.length;
    await reply.update(partial, true); expect(calls).toHaveLength(count);
    await new TelegramReply(api, "42", undefined, "plain").update("**literal** $5", true);
    expect(calls.at(-1)).toMatchObject({ method: "sendMessage", body: { text: "**literal** $5" } });
    expect(calls.every(call => !call.method.includes("Draft"))).toBe(true);
  });

  test("a rejected rich segment re-splits all output safely and stays plain for later updates", async () => {
    const api = new Transport(); const send = api.send.bind(api); let richCalls = 0;
    api.send = async (...args) => {
      if (args[2] && ++richCalls === 2) throw error(400, "can't parse entities");
      return send(...args);
    };
    const text = "line **raw** 😀\n".repeat(2500);
    const reply = new TelegramReply(api, "42", "1");
    await reply.update(text);
    const delivered = [...api.messages.values()];
    expect(richCalls).toBe(2);
    expect(delivered.length).toBeGreaterThan(2);
    expect(delivered.every(item => !item.rich && item.text.length <= TELEGRAM_PLAIN_LIMIT)).toBe(true);
    expect(delivered.map(item => item.text).join("")).toBe(text);
    await reply.update("**shorter**", true);
    expect([...api.messages.values()]).toEqual([{ text: "**shorter**", rich: false }]);
    expect(api.deleted.length).toBe(delivered.length - 1);
    expect(richCalls).toBe(2);
  });

  test("only explicit formatting failures downgrade; 429 respects cooldown and auth never retries", async () => {
    expect(isFormatError(error(400, "can't parse entities"))).toBe(true);
    expect(isFormatError(error(429, "Too Many Requests"))).toBe(false);
    const waits: number[] = []; let calls = 0;
    expect(await telegramRequest(async () => { if (++calls === 1) throw error(429, "rate limited", 2); return "ok"; },
      new AbortController().signal, async ms => { waits.push(ms); })).toBe("ok");
    expect(waits).toEqual([2000]);
    calls = 0;
    await expect(telegramRequest(async () => { calls++; throw error(401, "Unauthorized"); }, new AbortController().signal)).rejects.toThrow();
    expect(calls).toBe(1);
    const api = new Transport(); const original = api.send.bind(api);
    api.send = async (...args) => { if (args[2]) throw error(400, "can't parse entities"); return original(...args); };
    await new TelegramReply(api, "42").update("**hello**", true);
    expect([...api.messages.values()][0].rich).toBe(false);
    api.send = async () => { throw error(429, "rate limited"); };
    await expect(new TelegramReply(api, "42").update("hello", true)).rejects.toThrow();
  });

  test("Run replace is rendered and sending failure never changes successful execution", async () => {
    const s = setup(); const run = await s.store.startRun(s.store.main.sessionId, crypto.randomUUID(), "hello");
    await waitUntil(() => s.session.calls === 1);
    const signal = new AbortController();
    const delivery = deliverRun(run, new TelegramReply(s.api, "42"), s.api, "42", signal.signal, 5);
    const delivered = delivery.catch(error => error);
    await waitUntil(() => s.api.messages.size > 0);
    s.session.emit({ type: "replace", text: "replacement" });
    await waitUntil(() => [...s.api.messages.values()][0]?.text === "replacement");
    s.api.failure = error(403, "Forbidden");
    s.session.emit({ type: "replace", text: "final correction" });
    // Finish normally by resolving the held tool/model work without invoking Run.cancel.
    await s.session.abort();
    expect(await delivered).toBeInstanceOf(GrammyError);
    expect(run.snapshot.status).toBe("succeeded");
  });
});

test("poller checks webhook and advances confirmation only after successful durable admission", async () => {
  const s = setup(); const offsets: number[] = []; const methods: string[] = [];
  let webhook = false;
  const held = Promise.withResolvers<void>();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const method = new URL(request.url).pathname.split("/").at(-1)!; methods.push(method);
    const body = await request.json();
    let result: unknown = true;
    if (method === "getMe") result = { id: 77, is_bot: true, first_name: "Piko", username: "piko_bot" };
    if (method === "getWebhookInfo") result = { url: webhook ? "https://example.invalid/hook" : "", has_custom_certificate: false, pending_update_count: 0 };
    if (method === "getUpdates") {
      offsets.push(body.offset);
      if (body.offset === 0) result = [{ update_id: 10, message: { message_id: 1, date: 1,
        chat: { id: 42, type: "private", first_name: "User" }, from: { id: 42, is_bot: false, first_name: "User" }, text: "from TG" } }];
      else { await held.promise; result = []; }
    }
    if (method === "sendMessage" || method === "sendRichMessage") result = { message_id: 3 };
    return Response.json({ ok: true, result });
  } });
  cleanups.push(() => { held.resolve(); server.stop(true); });
  const config = { token: "77:test", userId: "42" };
  const make = () => new TelegramBot(config, s.store, s.runtime, new Bot(config.token,
    { client: { apiRoot: `http://127.0.0.1:${server.port}`, timeoutSeconds: 2 } }));
  webhook = true; const refused = make(); await refused.start(); await refused.stopInput(); await refused.close();
  expect(methods).not.toContain("deleteWebhook"); expect(offsets).toEqual([]);
  webhook = false; const bot = make();
  cleanups.push(async () => { await bot.stopInput(); await bot.close(); });
  await bot.start(); await waitUntil(() => offsets.length >= 2);
  expect(offsets.slice(0, 2)).toEqual([0, 11]); expect(s.session.calls).toBe(1);
  await bot.stopInput(); await (await s.store.run(s.store.main.sessionId))?.cancel(); await bot.close();
  expect(methods).not.toContain("deleteWebhook");
  const failing = setup();
  failing.repo.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON telegram_inputs BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;");
  const failed = new TelegramBot(config, failing.store, failing.runtime, new Bot(config.token,
    { client: { apiRoot: `http://127.0.0.1:${server.port}`, timeoutSeconds: 2 } }));
  const before = offsets.length;
  await failed.start();
  await waitUntil(() => offsets.length > before);
  // Waiting for stopInput also waits for in-flight admission, without confirming the attempted update.
  await Bun.sleep(20); await failed.stopInput(); await failed.close();
  expect(offsets.slice(before)).toEqual([0]);
  expect(failing.session.calls).toBe(0); expect(failing.repo.latest(failing.store.main.sessionId)).toBeUndefined();
});

test("Telegram and RN share one native durable conversation and model context", async () => {
  const f = await fixture(); const repo = repository(f.paths);
  const store = new ConversationStore(f.runtime.createSession, defaultServerConfig(), repo, f.runtime.readHistory);
  cleanup(() => store.close());
  const api = new Transport();
  const channel = new TelegramChannel({ botId: "77", username: "piko_bot", userId: "42" }, store, f.runtime, api, 5);
  cleanup(async () => { channel.stopAccepting(); await store.close(); await channel.drain(100); });
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("**TG reply**"), fauxAssistantMessage("RN reply")]);
  await channel.handle(message);
  await waitUntil(async () => (await store.run(store.main.sessionId))?.snapshot.status === "succeeded");
  await waitUntil(() => [...api.messages.values()].some(item => item.text === "**TG reply**" && item.rich));
  const writes = api.writes.length;
  const rn = await store.startRun(store.main.sessionId, crypto.randomUUID(), "continue from RN");
  await waitUntil(() => !rn.active);
  const history = await store.history(store.main.sessionId);
  expect(history.map(item => item.content)).toEqual(["from TG", "**TG reply**", "continue from RN", "RN reply"]);
  expect(f.faux.state.callCount).toBe(3);
  await channel.drain(100);
  expect(api.writes.length).toBe(writes);
  expect([...api.messages.values()].map(item => item.text).join("\n")).toContain("TG reply");
  expect(api.writes.every(item => !item.text.includes("助手指导") && !item.text.includes("AGENTS.md"))).toBe(true);
});
