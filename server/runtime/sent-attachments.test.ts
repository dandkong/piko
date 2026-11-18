import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AttachmentStore, detectExtension, detectSentAttachmentMime } from "../attachments";
import { sentAttachmentRequest } from "../attachments/sent-http";
import { createSentAttachmentTools, sentAttachmentMessage, type SentAttachment } from "./sent-attachments";

test("assistant file MIME comes from the extension database and is persisted in the message", async () => {
  const state = await mkdtemp(join(tmpdir(), "piko-sent-mime-test-"));
  try {
    const store = new AttachmentStore(join(state, "attachments"));
    const tool = createSentAttachmentTools(store).tools![0]!;
    let recorded: SentAttachment | undefined;
    const tx = { appendEntry: async (_entry: unknown, _id: number, value: { data: SentAttachment }) => { recorded = value.data; } };
    const api = { conversationId: 1, now: () => 123, commit: async (fn: (tx: unknown) => unknown) => fn(tx) };
    const path = join(state, "sample.epub");
    await writeFile(path, "file content");
    const result = await tool.execute({ path }, api as never, context);
    expect(result.isError).not.toBe(true);
    expect(recorded?.mime).toBe("application/epub+zip");
    expect(recorded?.name).toBe("sample.epub");
    const message = sentAttachmentMessage(7, recorded!);
    expect(message.attachments?.[0]?.mime).toBe("application/epub+zip");
    expect(detectSentAttachmentMime("file.with-unknown-extension-xyz")).toBe("application/octet-stream");
    // User-upload extension rules deliberately remain unchanged.
    expect(detectExtension("sample.epub")).toBe("application/octet-stream");
    for (const [name, type] of [["sound.mp3", "audio/mpeg"], ["sound.m4a", "audio/mp4"], ["sound.ogg", "audio/ogg"], ["sound.wav", "audio/wav"]])
      expect(detectSentAttachmentMime(name!)).toBe(type!);
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("audio preview keeps range playback for assistant snapshots", async () => {
  const state = await mkdtemp(join(tmpdir(), "piko-sent-preview-test-"));
  try {
    const store = new AttachmentStore(join(state, "attachments"));
    const source = join(state, "sound.mp3");
    await writeFile(source, "ID3sample-audio");
    const sent = await store.saveSnapshot(source);
    const response = await sentAttachmentRequest(new Request(`http://localhost/api/sent-attachments/${sent.id}?name=sound.mp3&play=1`, { headers: { Range: "bytes=0-2" } }), store);
    expect(response?.status).toBe(206);
    expect(response?.headers.get("content-type")).toBe("audio/mpeg");
    expect((await response!.arrayBuffer()).byteLength).toBe(3);
  } finally { await rm(state, { recursive: true, force: true }); }
});
