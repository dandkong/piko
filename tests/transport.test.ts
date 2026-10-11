import { expect, test } from "bun:test";
import { observeConversation, submitMessage } from "../apps/mobile/src/features/chat/transport";
import { encodeSse } from "../shared/sse";
test("lost input acknowledgements retry the same identity and message",async()=>{
 const bodies:any[]=[];let calls=0;
 const result=await submitMessage("Hello","stable",new AbortController().signal,{fetch:async(_path,init)=>{bodies.push(JSON.parse(init!.body as string));if(++calls===1)throw new Error("lost acknowledgement");return Response.json({submission:{id:"3"},duplicate:true});},wait:async()=>{}});
 expect(result.duplicate).toBe(true);expect(bodies).toEqual([{requestId:"stable",message:"Hello"},{requestId:"stable",message:"Hello"}]);
});
test("conversation reconnect uses its cursor, accepts a new epoch and never submits input",async()=>{
 const controller=new AbortController();const paths:string[]=[];const events:any[]=[];
 await observeConversation({signal:controller.signal,onReconnecting:()=>{},onEvent:e=>{events.push(e);if(events.length===2)controller.abort();}},{fetch:async path=>{paths.push(path);return new Response(encodeSse({type:"snapshot",epoch:paths.length===1?"first":"restarted",sequence:0,conversation:{messages:[],busy:false}}));},wait:async()=>{}});
 expect(paths).toEqual(["/api/chat/events","/api/chat/events?epoch=first&after=0"]);expect(events.map(e=>e.epoch)).toEqual(["first","restarted"]);
});
test("replayed frames are ignored and malformed frames recover instead of overwriting state",async()=>{
 const controller=new AbortController();let fetches=0;const sequences:number[]=[];
 await observeConversation({signal:controller.signal,onReconnecting:()=>{},onEvent:e=>{sequences.push(e.sequence!);if(e.sequence===2)controller.abort();}},{fetch:async()=>{
  fetches++;return new Response(fetches===1?encodeSse({type:"snapshot",epoch:"same",sequence:1,conversation:{messages:[],busy:false}})+"data: {bad}\n\n":encodeSse({type:"snapshot",epoch:"same",sequence:1,conversation:{messages:[],busy:false}})+encodeSse({type:"snapshot",epoch:"same",sequence:2,conversation:{messages:[],busy:true}}));
 },wait:async()=>{}});expect(sequences).toEqual([1,2]);
});


test("an event gap discards the stale cursor and recovers through a fresh snapshot",async()=>{
 const controller=new AbortController();const paths:string[]=[];const events:any[]=[];
 await observeConversation({signal:controller.signal,onReconnecting:()=>{},onEvent:e=>{events.push(e);if(events.length===2)controller.abort();}},{fetch:async path=>{
  paths.push(path);return new Response(paths.length===1?encodeSse({type:"snapshot",epoch:"same",sequence:1,conversation:{messages:[],busy:false}})+encodeSse({type:"refresh",epoch:"same",sequence:3}):encodeSse({type:"snapshot",epoch:"same",sequence:4,conversation:{messages:[],busy:false}}));
 },wait:async()=>{}});expect(paths).toEqual(["/api/chat/events","/api/chat/events"]);expect(events.map(e=>e.sequence)).toEqual([1,4]);
});
