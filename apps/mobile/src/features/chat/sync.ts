import type { ConversationResponse, Message } from "../../../../../shared/chat";
import { waitForRetry } from "./transport";

export function sameMessages(left: Message[], right: Message[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return item.id === other.id && item.role === other.role && item.content === other.content &&
      item.createdAt === other.createdAt && item.runId === other.runId;
  });
}

/** Discover other-channel changes only while idle. In-flight responses cannot overwrite a local submission. */
export async function syncConversation(options: {
  signal: AbortSignal;
  canPoll: () => boolean;
  revision: () => number;
  load: (signal: AbortSignal) => Promise<ConversationResponse>;
  apply: (conversation: ConversationResponse) => void;
  onError: () => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  let failures = 0;
  const wait = options.wait ?? waitForRetry;
  try {
    while (!options.signal.aborted) {
      await wait(Math.min(30_000, 3000 * 2 ** failures), options.signal);
      if (options.signal.aborted) return;
      if (!options.canPoll()) continue;
      const revision = options.revision();
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 10_000);
      try {
        const conversation = await options.load(controller.signal);
        if (!options.signal.aborted && !controller.signal.aborted && options.canPoll() && revision === options.revision()) {
          failures = 0;
          options.apply(conversation);
        }
      } catch {
        if (!options.signal.aborted && options.canPoll() && revision === options.revision()) {
          failures = Math.min(failures + 1, 4);
          options.onError();
        }
      } finally {
        clearTimeout(timeout);
        options.signal.removeEventListener("abort", abort);
      }
    }
  } catch {
    // Aborting the idle observer is normal on background, navigation or unmount.
  }
}
