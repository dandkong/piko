import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fixture, cleanup, waitUntil } from "./fixtures/durable";
import { createApp } from "../server/app";
import { ConversationStore } from "../server/chat/conversations";
import { defaultServerConfig } from "../server/config";
import { consumeSse } from "../shared/sse";
async function setup(){const f=await fixture();const store=new ConversationStore(f.runtime);cleanup(()=>store.close());return {...f,store,app:createApp({runtime:f.runtime,conversations:store,config:defaultServerConfig()})};}
test("input acceptance is separate from an observer that remains open across idle turns",async()=>{
 const f=await setup();const controller=new AbortController();const response=await f.app(new Request("http://local/api/chat/events",{signal:controller.signal}));const reader=response.body!.getReader();
 expect(consumeSse(new TextDecoder().decode((await reader.read()).value)).events[0].type).toBe("snapshot");
 f.faux.setResponses([fauxAssistantMessage("First"),fauxAssistantMessage("Second")]);
 const post=(id:string)=>f.app(new Request("http://local/api/chat",{method:"POST",body:JSON.stringify({message:"Hello",requestId:id})}));
 const first=await(await post("one")).json();expect(first.submission.id).toBeString();expect(first.duplicate).toBe(false);
 await waitUntil(async()=> (await(await f.store.get()).submission("one"))?.status==="done");expect((await(await post("one")).json()).duplicate).toBe(true);
 await post("two");await waitUntil(async()=> (await(await f.store.get()).submission("two"))?.status==="done");
 const state=await(await f.app(new Request("http://local/api/chat"))).json();expect(state.messages.map((m:any)=>m.content)).toEqual(["Hello","First","Hello","Second"]);
 expect(f.faux.state.callCount).toBe(2);controller.abort();await reader.cancel();
});
test("request validation, unfiltered Origin handling and native receipt lookup work without a SQL repository",async()=>{
 const f=await setup();
 expect((await f.app(new Request("http://local/api/chat",{method:"POST",body:"{"}))).status).toBe(400);
 expect((await f.app(new Request("http://local/api/chat",{method:"POST",body:JSON.stringify({message:"x"})}))).status).toBe(422);
 const crossOrigin=await f.app(new Request("http://local/api/chat",{headers:{origin:"https://bad.invalid"}}));expect(crossOrigin.status).toBe(200);expect(crossOrigin.headers.get("Access-Control-Allow-Origin")).toBe("https://bad.invalid");
 expect((await f.app(new Request("http://local/api/chat/events?after=-1"))).status).toBe(422);
 expect((await f.app(new Request("http://local/api/chat/submission?requestId=missing"))).status).toBe(404);
 expect((await f.app(new Request("http://local/api/main"))).status).toBe(404);
});


test("an unknown post-admission failure stays retryable and retry cannot execute the input again", async () => {
 const f=await setup();const session=await f.createSession();const submit=session.submit.bind(session);let first=true;
 session.submit=async (...args)=>{const result=await submit(...args);if(first){first=false;throw new Error("Acknowledgement unavailable");}return result;};
 f.faux.setResponses([fauxAssistantMessage("One answer")]);
 const post=()=>f.app(new Request("http://local/api/chat",{method:"POST",body:JSON.stringify({message:"Once",requestId:"unknown-ack"})}));
 expect((await post()).status).toBe(503);expect((await(await post()).json()).duplicate).toBe(true);
 await waitUntil(async()=> (await session.submission("unknown-ack"))?.status==="done");expect(f.faux.state.callCount).toBe(1);
});
