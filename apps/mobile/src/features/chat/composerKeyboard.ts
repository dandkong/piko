type BrowserDevice = { userAgent: string; maxTouchPoints: number };

export function isMobileWeb({ userAgent, maxTouchPoints }: BrowserDevice) {
  return /Android|iPhone|iPad|iPod/i.test(userAgent)
    || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
}

type EnterEvent = Pick<KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "keyCode" | "repeat" | "preventDefault"
>;

export function handleComposerKeyDown(event: EnterEvent, desktopWeb: boolean, canSend: boolean, send: () => void) {
  // keyCode 229 also covers browsers that end composition before its Enter keydown.
  if (!desktopWeb || event.key !== "Enter" || event.isComposing || event.keyCode === 229
    || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  if (canSend && !event.repeat) send();
}
