import type { PickedFile } from "./api";
import { ApiError } from "../../api/errors";

/** Web retains its browser-native file input; native uses pickAttachments.native.ts. */
export function pickAttachments(): Promise<PickedFile[]> {
  if (typeof document === "undefined") {
    return Promise.reject(new ApiError("File selection is unavailable.", 0, "attachments_unavailable"));
  }
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    const done = (files: PickedFile[]) => { input.remove(); resolve(files); };
    input.onchange = () => done(Array.from(input.files ?? []).map(file => ({ name: file.name, mime: file.type, bytes: file })));
    input.addEventListener("cancel", () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}
