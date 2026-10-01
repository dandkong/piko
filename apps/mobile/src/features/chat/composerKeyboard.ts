type EnterEvent = Pick<KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "keyCode" | "repeat" | "preventDefault"
>;

export function handleComposerKeyDown(event: EnterEvent, canSend: boolean, send: () => void) {
  // keyCode 229 also covers browsers that end composition before its Enter keydown.
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229
    || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  if (canSend && !event.repeat) send();
}
