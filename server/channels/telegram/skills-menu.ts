import type { RuntimeDescription } from "../../../shared/runtime";
import type { ConversationRuntime, WorkspaceRuntimeAccess, WorkspaceSkillDetail } from "../../runtime/types";
import { SUMMARY_TEXT_LIMIT, singleLine, truncateUtf16Text } from "../../runtime/text";
import type { TelegramKeyboard, TelegramTransport } from "./api";
import type { TelegramCallback } from "./menus";
import { TELEGRAM_BUTTON_LABEL_LIMIT, TELEGRAM_MENU_PAGE_SIZE } from "./menu-policy";
import { editTelegramRich, escapeTelegramMarkdown, sendTelegramRich, splitTelegramRichText } from "./rich-text";

type Skill = RuntimeDescription["skills"][number];
type Address = { chatId: string; messageId: string };
type Menu = Address & {
  token: string;
  createdAt: number;
  working: boolean;
  actions: Set<string>;
  skills: Skill[];
  extraMessageIds: string[];
};
type View = { text: string; buttons: TelegramKeyboard };

const MAX_MENUS = 64;
const MENU_TTL_MS = 15 * 60_000;

function sortedSkills(skills: Skill[]): Skill[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

function pageKey(token: string, page: number): string {
  return `k:${token}:list:${page.toString(36)}`;
}

function skillKey(token: string, index: number, page: number): string {
  return `k:${token}:skill:${index}:${page.toString(36)}`;
}

function skillBody(value: string): string {
  return value.trim() || "(empty skill body)";
}

function listView(menu: Menu, skills: Skill[], requestedPage: number): View {
  const pages = Math.max(1, Math.ceil(skills.length / TELEGRAM_MENU_PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const start = page * TELEGRAM_MENU_PAGE_SIZE;
  const visible = skills.slice(start, start + TELEGRAM_MENU_PAGE_SIZE);
  if (!skills.length) return { text: "**Skills**\n\nNo skills available.", buttons: [] };

  const buttons: TelegramKeyboard = visible.map((skill, offset) => {
    const index = start + offset;
    return [{
      text: truncateUtf16Text(singleLine(skill.name, TELEGRAM_BUTTON_LABEL_LIMIT) ?? "Skill", TELEGRAM_BUTTON_LABEL_LIMIT),
      callbackData: skillKey(menu.token, index, page),
    }];
  });
  if (pages > 1) {
    const navigation: TelegramKeyboard[number] = [];
    if (page > 0) navigation.push({ text: "‹ Previous", callbackData: pageKey(menu.token, page - 1) });
    if (page < pages - 1) navigation.push({ text: "Next ›", callbackData: pageKey(menu.token, page + 1) });
    buttons.push(navigation);
  }
  const lines = [
    `**Skills · Page ${page + 1}**`,
    "",
    ...visible.map((skill, offset) => `${offset + 1}. **${escapeTelegramMarkdown(skill.name)}** — ${escapeTelegramMarkdown(
      singleLine(skill.description?.trim() || "(no description)", SUMMARY_TEXT_LIMIT) ?? "(no description)",
    )}`),
    "",
    "Select a skill below.",
  ];
  return { text: lines.join("\n"), buttons };
}

function detailText(skill: WorkspaceSkillDetail): string {
  return [
    `**Skill · ${escapeTelegramMarkdown(skill.name)}**`,
    "",
    escapeTelegramMarkdown(skill.description),
    "",
    skillBody(skill.body),
    ...(skill.disableModelInvocation ? ["", "Not included in the assistant skill index."] : []),
  ].join("\n");
}

/** Ephemeral, source-bound browser for the current skill catalog. */
export class TelegramSkillMenus {
  private readonly menus = new Map<string, Menu>();

  constructor(private readonly runtime: Pick<ConversationRuntime, "describe"> & Pick<WorkspaceRuntimeAccess, "skill">, private readonly api: TelegramTransport) {}

  async open(address: { chatId: string }): Promise<void> {
    const skills = sortedSkills((await this.runtime.describe()).skills);
    const menu: Menu = {
      ...address,
      messageId: "",
      token: crypto.randomUUID().slice(0, 12),
      createdAt: Date.now(),
      working: false,
      actions: new Set(),
      skills,
      extraMessageIds: [],
    };
    const view = listView(menu, skills, 0);
    menu.messageId = await sendTelegramRich(this.api, address.chatId, view.text, view.buttons);
    menu.actions = new Set(view.buttons.flat().map(button => button.callbackData));
    if (menu.actions.size) {
      this.menus.set(menu.token, menu);
      this.prune();
    }
  }

  private prune(): void {
    for (const [token, menu] of this.menus)
      if (Date.now() - menu.createdAt > MENU_TTL_MS) this.menus.delete(token);
    while (this.menus.size > MAX_MENUS) this.menus.delete(this.menus.keys().next().value!);
  }

  private async removeContinuationMessages(menu: Menu) {
    const ids = menu.extraMessageIds.splice(0);
    await Promise.all(ids.map(id => this.api.remove(menu.chatId, id).catch(() => {})));
  }

  private async editList(menu: Menu, skills: Skill[], page: number): Promise<void> {
    await this.removeContinuationMessages(menu);
    const view = listView(menu, skills, page);
    await editTelegramRich(this.api, menu.chatId, menu.messageId, view.text, view.buttons);
    menu.skills = skills;
    menu.actions = new Set(view.buttons.flat().map(button => button.callbackData));
  }

  private async editSkillDetail(menu: Menu, skill: WorkspaceSkillDetail, page: number): Promise<void> {
    await this.removeContinuationMessages(menu);
    const chunks = splitTelegramRichText(detailText(skill));
    const back = pageKey(menu.token, page);
    const buttons: TelegramKeyboard = [[{ text: "‹ Back to skills", callbackData: back }]];
    await editTelegramRich(this.api, menu.chatId, menu.messageId, chunks[0]!, buttons);
    menu.actions = new Set([back]);
    try {
      for (const chunk of chunks.slice(1)) menu.extraMessageIds.push(await sendTelegramRich(this.api, menu.chatId, chunk));
    } catch (error) {
      await this.removeContinuationMessages(menu);
      const skills = sortedSkills((await this.runtime.describe()).skills);
      await this.editList(menu, skills, page);
      throw error;
    }
  }

  async handle(callback: TelegramCallback): Promise<void> {
    this.prune();
    const match = /^k:([\da-f-]{12}):(list:([0-9a-z]+)|skill:(\d+):([0-9a-z]+))$/.exec(callback.data);
    const menu = match && this.menus.get(match[1]!);
    if (!menu || menu.chatId !== callback.chatId || menu.messageId !== callback.messageId || !menu.actions.has(callback.data)) {
      await this.api.answerCallback(callback.callbackId, "Menu expired. Reopen /skills.", false);
      return;
    }
    if (menu.working) {
      await this.api.answerCallback(callback.callbackId, "One moment…");
      return;
    }

    menu.working = true;
    try {
      const action = match![2]!.startsWith("list:") ? "list" : "skill";
      const page = Number.parseInt(action === "list" ? match![3]! : match![5]!, 36);
      if (action === "list") {
        const skills = sortedSkills((await this.runtime.describe()).skills);
        await this.editList(menu, skills, page);
      } else {
        const index = Number.parseInt(match![4]!, 10);
        const previous = menu.skills[index];
        const skill = previous && await this.runtime.skill(previous.name);
        if (!skill) {
          const skills = sortedSkills((await this.runtime.describe()).skills);
          await this.editList(menu, skills, page);
          await this.api.answerCallback(callback.callbackId, "Skill unavailable. List refreshed.", false);
          return;
        }
        await this.editSkillDetail(menu, skill, page);
      }
      await this.api.answerCallback(callback.callbackId);
    } catch {
      await this.api.answerCallback(callback.callbackId, "Couldn't refresh /skills. Try again.", false);
    } finally {
      menu.working = false;
    }
  }
}
