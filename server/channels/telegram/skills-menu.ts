import type { RuntimeDescription } from "../../../shared/runtime";
import type { ChatRuntime } from "../../runtime/types";
import { LONG_TEXT_LIMIT, SUMMARY_TEXT_LIMIT, DETAIL_TEXT_LIMIT, singleLine, truncateUtf16Text } from "../../runtime/text";
import type { TelegramKeyboard, TelegramTransport } from "./api";
import type { TelegramCallback } from "./menus";
import { TELEGRAM_BUTTON_LABEL_LIMIT, TELEGRAM_MENU_PAGE_SIZE } from "./menu-policy";

type Skill = RuntimeDescription["skills"][number];
type Address = { chatId: string; messageId: string };
type Menu = Address & {
  token: string;
  createdAt: number;
  working: boolean;
  actions: Set<string>;
  skills: Skill[];
};
type View = { text: string; buttons?: TelegramKeyboard };

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

function detailDescription(value: string): string {
  const text = value.trim();
  const note = "\n\n[Description shortened for Telegram.]";
  return truncateUtf16Text(text, LONG_TEXT_LIMIT, note) || "(no description)";
}

function listView(menu: Menu, skills: Skill[], requestedPage: number): View {
  const pages = Math.max(1, Math.ceil(skills.length / TELEGRAM_MENU_PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const start = page * TELEGRAM_MENU_PAGE_SIZE;
  const visible = skills.slice(start, start + TELEGRAM_MENU_PAGE_SIZE);
  if (!skills.length) return { text: "Skills\nNo skills available." };

  const lines = [
    `Skills · ${skills.length}${pages > 1 ? ` · Page ${page + 1}/${pages}` : ""}`,
    "Choose a skill to view its description:",
    "",
    ...visible.map(skill => singleLine(
      `${skill.name} — ${skill.description?.trim() || "(no description)"}`,
      SUMMARY_TEXT_LIMIT,
    )!),
  ];
  const buttons: TelegramKeyboard = [];
  for (let index = 0; index < visible.length; index += 2) {
    buttons.push(visible.slice(index, index + 2).map((skill, offset) => {
      const absoluteIndex = start + index + offset;
      return {
        text: singleLine(skill.name, TELEGRAM_BUTTON_LABEL_LIMIT) ?? "Skill",
        callbackData: skillKey(menu.token, absoluteIndex, page),
      };
    }));
  }
  if (pages > 1) {
    const navigation: TelegramKeyboard[number] = [];
    if (page > 0) navigation.push({ text: "‹ Previous", callbackData: pageKey(menu.token, page - 1) });
    if (page < pages - 1) navigation.push({ text: "Next ›", callbackData: pageKey(menu.token, page + 1) });
    buttons.push(navigation);
  }
  return { text: lines.join("\n"), buttons };
}

function detailView(menu: Menu, skill: Skill, page: number): View {
  return {
    text: [
      `Skill · ${singleLine(skill.name, DETAIL_TEXT_LIMIT) ?? "Skill"}`,
      "",
      detailDescription(skill.description),
      ...(skill.disableModelInvocation ? ["", "Not included in the assistant skill index."] : []),
    ].join("\n"),
    buttons: [[{ text: "Back to skills", callbackData: pageKey(menu.token, page) }]],
  };
}

/** Ephemeral, source-bound browser for the current skill catalog. */
export class TelegramSkillMenus {
  private readonly menus = new Map<string, Menu>();

  constructor(private readonly runtime: Pick<ChatRuntime, "describe">, private readonly api: TelegramTransport) {}

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
    };
    const view = listView(menu, skills, 0);
    menu.messageId = await this.api.send(address.chatId, view.text, false, view.buttons);
    menu.actions = new Set(view.buttons?.flat().map(button => button.callbackData) ?? []);
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

  private async editList(menu: Menu, skills: Skill[], page: number): Promise<void> {
    const view = listView(menu, skills, page);
    await this.api.edit(menu.chatId, menu.messageId, view.text, false, view.buttons);
    menu.skills = skills;
    menu.actions = new Set(view.buttons?.flat().map(button => button.callbackData) ?? []);
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
      const skills = sortedSkills((await this.runtime.describe()).skills);
      if (action === "list") {
        await this.editList(menu, skills, page);
      } else {
        const index = Number.parseInt(match![4]!, 10);
        const previous = menu.skills[index];
        const skill = previous && skills.find(item => item.name === previous.name);
        if (!skill) {
          await this.editList(menu, skills, page);
          await this.api.answerCallback(callback.callbackId, "Skill unavailable. List refreshed.", false);
          return;
        }
        const view = detailView(menu, skill, page);
        await this.api.edit(menu.chatId, menu.messageId, view.text, false, view.buttons);
        menu.skills = skills;
        menu.actions = new Set(view.buttons?.flat().map(button => button.callbackData) ?? []);
      }
      await this.api.answerCallback(callback.callbackId);
    } catch {
      await this.api.answerCallback(callback.callbackId, "Couldn't refresh /skills. Try again.", false);
    } finally {
      menu.working = false;
    }
  }
}
