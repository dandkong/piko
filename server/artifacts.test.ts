import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts";
import { artifactRequest } from "./artifacts/http";

test("artifact downloads use MIME database without changing preview or file bytes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "piko-artifact-mime-test-"));
  try {
    const directory = join(workspace, "artifacts");
    await mkdir(directory);
    const text = Buffer.from("\uFEFF# Example\n");
    await writeFile(join(directory, "report.md"), text);
    await writeFile(join(directory, "book.epub"), "epub content");
    await writeFile(join(directory, "unknown.zzztest"), "unknown content");
    await writeFile(join(directory, "events.jsonl"), '{"ok":true}\n');
    const store = new ArtifactStore(workspace);
    const response = await artifactRequest(new Request("http://localhost/api/artifacts/download?path=report.md"), store);
    expect(response?.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response?.headers.get("content-disposition")).toStartWith("attachment");
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(text);
    expect((await store.preview("report.md")).content).toBe("# Example\n");
    expect((await store.download("book.epub")).mimeType).toBe("application/epub+zip");
    expect((await store.download("unknown.zzztest")).mimeType).toBe("application/octet-stream");
    // Preview support is independent of the library's MIME database.
    expect((await store.preview("events.jsonl")).preview).toBe("text");
    expect((await store.download("events.jsonl")).mimeType).toBe("application/octet-stream");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
