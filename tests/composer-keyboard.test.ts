import { describe, expect, test } from "bun:test";
import { handleComposerKeyDown } from "../apps/mobile/src/features/chat/composerKeyboard";

function press(overrides: Partial<KeyboardEvent> = {}, canSend = true) {
  let sends = 0;
  let prevented = false;
  handleComposerKeyDown({
    key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    isComposing: false, keyCode: 13, repeat: false, ...overrides,
    preventDefault: () => { prevented = true; },
  }, canSend, () => { sends++; });
  return { sends, prevented };
}

describe("composer keyboard", () => {
  test("web Enter sends once without inserting a newline on every device", () => {
    expect(press()).toEqual({ sends: 1, prevented: true });
  });
  test("modified Enter preserves the editor's default behavior", () => {
    for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"]) {
      expect(press({ [modifier]: true })).toEqual({ sends: 0, prevented: false });
    }
  });
  test("IME confirmation never sends or consumes the candidate selection", () => {
    expect(press({ isComposing: true })).toEqual({ sends: 0, prevented: false });
    expect(press({ isComposing: false, keyCode: 229 })).toEqual({ sends: 0, prevented: false });
  });
  test("unavailable sends and held Enter never trigger send or stop", () => {
    expect(press({}, false)).toEqual({ sends: 0, prevented: true });
    expect(press({ repeat: true })).toEqual({ sends: 0, prevented: true });
    expect(press({ key: "a" })).toEqual({ sends: 0, prevented: false });
  });
});
