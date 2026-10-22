import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  configure,
  type Agent,
  type Harness,
  type ConversationId,
} from "@earendil-works/pi-durable";
import {
  SIDE_CHAT_TITLE_LIMIT,
  type SideChat,
  type UpdateSideChat,
} from "../../shared/side-chats";
import { sideChatScope } from "./background";
import type { SubagentRuntime } from "./subagents/runtime";
import { activeSubagentIds } from "./subagents/queries";
import {
  SideChatDoc,
  SideChatCreates,
  SideChatError,
  requireSideChat,
  sideChats,
  SIDE_CHAT_INSTRUCTIONS,
} from "./side-chats";

/** Side-chat product rules; Runtime supplies lifetime and conversation admission. */
export class SideChats {
  constructor(
    private readonly harness: Harness,
    private readonly workspace: string,
    private readonly children: SubagentRuntime,
    private readonly session: (
      id: ConversationId,
    ) => Promise<{ archive(operation: () => Promise<void>): Promise<void> }>,
    private readonly rootAgent: () => Promise<Agent>,
  ) {}
  async list() {
    return this.harness.commit((tx) => sideChats(tx), ctx);
  }
  async create(requestId: string, title: string): Promise<SideChat> {
    const rootAgent = await this.rootAgent();
    return this.harness.commit(async (tx) => {
      const request = await tx.doc(SideChatCreates, requestId, null);
      const existing = request.conversationId;
      if (existing !== null) {
        const found = await requireSideChat(tx, String(existing));
        return { id: String(found.id), ...found.metadata };
      }
      const created = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await configure(tx, created.id, {
        cwd: this.workspace,
        model: rootAgent.model,
        thinkingLevel: rootAgent.thinkingLevel,
        ...sideChatScope(rootAgent),
        instructions: SIDE_CHAT_INSTRUCTIONS,
      });
      const metadata = await tx.doc(SideChatDoc, created.id);
      metadata.title = validTitle(title);
      metadata.createdAt = Date.now();
      request.conversationId = Number(created.id);
      return { id: String(created.id), ...metadata };
    }, ctx);
  }
  async update(value: string, change: UpdateSideChat): Promise<SideChat> {
    const { id } = await this.harness.commit(
      (tx) => requireSideChat(tx, value),
      ctx,
    );
    const save = () =>
      this.harness.commit(async (tx) => {
        const { metadata } = await requireSideChat(tx, value);
        if (change.title !== undefined)
          metadata.title = validTitle(change.title);
        if (change.archived !== undefined)
          metadata.archivedAt = change.archived
            ? (metadata.archivedAt ?? Date.now())
            : null;
      }, ctx);
    // Archive and input admission use the SAME conversation gate, avoiding submit/archive races.
    if (change.archived === true)
      await (
        await this.session(id)
      ).archive(async () => {
        const jobs = await this.harness.commit(
          (tx) => activeSubagentIds(tx, id),
          ctx,
        );
        if (jobs.length) await this.children.stop(this.harness, id, jobs, ctx);
        await save();
      });
    else await save();
    return this.harness.commit(
      async (tx) => ({
        id: value,
        ...(await requireSideChat(tx, value)).metadata,
      }),
      ctx,
    );
  }
}
function validTitle(title: string) {
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.trim().length > SIDE_CHAT_TITLE_LIMIT
  )
    throw new SideChatError(
      `Title must contain 1–${SIDE_CHAT_TITLE_LIMIT} characters.`,
      422,
    );
  return title.trim();
}
