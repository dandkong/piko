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
import { setAgentResources, workspaceAgentResources } from "./agents/resources";
import type { StorageMaintenance } from "./storage-maintenance";
import {
  SideChatDoc,
  SideChatCreates,
  SideChatError,
  requireSideChat,
  sideChats,
  SIDE_CHAT_INSTRUCTIONS,
} from "./side-chats";
import { logInfo } from "../logging";

/** Side-chat product rules; Runtime supplies lifetime and conversation admission. */
export class SideChats {
  private deletionLine: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly harness: Harness,
    private readonly workspace: string,
    private readonly maintenance: StorageMaintenance,
    private readonly session: (
      id: ConversationId,
    ) => Promise<{ remove(operation: () => Promise<void>): Promise<void> }>,
    private readonly forget: (id: ConversationId) => Promise<void>,
    private readonly rootAgent: () => Promise<Agent>,
  ) {}
  async list() {
    return this.harness.commit(async tx => (await sideChats(tx))
      .filter(chat => chat.archivedAt === null)
      .map(({ id, title, createdAt }) => ({ id, title, createdAt })), ctx);
  }
  async create(requestId: string, title: string): Promise<SideChat> {
    const rootAgent = await this.rootAgent();
    const created = await this.harness.commit(async (tx) => {
      const request = await tx.doc(SideChatCreates, requestId, null);
      const existing = request.conversationId;
      if (existing !== null) {
        const found = await requireSideChat(tx, String(existing));
        return { id: String(found.id), title: found.metadata.title, createdAt: found.metadata.createdAt };
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
      await setAgentResources(tx, created.id, workspaceAgentResources(this.workspace));
      const metadata = await tx.doc(SideChatDoc, created.id);
      metadata.title = validTitle(title);
      metadata.createdAt = Date.now();
      request.conversationId = Number(created.id);
      return { id: String(created.id), title: metadata.title, createdAt: metadata.createdAt };
    }, ctx);
    logInfo("side_chat.create.completed", { conversationId: created.id });
    return created;
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
      }, ctx);
    await save();
    const updated = await this.harness.commit(
      async tx => {
        const { metadata } = await requireSideChat(tx, value);
        return { id: value, title: metadata.title, createdAt: metadata.createdAt };
      },
      ctx,
    );
    logInfo("side_chat.update.completed", { conversationId: updated.id });
    return updated;
  }
  remove(value: string): Promise<void> {
    const deletion = this.deletionLine.catch(() => {}).then(async () => {
      let plan;
      try {
        plan = await this.harness.commit(() => this.maintenance.planSideChat(value), ctx);
      } catch (error) {
        // Retrying a successful delete is safe, including a previous checkpoint failure.
        if (error instanceof SideChatError && error.status === 404 && /^[1-9]\d*$/.test(value) && Number(value) !== 1 &&
          Number.isSafeInteger(Number(value)) && !(await this.harness.conversation(Number(value) as ConversationId, ctx))) {
          await this.maintenance.compact(this.harness);
          return;
        }
        throw error;
      }
      // Re-plan after cancellation; finalizers may have created task documents.
      const purge = () => this.maintenance.erase(this.harness, value);
      const id = Number(value) as ConversationId;
      try {
        if (plan.retired) await purge(); // Finish an interrupted physical purge.
        else await (await this.session(id)).remove(purge);
      } finally {
        await this.forget(id);
      }
      await this.maintenance.compact(this.harness);
      logInfo("side_chat.delete.completed", { conversationId: value });
    });
    this.deletionLine = deletion;
    return deletion;
  }
  async close() { await this.deletionLine.catch(() => {}); }
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
