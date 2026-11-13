import { Platform } from "react-native";
import type { PickedFile } from "./api";
import { ApiError } from "../../api/errors";

/** One picker for the shared UI; the native surface is not wired yet. */
export function pickAttachments(unavailableMessage = "附件上传目前仅在网页端可用。"): Promise<PickedFile[]> {
  if (Platform.OS !== "web" || typeof document === "undefined") {
    return Promise.reject(new ApiError(unavailableMessage, 0, "attachments_unavailable"));
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
