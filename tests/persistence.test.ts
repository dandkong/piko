import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, createRegistry, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, UserEntry } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fixture, cleanup, waitUntil } from "./fixtures/durable";
import { initializeWorkspace, workspacePaths, readGuidance } from "../server/domain/workspace";
import { loadPikoConfig } from "../server/config";
import { readPiEntries } from "../server/runtime/pi-history";
import { runtimePaths } from "../server/runtime/config/paths";
import { acquireBackendLock } from "../server/domain/backend-lock";
import { ConversationStore } from "../server/chat/conversations";
test("initialization preserves guidance and JSON configuration, bounds reads and rejects conflicting paths", async () => {
  const f = await fixture();
  for (const name of ["AGENTS.md", "MEMORY.md"]) await writeFile(join(f.paths.workspace, name), "mine".repeat(100));
  await writeFile(join(f.paths.home, "config/piko.json"), '{"version":1,"agent":{"profiles":{"quick":{"provider":"faux","model":"fast","thinking":"off"}}}}');
  await writeFile(join(f.paths.home, "config/.env"), 'DEEPSEEK_API_KEY="private"\n');
  initializeWorkspace(f.paths);
  for (const name of ["AGENTS.md", "MEMORY.md"]) {
    expect(await readFile(join(f.paths.workspace, name), "utf8")).toBe("mine".repeat(100));
    expect(readGuidance(f.paths.workspace, name, 4)).toStartWith("mine\n[Guidance truncated");
  }
  expect(existsSync(join(f.paths.workspace, "SOUL.md"))).toBe(false);
  expect(existsSync(join(f.paths.workspace, "USER.md"))).toBe(false);
  expect(await readFile(join(f.paths.home, "config/piko.json"), "utf8")).toContain('"model":"fast"');
  expect(existsSync(join(f.paths.home, "config/settings.json"))).toBe(false);
  expect(await readFile(join(f.paths.home, "config/.env"), "utf8")).toContain("private");
  expect(existsSync(join(f.paths.home, "config/auth.json"))).toBe(false);
  expect(existsSync(join(f.paths.workspace, ".agents/skills"))).toBe(true);
  expect(() => loadPikoConfig({ PIKO_HOME: "relative" })).toThrow("absolute");
  expect(() => initializeWorkspace({ ...f.paths, state: join(f.paths.workspace, "state") })).toThrow("outside");
});

test("a live backend lock excludes another writer and stale lock ownership is recoverable", async () => {
  const f = await fixture(); const release = acquireBackendLock(f.paths.state);
  expect(() => acquireBackendLock(f.paths.state)).toThrow("already owned");
  release();
  await writeFile(join(f.paths.state, "backend.lock"), JSON.stringify({ pid: 2147483647, token: "old" }));
  acquireBackendLock(f.paths.state)();
  expect(existsSync(join(f.paths.state, "backend.lock"))).toBe(false);
});


test("native submission IDs deduplicate after reopen without SQL or Piko input markers", async () => {
 const f = await fixture(); const s = await f.createSession(); const id = crypto.randomUUID();
 f.faux.setResponses([fauxAssistantMessage("Answer")]); await s.prompt("Question", { id, createdAt: 1 });
 const first = await s.submission(id); const before = (await s.snapshot()).messages;
 expect((await readPiEntries(s.nativeHarness)).some(e => e.kind === "piko.input" || e.kind === "piko.run")).toBe(false);
 await f.runtime.dispose!(); const restarted = f.createRuntime(); const next = await restarted.createSession();
 expect(await next.submit("Question", id)).toEqual({ duplicate: true, submission: first! });
 expect((await next.snapshot()).messages).toEqual(before); expect(f.faux.state.callCount).toBe(1);
 expect(existsSync(join(f.paths.state, "piko.sqlite"))).toBe(false);
 expect(readdirSync(f.paths.state)).not.toContain("piko.sqlite");
});
test("startup withdraws persisted unfinished work before model scheduling, preserving raw history", async () => {
 const f = await fixture(); const path = runtimePaths(f.paths.home).sessions;
 const storage = await openNodeJsonlStorage(path, ctx, { fsync: true }); const raw = await Harness.open(storage, { models: f.models, registry: createRegistry() }, ctx);
 const root = await raw.root(ctx);
 // Construct native unfinished input without starting a Harness scheduler.
 await raw.commit(async tx => {
   const input = await tx.createSubmission({ conversationId: root.id, requestId: "unfinished", type: "input", status: "queued" });
   (await tx.doc(InboxDoc, root.id)).items.push({ id: input.id, mode: "steer", content: "must not replay" });
   await tx.doc(LiveDoc, root.id);
   await tx.appendEntry(UserEntry, root.id, { model: [{ role: "user", content: "Already saved", timestamp: 1 }] });
 }, ctx); await raw.close(ctx);
 const s = await f.createSession();
 expect(s.native.id).toBe(ROOT_CONVERSATION_ID);
 expect((await s.submission("unfinished"))?.status).toBe("unanswered");
 expect((await s.snapshot()).messages.map(m=>m.content)).toEqual(["Already saved"]);
 expect((await s.snapshot()).interruption).toContain("interrupted"); expect(f.faux.state.callCount).toBe(0);
});
test("old stop receipts cannot abort a later execution, including after a restart", async () => {
 const f = await fixture(); let s = await f.createSession();
 expect(await s.abort("old-idle-stop")).toBe(false);
 await f.runtime.dispose!(); const restarted = f.createRuntime(); s = await restarted.createSession() as typeof s;
 const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); cleanup(()=>gate.resolve());
 f.faux.setResponses([async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage("New answer");}]);
 await s.submit("New work", "new"); await entered.promise;
 expect(await s.abort("old-idle-stop")).toBe(false); expect((await s.snapshot()).busy).toBe(true);
 gate.resolve(); await s.native.waitForIdle(ctx); expect((await s.submission("new"))?.status).toBe("done");
});
test("conversation observers detach independently and stale epochs receive a fresh snapshot", async () => {
 const f = await fixture(); const store = new ConversationStore(f.runtime); cleanup(()=>store.close());
 const first: any[]=[]; const stop=await store.observe(e=>first.push(e));
 expect(first[0].type).toBe("snapshot"); const epoch=first[0].epoch; const cursor=first[0].sequence;
 stop(); f.faux.setResponses([fauxAssistantMessage("Saved")]); await store.submit("Input", "id");
 await waitUntil(async()=> (await (await store.get()).submission("id"))?.status === "done"); await store.flush();
 expect(first).toHaveLength(1); const replay:any[]=[]; const detach=await store.observe(e=>replay.push(e),epoch,cursor);detach();
 expect(replay.length).toBeGreaterThan(0); const reset:any[]=[]; const stop2=await store.observe(e=>reset.push(e),"old-process",99999);stop2();
 expect(reset[0].conversation.messages.map((m:any)=>m.content)).toEqual(["Input","Saved"]);
});
