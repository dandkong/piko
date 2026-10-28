import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  defineTool,
  type ConversationId,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { SessionHistoryWindow, SessionSearchHit } from "./pi-history";
import { isUserConversation } from "./subagents/delegations";

const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 25;
const HISTORY_DEFAULT_LIMIT = 10;
const HISTORY_MAX_LIMIT = 20;

type HistoryScope = { conversationId: ConversationId };
type SessionHistoryAccess = {
  backgroundScope?: (api: ToolExecutionApi, ctx: Context) => Promise<HistoryScope | undefined>;
  search: (conversationId: ConversationId, query: string, limit: number) => Promise<{
    results: SessionSearchHit[];
    truncated: boolean;
  }>;
  history: (conversationId: ConversationId, messageId: string, limit: number) => Promise<SessionHistoryWindow | undefined>;
};

function output(value: object): ToolExecutionResult {
  return { output: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): ToolExecutionResult {
  return { ...output({ status: "error", error: message }), isError: true };
}

async function userSession(api: ToolExecutionApi, ctx: Context): Promise<boolean> {
  return api.commit(tx => isUserConversation(tx, api.conversationId), ctx);
}

/** Current-session transcript search and anchored history reads for the main chat and active side chats. */
export function createSessionSearchTools(access: SessionHistoryAccess) {
  const scopeFor = async (api: ToolExecutionApi, ctx: Context): Promise<HistoryScope | undefined> =>
    await userSession(api, ctx) ? { conversationId: api.conversationId } : access.backgroundScope?.(api, ctx);
  const sessionsSearch = defineTool({
    name: "sessions_search",
    replay: "unsafe",
    description:
      "Search visible user and assistant text in the permitted conversation history: the current main/side chat, or the host-authorized main-chat snapshot for a Posts researcher. Use this to check prior discussion. Search terms are literal; all whitespace-separated terms must occur in a message. Results are ordered newest first. Use sessions_history with a result's sessionId and messageId to read bounded surrounding context. Tool output, reasoning, hidden internal inputs, and attachment contents are not searched.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 4096, description: "Keywords or a phrase to find in past user and assistant messages." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_MAX_LIMIT,
        description: `Maximum results to return (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` })),
    }, { additionalProperties: false }),
    outputLimits: { maxBytes: 64 * 1024, maxLines: 500 },
    execute: async (args, api, ctx) => {
      const query = args.query.trim();
      if (!query) return failure("query must not be empty.");
      const scope = await scopeFor(api, ctx);
      if (!scope) return failure("Session search is not available in this conversation.");
      try {
        const result = await access.search(scope.conversationId, query, args.limit ?? SEARCH_DEFAULT_LIMIT);
        return output({ sessionId: String(scope.conversationId), ...result });
      } catch {
        return failure("Could not search this conversation's history.");
      }
    },
  });

  const sessionsHistory = defineTool({
    name: "sessions_history",
    replay: "unsafe",
    description:
      "Read a bounded window of visible messages around a sessions_search result. Pass its sessionId and the raw Durable entry ID as messageId, without a prefix. Each message is capped at 500 characters. To continue scrolling, pass an id from the returned messages as messageId. A missing or out-of-session anchor returns an error rather than falling back to the latest messages.",
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, description: "sessionId returned by sessions_search; must be within the host-authorized history scope." }),
      messageId: Type.String({ pattern: "^[1-9]\\d*$", description: "Raw Durable entry ID returned by sessions_search or as a message id in sessions_history; do not add a prefix." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: HISTORY_MAX_LIMIT,
        description: `Maximum total messages including the anchor (default ${HISTORY_DEFAULT_LIMIT}, max ${HISTORY_MAX_LIMIT}).` })),
    }, { additionalProperties: false }),
    outputLimits: { maxBytes: 64 * 1024, maxLines: 500 },
    execute: async (args, api, ctx) => {
      const scope = await scopeFor(api, ctx);
      if (!scope || args.sessionId !== String(scope.conversationId))
        return failure("sessions_history can only read the host-authorized conversation.");
      try {
        const history = await access.history(scope.conversationId, args.messageId, args.limit ?? HISTORY_DEFAULT_LIMIT);
        return history
          ? output({ sessionId: String(scope.conversationId), messageId: args.messageId, ...history })
          : failure("Message not found in visible history for this conversation.");
      } catch {
        return failure("Could not read this conversation's history.");
      }
    },
  });

  return defineExtension({ name: "piko-session-search", tools: [sessionsSearch, sessionsHistory] });
}
