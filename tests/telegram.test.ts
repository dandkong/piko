import { messageEvent } from "./fixtures/messages";
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
import type { ChatRuntime, ChatSession, SessionEvent } from "../server/runtime/types";
import type { Message, StreamEvent } from "../shared/chat";
import type { CompactionResult, RuntimeDescription, RuntimeSelection } from "../shared/runtime";
import type { TelegramCallback } from "../server/channels/telegram/menus";
import { TELEGRAM_COMMANDS, TelegramChannel, type TelegramMessage } from "../server/channels/telegram/channel";
import { TelegramBot } from "../server/channels/telegram/bot";
import { TelegramReply, TelegramMessageOutput, deliverRun, splitReply, TELEGRAM_RICH_LIMIT, TELEGRAM_PLAIN_LIMIT } from "../server/channels/telegram/output";
import { isFormatError, telegramRequest, TelegramApi, type TelegramTransport, type TelegramKeyboard } from "../server/channels/telegram/api";
import { waitUntil, fixture, repository, cleanup } from "./fixtures/durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class Session implements ChatSession {
  isStreaming = false;
  messages: Message[] = [];
  calls = 0;
  aborts = 0;
  private listeners = new Set<(event: SessionEvent) => void>();
  private finishes: (() => void)[] = [];
  subscribe(listener: (event: SessionEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async prompt(text: string, run?: { id: string }) {
    this.calls++; this.isStreaming = true;
    this.messages.push({ id: `u${this.calls}`, role: "user", content: text, createdAt: 1, runId: run?.id });
    this.emit(messageEvent("initial"));
    await new Promise<void>(resolve => { this.finishes.push(resolve); });
    this.messages.push({ id: `a${this.calls}`, role: "assistant", content: "answer", createdAt: 2, runId: run?.id });
    this.isStreaming = false;
  }
  emit(event: SessionEvent) { for (const listener of this.listeners) listener(event); }
  async abort() { this.aborts++; for (const finish of this.finishes.splice(0)) finish(); }
  dispose() {}
}

class Transport implements TelegramTransport {
  messages = new Map<string, { text: string; rich: boolean }>();
  writes: { chatId: string; text: string; rich: boolean }[] = [];
  deleted: string[] = [];
  buttons = new Map<string, TelegramKeyboard>();
  answers: { id: string; text?: string; alert?: boolean }[] = [];
  failure?: unknown;
  block?: Promise<void>;
  count = 0;
  async send(chatId: string, text: string, rich: boolean, buttons?: TelegramKeyboard) {
    this.writes.push({ chatId, text, rich });
    await this.block;
    if (this.failure) throw this.failure;
    const id = String(++this.count); this.messages.set(id, { text, rich });
    if (buttons !== undefined) this.buttons.set(id, buttons);
    return id;
  }
  async edit(_chatId: string, id: string, text: string, rich: boolean, buttons?: TelegramKeyboard) {
    await this.block;
    if (this.failure) throw this.failure;
    this.messages.set(id, { text, rich });
    if (buttons !== undefined) this.buttons.set(id, buttons);
  }
  async answerCallback(id: string, text?: string, alert?: boolean) { this.answers.push({ id, text, alert }); }
  async remove(_chatId: string, id: string) { this.deleted.push(id); this.messages.delete(id); }
  async typing() {}
}

const input = { botId: "77", chatId: "42", actorId: "42", messageId: "1" };
const message: TelegramMessage = { chatId: "42", actorId: "42", messageId: "1", chatType: "private", text: "from TG" };

function controls(s: ReturnType<typeof setup>) {
  let description: RuntimeDescription = { runtime: "pi-durable", selection: { provider: "alpha", model: "fast", thinking: "off" },
    models: [
      { provider: "alpha", id: "fast", name: "Fast", imageInput: false, contextWindow: 250_000, thinkingLevels: ["off"] },
      { provider: "alpha", id: "reasoning", name: "Reasoning", imageInput: false, thinkingLevels: ["off", "low", "medium", "high"] },
      { provider: "beta", id: "other", name: "Other", imageInput: false, thinkingLevels: ["off", "low"] },
    ], profiles: {}, skills: [], plugins: [] };
  const changes: RuntimeSelection[] = [];
  s.runtime.describe = async () => structuredClone(description);
  s.runtime.configure = async (_input, selection) => {
    changes.push(selection);
    if ("provider" in selection) {
      const model = description.models.find(model => model.provider === selection.provider && model.id === selection.model)!;
      const previous = description.selection?.thinking ?? "off";
      description.selection = { ...selection, thinking: selection.thinking ?? (model.thinkingLevels.includes(previous) ? previous : "off") };
    }
    else if ("thinking" in selection) description.selection = { ...description.selection!, thinking: selection.thinking };
  };
  return { changes, get description() { return description; }, set description(value) { description = value; } };
}

let callbackSequence = 0;
async function click(s: ReturnType<typeof setup>, messageId: string, label: string, overrides: Partial<TelegramCallback> = {}) {
  const button = s.api.buttons.get(messageId)!.flat().find(button => button.text.startsWith(label))!;
  expect(button).toBeDefined();
  const callbackId = `callback-${++callbackSequence}`;
  s.channel.handleCallback({ ...message, messageId, callbackId, data: button.callbackData, ...overrides });
  if (!overrides.actorId && !overrides.chatType && !overrides.topic && !overrides.business)
    await waitUntil(() => s.api.answers.some(answer => answer.id === callbackId));
  return callbackId;
}

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
      const runs = new Map<string, { message: string }>();
      for (const item of session.messages) {
        const entry = runs.get(item.runId!) ?? { message: "" };
        if (item.role === "user") entry.message = item.content;
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
    await waitUntil(() => [...s.api.messages.values()].some(item => item.text.includes("Reply stopped.")));
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

  test("two-channel concurrent inputs use distinct submission identities in one conversation", async () => {
    const s = setup();
    const results = await Promise.allSettled([s.store.startRun(s.store.main.sessionId, crypto.randomUUID(), "RN"), s.store.startTelegram(input, "TG")]);
    const tg = results[1]; expect(tg.status).toBe("fulfilled");
    const tgResult = (tg as PromiseFulfilledResult<Awaited<ReturnType<typeof s.store.startTelegram>>>).value;
    expect(results[0].status).toBe("fulfilled"); expect(tgResult.disposition).toBe("accepted");
    const rn = (results[0] as PromiseFulfilledResult<ChatRun>).value;
    expect(tgResult.run!.snapshot.id).not.toBe(rn.snapshot.id);
    await waitUntil(() => s.session.calls === 2);
    const busyInput = { ...input, messageId: "busy" };
    const added = await s.store.startTelegram(busyInput, "later");
    expect(added.disposition).toBe("accepted");
    await waitUntil(() => s.session.calls === 3);
    await (await s.store.run(s.store.main.sessionId))!.cancel();
    await waitUntil(() => !s.session.isStreaming);
    expect(await s.store.startTelegram(busyInput, "later")).toMatchObject({ disposition: "accepted", duplicate: true, runId: added.runId });
    expect(s.session.calls).toBe(3);
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
    const api = new Transport(); const reply = new TelegramReply(api, "42");
    await reply.update(text); expect(api.messages.size).toBe(chunks.length);
    await reply.update("corrected", true);
    expect(api.messages.size).toBe(1); expect(api.deleted.length).toBe(chunks.length - 1);
    expect([...api.messages.values()]).toEqual([{ text: "corrected", rich: true }]);
    await reply.update(""); expect(api.messages.size).toBe(0);
  });

  test("rich replies stream as one large message while explicit plain output preserves literal text", async () => {
    const body = "## Heading\n\n| Name | Value |\n| --- | --- |\n| Piko | Rich |\n\n" + "正文😀\n".repeat(1300);
    const api = new Transport(); const reply = new TelegramReply(api, "42");
    await reply.update(body);
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]).toMatchObject({ chatId: "42", rich: true });
    expect(api.messages.get("1")?.text).toContain("| Piko | Rich |");
    await reply.update(body, true);
    expect(api.messages.get("1")).toEqual({ text: body, rich: true });
    const literal = "```unfinished\n**do not format**\n" + "output😀\n".repeat(1000);
    const plain = new Transport();
    await new TelegramReply(plain, "42", "plain").update(literal);
    expect(plain.writes.length).toBeGreaterThan(1);
    expect(plain.writes.every(item => !item.rich && item.text.length <= TELEGRAM_PLAIN_LIMIT)).toBe(true);
    expect(plain.writes.map(item => item.text).join("")).toBe(literal);
    expect(plain.writes.every(item => item.chatId === "42")).toBe(true);
  });

  test("message boundaries finalize each reply; retries shrink only the current message and preserve earlier output", async () => {
    const s = setup();
    const run = await s.store.startRun(s.store.main.sessionId, crypto.randomUUID(), "multiple replies");
    await waitUntil(() => s.session.calls === 1);
    const events: StreamEvent[] = []; run.subscribe(0, event => events.push(event));
    const signal = new AbortController();
    const delivery = deliverRun(run, new TelegramReply(s.api, "42"), s.api, "42", signal.signal, 5);
    cleanups.push(async () => { signal.abort(); await delivery.catch(() => {}); });
    const first = "**Checking";
    s.session.emit(messageEvent(first));
    await waitUntil(() => s.api.messages.get("1")?.text === "**Checking**");
    s.session.emit(messageEvent(first, "live-test", true));
    await waitUntil(() => s.api.messages.get("1")?.text === first);
    const sequence = run.snapshot.lastEventId;
    s.session.emit(messageEvent(first, "live-test", true)); // tool-only/duplicate completion
    expect(run.snapshot.lastEventId).toBe(sequence + 1);
    s.session.emit(messageEvent("```ts\n" + "line\n".repeat(7000), "second"));
    await waitUntil(() => s.api.messages.size > 2);
    expect(s.api.messages.get("1")?.text).toBe(first);
    const second = "**Working";
    let rejected = false;
    const edit = s.api.edit.bind(s.api);
    s.api.edit = async (...args) => {
      if (args[1] === "2" && !rejected) { rejected = true; throw error(500, "temporary failure"); }
      return edit(...args);
    };
    s.session.emit(messageEvent(second, "second"));
    await waitUntil(() => rejected);
    s.session.emit(messageEvent(second, "second"));
    await waitUntil(() => s.api.messages.size === 2 && s.api.messages.get("2")?.text === "**Working**");
    expect(rejected).toBe(true); expect(s.api.deleted.length).toBeGreaterThan(0);
    s.session.emit(messageEvent(second, "second", true));
    await waitUntil(() => s.api.messages.get("2")?.text === second);
    s.session.emit(messageEvent("Done.", "third"));
    s.session.emit(messageEvent("Done.", "third", true));
    await s.session.abort(); await delivery;
    expect([...s.api.messages.values()].map(item => item.text)).toEqual([first, second, "Done."]);
    expect(run.outputs.map(event => event.message.content)).toEqual([first, second, "Done."]);
    expect(events.map(event => event.type)).not.toContain("message_end");
    expect(s.api.writes).toHaveLength(4); // first, two long chunks, then third native reply
  });

  test("a late delivery preserves coalesced message boundaries and reports cancellation on the unfinished reply", async () => {
    const s = setup();
    const run = await s.store.startRun(s.store.main.sessionId, crypto.randomUUID(), "multiple replies");
    await waitUntil(() => s.session.calls === 1);
    s.session.emit(messageEvent("First."));
    s.session.emit(messageEvent("First.", "live-test", true));
    s.session.emit(messageEvent("Second.", "second"));
    s.session.emit(messageEvent("Second.", "second", true));
    s.session.emit(messageEvent("Unfinished", "third"));
    await run.cancel();
    const api = new Transport();
    await deliverRun(run, new TelegramReply(api, "42"), api, "42", new AbortController().signal, 5);
    expect([...api.messages.values()].map(item => item.text)).toEqual(["First.", "Second.", "Unfinished\n\nReply stopped."]);
    expect(api.writes).toHaveLength(3);
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
    const reply = new TelegramReply(api, "42");
    await reply.update("## Heading\n\n**partial");
    expect(calls[0]).toMatchObject({ method: "sendRichMessage", body: {
      chat_id: "42", rich_message: { markdown: "## Heading\n\n**partial**" },
    } });
    const partial = "**partial** [reference](https://exa";
    await reply.update(partial);
    expect(calls[1]).toMatchObject({ method: "editMessageText", body: { message_id: 3, rich_message: { markdown: "**partial** reference" } } });
    expect(calls[1].body).not.toHaveProperty("text");
    await reply.update(partial, true);
    expect(calls[2]).toMatchObject({ method: "editMessageText", body: { rich_message: { markdown: partial } } });
    const count = calls.length;
    await reply.update(partial, true); expect(calls).toHaveLength(count);
    await new TelegramReply(api, "42", "plain").update("**literal** $5", true);
    expect(calls.at(-1)).toMatchObject({ method: "sendMessage", body: { text: "**literal** $5" } });
    expect(calls.every(call => !call.method.includes("Draft"))).toBe(true);
    expect(calls.every(call => !Object.hasOwn(call.body, "reply_parameters"))).toBe(true);
  });

  test("a rejected rich segment re-splits all output safely and stays plain for later updates", async () => {
    const api = new Transport(); const send = api.send.bind(api); let richCalls = 0;
    api.send = async (...args) => {
      if (args[2] && ++richCalls === 2) throw error(400, "can't parse entities");
      return send(...args);
    };
    const text = "line **raw** 😀\n".repeat(2500);
    const reply = new TelegramReply(api, "42");
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

  test("Message corrections are rendered and sending failure never changes successful execution", async () => {
    const s = setup(); const run = await s.store.startRun(s.store.main.sessionId, crypto.randomUUID(), "hello");
    await waitUntil(() => s.session.calls === 1);
    const signal = new AbortController();
    const delivery = deliverRun(run, new TelegramReply(s.api, "42"), s.api, "42", signal.signal, 5);
    const delivered = delivery.catch(error => error);
    await waitUntil(() => s.api.messages.size > 0);
    s.session.emit(messageEvent("replacement"));
    await waitUntil(() => [...s.api.messages.values()][0]?.text === "replacement");
    s.api.failure = error(403, "Forbidden");
    s.session.emit(messageEvent("final correction"));
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

test("Telegram observes independent messages once while multiple steers join the native conversation", async () => {
  const f = await fixture(); const repo = repository(f.paths);
  const store = new ConversationStore(f.runtime.createSession, defaultServerConfig(), repo, f.runtime.readHistory);
  cleanup(() => store.close());
  const api = new Transport();
  const channel = new TelegramChannel({ botId: "77", username: "piko_bot", userId: "42" }, store, f.runtime, api, 20);
  cleanup(async () => { channel.stopAccepting(); await store.close(); await channel.drain(); });
  const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  let received = "";
  f.faux.setResponses([
    async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage([
      { type: "text", text: "First." }, fauxToolCall("read", { path: "MEMORY.md" }),
    ], { stopReason: "toolUse" }); },
    context => { received = JSON.stringify(context.messages); return fauxAssistantMessage("Final."); },
  ]);
  await channel.handle(message); await entered.promise;
  await channel.handle({ ...message, messageId: "2", text: "TG correction" });
  const rn = await store.startRun(store.main.sessionId, crypto.randomUUID(), "RN supplement");
  const latest = await store.run(store.main.sessionId);
  expect(latest!.snapshot.id).toBe(rn.snapshot.id);
  await waitUntil(() => repo.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runs WHERE status='running'").get()!.count === 3);
  // Let the serialized native admissions catch up before releasing the model request.
  const session = await f.runtime.createSession(store.context()) as import("../server/runtime/pi").DurableChatSession;
  const context = (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT;
  await waitUntil(async () => (await session.nativeHarness.commit(tx => tx.submissionByRequest(session.native.id, rn.snapshot.id), context))?.status === "queued");
  gate.resolve(); await waitUntil(() => !rn.active); await channel.drain();
  expect(received).toContain("TG correction"); expect(received).toContain("RN supplement");
  expect(f.faux.state.callCount).toBe(2);
  expect([...api.messages.values()].map(item => item.text)).toEqual(["First.", "Final."]);
  expect((await store.history(store.main.sessionId)).filter(item => item.role === "user").map(item => item.content)).toEqual(["from TG", "TG correction", "RN supplement"]);
});

test("TG joins RN work without replaying completed replies and subsequent replies stay separate", async () => {
  const f = await fixture(); const repo = repository(f.paths);
  const store = new ConversationStore(f.runtime.createSession, defaultServerConfig(), repo, f.runtime.readHistory);
  cleanup(() => store.close());
  const api = new Transport();
  const channel = new TelegramChannel({ botId: "77", username: "piko_bot", userId: "42" }, store, f.runtime, api, 10);
  cleanup(async () => { channel.stopAccepting(); await store.close(); await channel.drain(); });
  const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); cleanup(() => gate.resolve());
  f.faux.setResponses([
    fauxAssistantMessage([{ type: "text", text: "Before." }, fauxToolCall("read", { path: "MEMORY.md" })], { stopReason: "toolUse" }),
    async () => { entered.resolve(); await gate.promise; return fauxAssistantMessage("After."); },
    fauxAssistantMessage("Final."),
  ]);
  const root = await store.startRun(store.main.sessionId, crypto.randomUUID(), "RN request");
  await entered.promise;
  await waitUntil(() => root.outputs.some(event => event.final && event.message.content === "Before."));
  expect(api.writes).toEqual([]);
  await channel.handle(message);
  const added = (await store.run(store.main.sessionId))!;
  const session = await f.runtime.createSession(store.context()) as import("../server/runtime/pi").DurableChatSession;
  const ctx = (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT;
  await waitUntil(async () => (await session.nativeHarness.commit(tx => tx.submissionByRequest(session.native.id, added.snapshot.id), ctx))?.status === "queued");
  expect(added.outputs).toEqual([]);
  expect((await store.history(store.main.sessionId)).map(message => message.content)).toContain("Before.");
  gate.resolve(); await waitUntil(() => !added.active); await channel.drain();
  expect([...api.messages.values()].map(message => message.text)).toEqual(["After.", "Final."]);
  expect((await store.history(store.main.sessionId)).filter(message => message.role === "assistant").map(message => message.content))
    .toEqual(["Before.", "After.", "Final."]);
});

test("a slower output observer cannot revive a committed live alias or send a duplicate reply", async () => {
  const api = new Transport(); const output = new TelegramMessageOutput(api, "42");
  await output.update(messageEvent("partial"));
  await output.update(messageEvent("Final.", "pi-1", true, "live-test"));
  await output.update(messageEvent("outdated partial"));
  await output.update(messageEvent("Final.", "pi-1", true, "live-test"));
  await output.update(messageEvent("Next.", "pi-2", true));
  expect([...api.messages.values()].map(message => message.text)).toEqual(["Final.", "Next."]);
  expect(api.writes).toHaveLength(2);
});

test("Telegram delivers native assistant entries separately, skips tool-only replies, and matches RN history", async () => {
  const f = await fixture(); const repo = repository(f.paths);
  const store = new ConversationStore(f.runtime.createSession, defaultServerConfig(), repo, f.runtime.readHistory);
  cleanup(() => store.close());
  const api = new Transport();
  const channel = new TelegramChannel({ botId: "77", username: "piko_bot", userId: "42" }, store, f.runtime, api, 800);
  cleanup(async () => { channel.stopAccepting(); await store.close(); await channel.drain(); });
  const read = () => fauxToolCall("read", { path: "AGENTS.md" });
  f.faux.setResponses([
    fauxAssistantMessage([{ type: "text", text: "**First reply.**" }, read()], { stopReason: "toolUse" }),
    fauxAssistantMessage(read(), { stopReason: "toolUse" }),
    fauxAssistantMessage([{ type: "text", text: "Second reply." }, read()], { stopReason: "toolUse" }),
    fauxAssistantMessage("Third reply."),
  ]);
  await channel.handle(message);
  await waitUntil(async () => (await store.run(store.main.sessionId))?.snapshot.status === "succeeded");
  await channel.drain();
  const history = await store.history(store.main.sessionId);
  const expected = ["**First reply.**", "Second reply.", "Third reply."];
  expect(history.filter(item => item.role === "assistant").map(item => item.content)).toEqual(expected);
  expect([...api.messages.values()].map(item => item.text)).toEqual(expected);
  expect(api.messages.size).toBe(3); expect(f.faux.state.callCount).toBe(4);
  expect(api.writes.every(item => item.rich)).toBe(true);
  expect([...api.messages.values()].every(item => !item.text.includes("AGENTS.md"))).toBe(true);
});

describe("Telegram runtime controls", () => {
  test("compact distinguishes skipped, stale and cancelled results even if optional status cannot be read", async () => {
    const s = setup();
    s.runtime.describe = async () => { throw new Error("metadata unavailable"); };
    const results: [CompactionResult, string][] = [
      [{ status: "skipped", reason: "no_summary" }, "Context unchanged. No summary created."],
      [{ status: "skipped", reason: "stale" }, "Context changed. The summary wasn't applied."],
      [{ status: "cancelled" }, "Compaction stopped."],
      [{ status: "compacted" }, "Context compacted."],
    ];
    for (const [result, expected] of results) {
      const previous = s.api.writes.length;
      s.runtime.compact = async () => result;
      await s.channel.handle({ ...message, text: "/compact" });
      await waitUntil(() => s.api.writes.slice(previous).some(write => write.text.includes(expected)));
      expect(s.api.writes.slice(previous).some(write => write.text.includes("Couldn't complete"))).toBe(false);
      if (result.status !== "compacted") expect(s.api.writes.slice(previous).some(write => write.text.includes("Context compacted."))).toBe(false);
    }
  });

  test("provider/model menus and thinking buttons match pilot layout and update shared selection", async () => {
    const s = setup(); const c = controls(s);
    await s.channel.handle({ ...message, text: "/models" });
    await waitUntil(() => s.api.buttons.has("1"));
    expect(s.api.buttons.get("1")!.map(row => row.map(button => button.text))).toEqual([["alpha (2)", "beta (1)"]]);
    await click(s, "1", "alpha");
    await waitUntil(() => s.api.buttons.get("1")![0][0].text === "Fast ✓");
    expect(s.api.buttons.get("1")!.map(row => row.length)).toEqual([2, 1]);
    [c.description.models[0], c.description.models[1]] = [c.description.models[1], c.description.models[0]];
    await click(s, "1", "Reasoning");
    await waitUntil(() => s.api.buttons.has("2"));
    expect(c.changes).toEqual([{ provider: "alpha", model: "reasoning" }]);
    expect(s.api.buttons.get("2")!.map(row => row.length)).toEqual([3, 1]);
    await click(s, "2", "high");
    await waitUntil(() => s.api.buttons.get("2")!.flat().some(button => button.text === "high ✓"));
    const app = createApp({ config: defaultServerConfig(), runtime: s.runtime, conversations: s.store });
    const state = await (await app(new Request("http://localhost/api/runtime"))).json();
    expect(state.selection).toEqual({ provider: "alpha", model: "reasoning", thinking: "high" });
    await click(s, "1", "Back to providers");
    await waitUntil(() => s.api.buttons.get("1")![0][0].text === "alpha (2)");
    await click(s, "1", "alpha");
    await waitUntil(() => s.api.buttons.get("1")!.flat().some(button => button.text === "Fast"));
    await click(s, "1", "Fast");
    await waitUntil(() => s.api.messages.get("1")!.text.includes("alpha/fast"));
    expect(c.description.selection!.thinking).toBe("off");
    expect(s.session.calls).toBe(0); expect(s.repo.latest(s.store.main.sessionId)).toBeUndefined();
    expect(await s.store.history(s.store.main.sessionId)).toEqual([]);
  });

  test("long identifiers use bounded callback data and catalog reordering cannot change menu targets", async () => {
    const s = setup(); const c = controls(s);
    c.description.models[0].provider = "供应商".repeat(40); c.description.models[0].id = "long-id-".repeat(40);
    await s.channel.handle({ ...message, text: "/models" });
    await waitUntil(() => s.api.buttons.has("1"));
    await click(s, "1", "供应商");
    await waitUntil(() => s.api.buttons.get("1")!.flat().some(button => button.text === "Fast"));
    c.description.models.reverse();
    const target = c.description.models.at(-1)!;
    await click(s, "1", "Fast");
    expect(c.changes[0]).toEqual({ provider: target.provider, model: target.id });
    expect([...s.api.buttons.values()].flat(2).every(button => new TextEncoder().encode(button.callbackData).length <= 64)).toBe(true);
  });

  test("authorization, source binding, fabricated actions and stale thinking menus cannot change runtime", async () => {
    const s = setup(); const c = controls(s);
    await s.channel.handle({ ...message, text: "/models" });
    await waitUntil(() => s.api.buttons.has("1"));
    for (const override of [{ actorId: "99" }, { chatType: "group" }, { topic: true }, { business: true }]) await click(s, "1", "alpha", override);
    expect(s.api.answers).toEqual([]);
    await click(s, "1", "alpha", { chatId: "99" });
    expect(s.api.answers.at(-1)?.alert).toBe(true);
    const token = s.api.buttons.get("1")![0][0].callbackData.split(":")[1];
    await click(s, "1", "alpha", { data: `p:${token}:model:999` });
    expect(c.changes).toEqual([]);
    await s.channel.handle({ ...message, text: "/thinking" });
    await waitUntil(() => s.api.buttons.has("2"));
    expect(s.api.messages.get("2")!.text).toContain("Thinking is unavailable");
    c.description.selection = { provider: "alpha", model: "reasoning", thinking: "off" };
    await click(s, "2", "off");
    expect(c.changes).toEqual([]); expect(s.api.answers.at(-1)?.alert).toBe(true);
  });

  test("status keeps execution details when optional runtime metadata cannot be read", async () => {
    const s = setup();
    s.runtime.describe = async () => { throw new Error("private credentials"); };
    await s.channel.handle({ ...message, text: "/status" });
    await waitUntil(() => s.api.writes.length > 0);
    expect(s.api.writes[0].text).toContain("Status: Ready");
    expect(s.api.writes[0].text).toContain("Model details unavailable");
    expect(s.api.writes[0].text).not.toContain("private");
  });

  test("reload is absent from commands and help, and does not enter the conversation", async () => {
    const s = setup(); controls(s);
    expect(TELEGRAM_COMMANDS.some(item => item.command === "reload")).toBe(false);
    await s.channel.handle({ ...message, text: "/help" });
    await waitUntil(() => s.api.writes.length > 0);
    expect(s.api.writes[0].text).not.toContain("/reload");
    await s.channel.handle({ ...message, text: "/reload" });
    await waitUntil(() => s.api.writes.some(write => write.text.includes("Unknown command")));
    expect(s.session.calls).toBe(0);
    expect(s.repo.db.query("SELECT * FROM runs").all()).toEqual([]);
  });

  test("busy and queued runs reject mutations while read-only menus and status remain available", async () => {
    const s = setup(); const c = controls(s); let operations = 0;
    s.runtime.compact = async () => { operations++; return { status: "compacted" }; };
    const opening = Promise.withResolvers<ChatSession>();
    const prompt = s.session.prompt.bind(s.session);
    s.session.prompt = async (...args) => { await opening.promise; await prompt(...args); };
    const run = await s.store.startRun(s.store.main.sessionId, crypto.randomUUID(), "RN queued");
    expect(run.active).toBe(true); expect(s.session.isStreaming).toBe(false);
    await s.channel.handle({ ...message, text: "/models" });
    await waitUntil(() => s.api.buttons.has("1"));
    await click(s, "1", "alpha");
    await waitUntil(() => s.api.buttons.get("1")![0][0].text === "Fast ✓");
    await click(s, "1", "Reasoning");
    expect(s.api.answers.at(-1)?.text).toContain("Piko is busy");
    for (const text of ["/compact", "/status"]) await s.channel.handle({ ...message, text });
    await waitUntil(() => s.api.writes.some(write => write.text.includes("Thinking: off")));
    expect(c.changes).toEqual([]); expect(operations).toBe(0);
    opening.resolve(s.session); await waitUntil(() => s.session.calls === 1); await run.cancel();
  });

  test("compact reserves before initialization, blocks RN/TG admission and releases after failure", async () => {
    const s = setup(); controls(s);
    const held = Promise.withResolvers<CompactionResult>();
    s.runtime.compact = async () => held.promise;
    await s.channel.handle({ ...message, text: "/compact" });
    await waitUntil(() => s.store.isStreaming(s.store.main.sessionId));
    await expect(s.store.startRun(s.store.main.sessionId, crypto.randomUUID(), "RN")).rejects.toThrow("Stop the current reply");
    expect((await s.store.startTelegram({ ...input, messageId: "during" }, "TG")).disposition).toBe("busy");
    const app = createApp({ config: defaultServerConfig(), runtime: s.runtime, conversations: s.store });
    expect((await app(new Request("http://localhost/api/runtime/compact", { method: "POST" }))).status).toBe(409);
    held.reject(new Error("secret token must not leak"));
    await waitUntil(() => !s.store.isStreaming(s.store.main.sessionId));
    await waitUntil(() => s.api.writes.some(write => write.text.includes("Couldn't complete that action")));
    expect(s.api.writes.some(write => write.text.includes("secret"))).toBe(false);
    await s.channel.handle({ ...message, text: "/models" });
    await waitUntil(() => s.api.buttons.size === 1);
    const menuId = [...s.api.buttons.keys()][0];
    await click(s, menuId, "alpha");
    expect(s.api.answers.at(-1)?.alert).not.toBe(true);
    s.runtime.compact = async () => ({ status: "compacted" });
    await s.channel.handle({ ...message, text: "/compact" });
    await waitUntil(() => s.api.writes.some(write => write.text.includes("Context compacted.")));
    expect(s.session.calls).toBe(0); expect(s.repo.db.query("SELECT * FROM runs").all()).toEqual([]);
  });

  test("SDK preserves plain menus, maps keyboard and acknowledges callbacks", async () => {
    const calls: { method: string; body: any }[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      calls.push({ method: new URL(request.url).pathname.split("/").at(-1)!, body: await request.json() });
      return Response.json({ ok: true, result: { message_id: 3 } });
    } });
    cleanups.push(() => server.stop(true));
    const api = new TelegramApi(new Bot("77:test", { client: { apiRoot: `http://127.0.0.1:${server.port}` } }));
    cleanups.push(() => api.controller.abort());
    const buttons = [[{ text: "high ✓", callbackData: "p:12345678-abcd:think:3" }]];
    await api.send("42", "Choose a thinking level", false, buttons);
    await api.edit("42", "3", "Thinking level updated", false, []);
    await api.answerCallback("query", "Thinking level updated", true);
    expect(calls[0]).toMatchObject({ method: "sendMessage", body: { text: "Choose a thinking level", reply_markup: {
      inline_keyboard: [[{ text: "high ✓", callback_data: buttons[0][0].callbackData }]],
    } } });
    expect(calls[1].body.reply_markup.inline_keyboard).toEqual([]);
    expect(calls[0].body).not.toHaveProperty("reply_parameters");
    expect(calls[2]).toMatchObject({ method: "answerCallbackQuery", body: { callback_query_id: "query", text: "Thinking level updated", show_alert: true } });
  });

  test("Bot polls and dispatches authorized keyboard callbacks", async () => {
    const s = setup(); controls(s);
    const menuData = Promise.withResolvers<string>(); const held = Promise.withResolvers<void>();
    const methods: string[] = []; let edited = "";
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      const method = new URL(request.url).pathname.split("/").at(-1)!; methods.push(method);
      const body = await request.json(); let result: unknown = true;
      const chat = { id: 42, type: "private", first_name: "User" };
      const from = { id: 42, is_bot: false, first_name: "User" };
      if (method === "getMe") result = { id: 77, is_bot: true, first_name: "Piko", username: "piko_bot" };
      else if (method === "getWebhookInfo") result = { url: "", has_custom_certificate: false, pending_update_count: 0 };
      else if (method === "getUpdates") {
        expect(body.allowed_updates).toEqual(["message", "callback_query"]);
        if (body.offset === 0) result = [{ update_id: 10, message: { message_id: 1, date: 1, chat, from, text: "/models" } }];
        else if (body.offset === 11) result = [{ update_id: 11, callback_query: {
          id: "wire-query", from, chat_instance: "instance", data: await menuData.promise,
          message: { message_id: 3, date: 1, chat, from: { id: 77, is_bot: true, first_name: "Piko" }, text: "menu" },
        } }];
        else { await held.promise; result = []; }
      } else if (method === "sendMessage") {
        menuData.resolve(body.reply_markup.inline_keyboard[0][0].callback_data); result = { message_id: 3 };
      } else if (method === "editMessageText") { edited = body.text; result = { message_id: 3 }; }
      return Response.json({ ok: true, result });
    } });
    cleanups.push(() => { held.resolve(); server.stop(true); });
    const config = { token: "77:test", userId: "42" };
    const bot = new TelegramBot(config, s.store, s.runtime, new Bot(config.token,
      { client: { apiRoot: `http://127.0.0.1:${server.port}`, timeoutSeconds: 2 } }));
    cleanups.push(async () => { await bot.stopInput(); await bot.close(); });
    await bot.start(); await waitUntil(() => edited.includes("alpha models"));
    expect(methods).toContain("answerCallbackQuery"); expect(s.session.calls).toBe(0);
    await bot.stopInput(); await bot.close();
  });

  test("an RN run admitted while an HTTP selection body is read prevents the later change", async () => {
    const s = setup(); const c = controls(s);
    const body = Promise.withResolvers<Uint8Array>();
    const app = createApp({ config: defaultServerConfig(), runtime: s.runtime, conversations: s.store });
    const selection = app(new Request("http://localhost/api/runtime/selection", { method: "POST", body: new ReadableStream({
      async start(controller) { controller.enqueue(await body.promise); controller.close(); },
    }) }));
    const run = await s.store.startRun(s.store.main.sessionId, crypto.randomUUID(), "RN wins");
    body.resolve(new TextEncoder().encode(JSON.stringify({ provider: "alpha", model: "reasoning" })));
    expect((await selection).status).toBe(409); expect(c.changes).toEqual([]);
    await waitUntil(() => s.session.calls === 1); await run.cancel();
  });

  test("Telegram native compact summarizes context and retains complete RN/TG history", async () => {
    const f = await fixture(); const repo = repository(f.paths);
    const store = new ConversationStore(f.runtime.createSession, defaultServerConfig(), repo, f.runtime.readHistory);
    cleanup(() => store.close()); const api = new Transport();
    const channel = new TelegramChannel({ botId: "77", username: "piko_bot", userId: "42" }, store, f.runtime, api, 5);
    cleanup(async () => { channel.stopAccepting(); await store.close(); await channel.drain(100); });
    f.faux.setResponses([fauxAssistantMessage("old answer"), fauxAssistantMessage("recent answer")]);
    const session = (await store.get(store.main.sessionId)).session;
    // Seed a long native history without crossing the product's 12,000-character input limit.
    await session.prompt("Old context. ".repeat(10000), { id: crypto.randomUUID(), createdAt: 1 });
    await session.prompt("Recent context. ".repeat(6000), { id: crypto.randomUUID(), createdAt: 2 });
    const history = await store.history(store.main.sessionId);
    f.faux.setResponses([fauxAssistantMessage("Compacted summary.")]);
    await channel.handle({ ...message, text: "/compact" });
    await waitUntil(() => api.writes.some(write => write.text.includes("Context compacted.")));
    expect(f.faux.state.callCount).toBe(3);
    expect(await store.history(store.main.sessionId)).toEqual(history);
    expect(await store.run(store.main.sessionId)).toBeUndefined();
    expect(api.writes.every(write => !write.rich)).toBe(true);
  });

  test("native selection persists across restart and control messages never enter history", async () => {
    const f = await fixture(); const repo = repository(f.paths);
    const store = new ConversationStore(f.runtime.createSession, defaultServerConfig(), repo, f.runtime.readHistory);
    cleanup(() => store.close()); const api = new Transport();
    const channel = new TelegramChannel({ botId: "77", username: "piko_bot", userId: "42" }, store, f.runtime, api, 5);
    cleanup(async () => { channel.stopAccepting(); await store.close(); await channel.drain(100); });
    await channel.handle({ ...message, text: "/models" }); await waitUntil(() => api.buttons.has("1"));
    const clickNative = async (id: string, label: string) => {
      const callbackId = `native-${++callbackSequence}`;
      channel.handleCallback({ ...message, messageId: id, callbackId, data: api.buttons.get(id)!.flat().find(button => button.text.startsWith(label))!.callbackData });
      await waitUntil(() => api.answers.some(answer => answer.id === callbackId));
    };
    await clickNative("1", "faux"); await waitUntil(() => api.buttons.get("1")!.flat().some(button => button.text.startsWith("Reasoning")));
    await clickNative("1", "Reasoning"); await waitUntil(() => api.buttons.has("2"));
    await clickNative("2", "high");
    await channel.handle({ ...message, text: "/status" });
    await waitUntil(() => api.writes.some(write => write.text.includes("Context limit: 250,000 tokens")));
    const selection = (await f.runtime.describe!(store.context())).selection;
    expect(selection).toEqual({ provider: "faux", model: "reasoning", thinking: "high" });
    expect(f.faux.state.callCount).toBe(0); expect(await store.history(store.main.sessionId)).toEqual([]);
    await channel.drain(100); await store.close(); await f.runtime.dispose!();
    const restarted = f.createRuntime();
    expect((await restarted.describe!(repo.context(store.main.sessionId))).selection).toEqual(selection);
  });
});
