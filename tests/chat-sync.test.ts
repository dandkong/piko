import { describe, expect, test } from "bun:test";
import { sameMessages, syncConversation } from "../apps/mobile/src/features/chat/sync";
import type { ConversationResponse } from "../shared/chat";

const snapshot: ConversationResponse = { sessionId: "main", messages: [{ id: "u1", role: "user", content: "TG", createdAt: 1 }],
  run: { id: "run", status: "running", message: "TG", createdAt: 1, lastEventId: 1 } };

describe("foreground conversation discovery", () => {
  test("discovers active and already completed external Runs, suppresses duplicate message updates", async () => {
    const controller = new AbortController(); const applied: ConversationResponse[] = [];
    let loads = 0;
    await syncConversation({ signal: controller.signal, canPoll: () => true, revision: () => 0,
      wait: async () => {}, onError: () => { throw new Error("unexpected"); },
      load: async () => ++loads === 1 ? snapshot : { ...snapshot, run: { ...snapshot.run!, status: "succeeded" } },
      apply: value => { applied.push(value); if (applied.length === 2) controller.abort(); },
    });
    expect(applied.map(value => value.run!.status)).toEqual(["running", "succeeded"]);
    expect(sameMessages(snapshot.messages, snapshot.messages.map(item => ({ ...item })))).toBe(true);
    expect(sameMessages(snapshot.messages, [{ ...snapshot.messages[0], content: "changed" }])).toBe(false);
  });

  test("an in-flight idle snapshot cannot overwrite a newly started local submission", async () => {
    const controller = new AbortController(); let version = 0; let applied = 0; let waits = 0;
    await syncConversation({ signal: controller.signal, canPoll: () => true, revision: () => version,
      wait: async () => { if (++waits > 1) controller.abort(); }, onError: () => {},
      load: async () => { version++; return snapshot; }, apply: () => { applied++; },
    });
    expect(applied).toBe(0);
  });

  test("no idle fetch runs while observing/submitting; background abort cancels the in-flight request", async () => {
    const controller = new AbortController(); let allowed = false; let loads = 0; let requestAborted = false;
    await syncConversation({ signal: controller.signal, canPoll: () => allowed, revision: () => 0,
      wait: async () => { if (!allowed) { allowed = true; return; } }, onError: () => {},
      load: signal => {
        loads++; controller.abort(); requestAborted = signal.aborted;
        return Promise.resolve(snapshot);
      }, apply: () => { throw new Error("aborted response must be discarded"); },
    });
    expect(loads).toBe(1); expect(requestAborted).toBe(true);
    const stopped = new AbortController(); stopped.abort();
    await syncConversation({ signal: stopped.signal, canPoll: () => true, revision: () => 0,
      load: async () => { loads++; return snapshot; }, apply: () => {}, onError: () => {} });
    expect(loads).toBe(1);
  });

  test("network errors back off without losing existing conversation state", async () => {
    const controller = new AbortController(); const delays: number[] = []; let errors = 0;
    await syncConversation({ signal: controller.signal, canPoll: () => true, revision: () => 0,
      wait: async delay => { delays.push(delay); if (delays.length === 4) controller.abort(); },
      load: async () => { throw new Error("offline"); }, apply: () => { throw new Error("must not clear messages"); },
      onError: () => { errors++; },
    });
    expect(delays).toEqual([3000, 6000, 12000, 24000]); expect(errors).toBe(3);
  });
});
