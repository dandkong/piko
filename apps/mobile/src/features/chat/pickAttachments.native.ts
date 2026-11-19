import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { MAX_ATTACHMENT_BYTES } from "../../../../../shared/chat";
import { LocalApiError } from "../../api/errors";
import type { PickedFile } from "./api";

/** Copy selected documents into the app cache so they remain readable for upload retries. */
export async function pickAttachments(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return result.assets.map(asset => {
    const bytes = new File(asset.uri);
    if ((asset.size ?? bytes.size) > MAX_ATTACHMENT_BYTES)
      throw new LocalApiError("chat.attachmentTooLarge", 413);
    return { name: asset.name, mime: asset.mimeType ?? "", bytes };
  });
}
