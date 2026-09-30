import { describe, expect, test } from "bun:test";
import { handleComposerKeyDown, isMobileWeb } from "../apps/mobile/src/features/chat/composerKeyboard";

function press(overrides: Partial<KeyboardEvent> = {}, desktopWeb = true, canSend = true) {
  let sends = 0;
  let prevented = false;
  handleComposerKeyDown({
    key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    isComposing: false, keyCode: 13, repeat: false, ...overrides,
    preventDefault: () => { prevented = true; },
  }, desktopWeb, canSend, () => { sends++; });
  return { sends, prevented };
}

describe("composer keyboard", () => {
  test("desktop Enter sends once without inserting a newline", () => {
    expect(press()).toEqual({ sends: 1, prevented: true });
  });
  test("modified Enter and mobile Enter preserve the editor's default behavior", () => {
    for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"]) {
      expect(press({ [modifier]: true })).toEqual({ sends: 0, prevented: false });
    }
    expect(press({}, false)).toEqual({ sends: 0, prevented: false });
  });
  test("IME confirmation never sends or consumes the candidate selection", () => {
    expect(press({ isComposing: true })).toEqual({ sends: 0, prevented: false });
    expect(press({ isComposing: false, keyCode: 229 })).toEqual({ sends: 0, prevented: false });
  });
  test("unavailable sends and held Enter never trigger send or stop", () => {
    expect(press({}, true, false)).toEqual({ sends: 0, prevented: true });
    expect(press({ repeat: true })).toEqual({ sends: 0, prevented: true });
    expect(press({ key: "a" })).toEqual({ sends: 0, prevented: false });
  });
  test("mobile web detection includes iPad desktop UA but permits touch laptops", () => {
    for (const userAgent of ["Android", "iPhone", "iPad", "iPod", "Mozilla/5.0 (Macintosh; Intel Mac OS X)"]) {
      expect(isMobileWeb({ userAgent, maxTouchPoints: 5 })).toBe(true);
    }
    expect(isMobileWeb({ userAgent: "Windows NT 10.0", maxTouchPoints: 10 })).toBe(false);
    expect(isMobileWeb({ userAgent: "Macintosh; Intel Mac OS X", maxTouchPoints: 0 })).toBe(false);
  });
});
