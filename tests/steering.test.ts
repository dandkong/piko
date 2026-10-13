import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fixture, cleanup, waitUntil } from "./fixtures/durable";
import { ConversationStore } from "../server/chat/conversations";

test("all steers are placed together while assistant messages remain independent", async()=>{
 const f=await fixture();const s=await f.createSession();const gate=Promise.withResolvers<void>();const entered=Promise.withResolvers<void>();cleanup(()=>gate.resolve());
 f.faux.setResponses([async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage([{type:"text",text:"Before"},fauxToolCall("read",{path:"MEMORY.md"})],{stopReason:"toolUse"});},context=>{
  const user=context.messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join(" ");expect(user).toContain("English");expect(user).toContain("Short");return fauxAssistantMessage("After");
 }]);
 const a=await s.submit("Task","a");await entered.promise;await s.submit("English","b");await s.submit("Short","c");
 expect((await s.submit("Task","a")).submission.id).toBe(a.submission.id);expect((await s.snapshot()).messages.filter(m=>m.role==="user")).toHaveLength(3);
 gate.resolve();await s.native.waitForIdle(ctx);const snapshot=await s.snapshot();
 expect(snapshot.messages.filter(m=>m.role==="assistant").map(m=>m.content)).toEqual(["Before","After"]);
 expect(snapshot.messages.filter(m=>m.role==="user").map(m=>m.requestId)).toEqual(["a","b","c"]);expect(f.faux.state.callCount).toBe(2);
});
test("stop settles active input and withdraws unapplied steers without replay", async()=>{
 const f=await fixture();const s=await f.createSession();const gate=Promise.withResolvers<void>();const entered=Promise.withResolvers<void>();cleanup(()=>gate.resolve());
 f.faux.setResponses([async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage("Partial");},fauxAssistantMessage("Next")]);
 await s.submit("First","a");await entered.promise;await s.submit("Unapplied","b");const stopped=s.abort("stop-1");gate.resolve();expect(await stopped).toBe(true);
 await waitUntil(async()=> (await s.submission("b"))?.status==="unanswered");expect((await s.snapshot()).messages.some(m=>m.content==="Unapplied")).toBe(false);
 await s.prompt("New task",{id:"c",createdAt:1});expect(f.faux.state.callCount).toBe(2);
 expect(await s.abort("stop-1")).toBe(true);expect((await s.submission("c"))?.status).toBe("done");
});
test("a failed provider clears queued steers before the next explicit input",async()=>{
 const f=await fixture();const s=await f.createSession();
 const gate=Promise.withResolvers<void>();const entered=Promise.withResolvers<void>();cleanup(()=>gate.resolve());
 f.faux.setResponses([async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage("",{stopReason:"error",errorMessage:"failed"});},fauxAssistantMessage("Next")]);
 await s.submit("Fail","a");await entered.promise;await s.submit("Never replay","b");gate.resolve();
 await waitUntil(async()=> (await s.submission("b"))?.status==="unanswered");
 expect((await s.snapshot()).latest?.error).toBe("failed");
 await s.prompt("Explicit new task",{id:"c",createdAt:1});expect(f.faux.state.callCount).toBe(2);expect((await s.snapshot()).messages.some(m=>m.content==="Never replay")).toBe(false);
});
