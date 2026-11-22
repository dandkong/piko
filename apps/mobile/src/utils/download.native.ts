import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { authHeaders } from "../api/client";

/** Share a temporary authenticated download; no credential is placed in its URL. */
export async function downloadFile(url: string): Promise<void> {
  const directory = new Directory(Paths.cache, `piko-download-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  directory.create();
  try {
    const file = await File.downloadFileAsync(url, directory, { headers: authHeaders(url) });
    if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing is unavailable.");
    await Sharing.shareAsync(file.uri);
  } finally { if (directory.exists) directory.delete(); }
}
