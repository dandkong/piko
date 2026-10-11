import { describe, expect, test } from "bun:test";
import { Bot, GrammyError } from "grammy";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fixture, cleanup, waitUntil } from "./fixtures/durable";
import { ConversationStore } from "../server/chat/conversations";
import { TELEGRAM_COMMANDS, TelegramChannel, type TelegramMessage } from "../server/channels/telegram/channel";
import { TelegramBot } from "../server/channels/telegram/bot";
import { TelegramReply, TelegramMessageOutput, splitReply, TELEGRAM_RICH_LIMIT, TELEGRAM_PLAIN_LIMIT } from "../server/channels/telegram/output";
import { isFormatError, telegramRequest, TelegramApi, type TelegramTransport, type TelegramKeyboard } from "../server/channels/telegram/api";
import { messageEvent } from "./fixtures/messages";
const cleanups = { push: cleanup };
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

describe("Telegram rendering and network errors", () => {
 const error = (code: number, description: string, retry_after?: number) => new GrammyError("failure", { ok: false, error_code: code, description, parameters: retry_after === undefined ? {} : { retry_after } }, "sendMessage", {});
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

const message: TelegramMessage = { chatId:"42",actorId:"42",messageId:"1",chatType:"private",text:"Task" };
async function setup(tokensPerSecond?:number){
 const f=await fixture(tokensPerSecond);const store=new ConversationStore(f.runtime);const api=new Transport();
 const channel=new TelegramChannel({botId:"77",username:"piko_bot",userId:"42"},store,f.runtime,api,5);
 cleanup(async()=>{channel.stopAccepting();await store.close();await channel.drain(100);});
 return {...f,store,api,channel};
}
test("unauthorized messages never enter durable and repeated Telegram identities execute once",async()=>{
 const f=await setup();f.faux.setResponses([fauxAssistantMessage("Reply")]);
 for(const changes of [{actorId:"other"},{chatType:"group"},{topic:true},{business:true}]) await f.channel.handle({...message,...changes});
 expect(f.faux.state.callCount).toBe(0);expect(f.store.size).toBe(0);
 await f.channel.handle(message);await waitUntil(()=>f.api.messages.size===1);await f.channel.handle(message);
 expect(f.faux.state.callCount).toBe(1);expect(f.api.writes).toHaveLength(1);
 expect((await f.store.snapshot()).messages.map(m=>m.content)).toEqual(["Task","Reply"]);
 expect((await(await f.store.get()).submission("telegram:77:42:1"))?.status).toBe("done");
});
test("TG steers share conversation output without replaying assistant messages",async()=>{
 const f=await setup();const gate=Promise.withResolvers<void>();const entered=Promise.withResolvers<void>();cleanup(()=>gate.resolve());
 f.faux.setResponses([async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage([{type:"text",text:"Before"},fauxToolCall("read",{path:"MEMORY.md"})],{stopReason:"toolUse"});},fauxAssistantMessage("After")]);
 await f.channel.handle(message);await entered.promise;await f.channel.handle({...message,messageId:"2",text:"Correction"});await f.store.submit("Short","rn");gate.resolve();
 await waitUntil(()=>[...f.api.messages.values()].some(m=>m.text==="After"));
 expect([...f.api.messages.values()].map(m=>m.text)).toEqual(["Before","After"]);expect(f.api.writes).toHaveLength(2);
 expect((await f.store.snapshot()).messages.filter(m=>m.role==="user").map(m=>m.content)).toEqual(["Task","Correction","Short"]);
});
test("RN-only work stays in RN and TG joining a later turn does not resend earlier output",async()=>{
 const f=await setup();const gate=Promise.withResolvers<void>();const entered=Promise.withResolvers<void>();cleanup(()=>gate.resolve());
 f.faux.setResponses([fauxAssistantMessage([{type:"text",text:"Already completed"},fauxToolCall("read",{path:"MEMORY.md"})],{stopReason:"toolUse"}),async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage("Current answer");},fauxAssistantMessage("Steered answer")]);
 await f.store.submit("RN task","rn");await entered.promise;expect(f.api.writes).toHaveLength(0);
 await f.channel.handle(message);gate.resolve();await waitUntil(()=>[...f.api.messages.values()].some(m=>m.text==="Steered answer"));
 expect([...f.api.messages.values()].map(m=>m.text)).toEqual(["Current answer","Steered answer"]);
});
test("repeated stop commands never target a later native task",async()=>{
 const f=await setup();await f.channel.handle({...message,messageId:"stop",text:"/stop"});
 const gate=Promise.withResolvers<void>();const entered=Promise.withResolvers<void>();cleanup(()=>gate.resolve());
 f.faux.setResponses([async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage("Held");}]);
 await f.store.submit("RN task","rn");await entered.promise;await f.channel.handle({...message,messageId:"stop",text:"/stop"});expect((await f.store.snapshot()).busy).toBe(true);
 const stopping=f.channel.handle({...message,messageId:"new-stop",text:"/stop"});await waitUntil(async()=> (await (await f.createSession()).nativeHarness.inspect(ctx)).tasks.some(task=>task.record.abortRequested));gate.resolve();await stopping;
 expect((await(await f.store.get()).submission("rn"))?.status).toBe("unanswered");
});
test("model and thinking menus use native selection and remain absent from chat history",async()=>{
 const f=await setup();await f.channel.handle({...message,text:"/models"});await waitUntil(()=>f.api.buttons.has("1"));
 let seq=0;const click=async(id:string,label:string)=>{const callbackId=String(++seq);f.channel.handleCallback({...message,messageId:id,callbackId,data:f.api.buttons.get(id)!.flat().find(b=>b.text.startsWith(label))!.callbackData});await waitUntil(()=>f.api.answers.some(a=>a.id===callbackId));};
 await click("1","faux");await click("1","Reasoning");await waitUntil(()=>f.api.buttons.has("2"));await click("2","high");
 expect((await f.runtime.describe!()).selection).toEqual({provider:"faux",model:"reasoning",thinking:"high"});
 expect((await f.store.snapshot()).messages).toEqual([]);expect(f.faux.state.callCount).toBe(0);
 await f.channel.handle({...message,text:"/status"});await waitUntil(()=>f.api.writes.some(w=>w.text.includes("Thinking: high")));
 expect(TELEGRAM_COMMANDS.some(c=>c.command==="reload")).toBe(false);
});
test("compact command distinguishes actual application from an empty context",async()=>{
 const f=await setup();await f.channel.handle({...message,text:"/compact"});await waitUntil(()=>f.api.writes.some(w=>w.text.includes("No summary created")));
 expect(f.faux.state.callCount).toBe(0);
});
test("poller confirms inputs only after admission and never removes an existing webhook",async()=>{
 const f=await setup();const offsets:number[]=[];const methods:string[]=[];let webhook=true;const held=Promise.withResolvers<void>();cleanup(()=>held.resolve());
 f.faux.setResponses([fauxAssistantMessage("Reply")]);
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){const method=new URL(request.url).pathname.split("/").at(-1)!;methods.push(method);const body=await request.json();let result:unknown=true;
 if(method==="getMe")result={id:77,is_bot:true,first_name:"Piko",username:"piko_bot"};
 if(method==="getWebhookInfo")result={url:webhook?"https://example.invalid/hook":"",has_custom_certificate:false,pending_update_count:0};
 if(method==="getUpdates"){offsets.push(body.offset);if(body.offset===0)result=[{update_id:10,message:{message_id:1,date:1,chat:{id:42,type:"private",first_name:"User"},from:{id:42,is_bot:false,first_name:"User"},text:"Task"}}];else{await held.promise;result=[];}}
 if(method==="sendMessage"||method==="sendRichMessage")result={message_id:3};return Response.json({ok:true,result});}});cleanup(()=>server.stop(true));
 const make=()=>new TelegramBot({token:"77:test",userId:"42"},f.store,f.runtime,new Bot("77:test",{client:{apiRoot:`http://127.0.0.1:${server.port}`,timeoutSeconds:2}}));
 const refused=make();await refused.start();await refused.stopInput();await refused.close();expect(methods).not.toContain("deleteWebhook");expect(offsets).toEqual([]);
 webhook=false;const bot=make();cleanup(async()=>{await bot.stopInput();await bot.close();});await bot.start();await waitUntil(()=>offsets.length>=2);expect(offsets.slice(0,2)).toEqual([0,11]);await bot.stopInput();await bot.close();
});


test("conversation delivery edits partial output before the native message completes", async () => {
 const f=await setup(30);const body="Streaming response before completion. ".repeat(3);
 f.faux.setResponses([fauxAssistantMessage(body)]);await f.channel.handle(message);
 await waitUntil(()=>f.api.messages.size>0);
 expect((await f.store.snapshot()).busy).toBe(true);
 expect(f.api.messages.get("1")!.text.length).toBeLessThan(body.length);
 await waitUntil(()=>f.api.messages.get("1")?.text===body);
 expect(f.api.writes).toHaveLength(1);
});


test("slow or failed delivery never holds stop admission or changes native execution success", async () => {
 const f=await setup();const blocked=Promise.withResolvers<void>();cleanup(()=>blocked.resolve());f.api.block=blocked.promise;
 f.faux.setResponses([fauxAssistantMessage("Saved answer")]);await f.channel.handle(message);await waitUntil(()=>f.api.writes.length>0);
 const stopping=f.channel.handle({...message,messageId:"stop-slow",text:"/stop"});await stopping;
 blocked.resolve();await waitUntil(async()=> (await(await f.store.get()).submission("telegram:77:42:1"))?.status==="done");
 expect((await f.store.snapshot()).messages.some(m=>m.content==="Saved answer")).toBe(true);
 f.api.failure=new Error("network");f.faux.setResponses([fauxAssistantMessage("Another saved answer")]);await f.channel.handle({...message,messageId:"2",text:"Second"});
 await waitUntil(async()=> (await(await f.store.get()).submission("telegram:77:42:2"))?.status==="done");
 expect((await f.store.snapshot()).messages.some(m=>m.content==="Another saved answer")).toBe(true);
});

test("coalesced native messages stay separate and tool-only output remains hidden", async () => {
 const f=await setup();const read=()=>fauxToolCall("read",{path:"AGENTS.md"});
 f.faux.setResponses([fauxAssistantMessage([{type:"text",text:"First"},read()],{stopReason:"toolUse"}),fauxAssistantMessage(read(),{stopReason:"toolUse"}),fauxAssistantMessage([{type:"text",text:"Second"},read()],{stopReason:"toolUse"}),fauxAssistantMessage("Third")]);
 await f.channel.handle(message);await waitUntil(()=>f.api.messages.size===3);
 expect([...f.api.messages.values()].map(m=>m.text)).toEqual(["First","Second","Third"]);
 expect((await f.store.snapshot()).messages.filter(m=>m.role==="assistant").map(m=>m.content)).toEqual(["First","Second","Third"]);
});

test("callback authorization, source binding and stale thinking menus cannot change selection", async () => {
 const f=await setup();await f.channel.handle({...message,text:"/thinking"});await waitUntil(()=>f.api.buttons.has("1"));
 const data=f.api.buttons.get("1")!.flat()[0].callbackData;
 const click=async(id:string,changes:Record<string,unknown>={})=>{f.channel.handleCallback({...message,messageId:"1",callbackId:id,data,...changes});};
 await click("unauthorized",{actorId:"99"});await click("group",{chatType:"group"});await click("topic",{topic:true});await click("business",{business:true});
 expect(f.api.answers).toEqual([]);
 await click("wrong-chat",{chatId:"99"});await waitUntil(()=>f.api.answers.some(a=>a.id==="wrong-chat"));expect(f.api.answers.at(-1)?.alert).toBe(true);
 await f.runtime.configure!({provider:"faux",model:"reasoning"});await click("stale");await waitUntil(()=>f.api.answers.some(a=>a.id==="stale"));expect(f.api.answers.at(-1)?.alert).toBe(true);
 expect((await f.runtime.describe!()).selection?.model).toBe("reasoning");expect((await f.store.snapshot()).messages).toEqual([]);
});
