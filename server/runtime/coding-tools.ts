import { CodingTools, createCodingTools } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";

export type CodingExtension = ReturnType<typeof createCodingTools>;

/**
 * `read` returns text or one image. With a Photon processor it orients, converts and shrinks images to the model's
 * image limits; without one, supported images within the inline limits still pass through as they are.
 */
export async function createPikoCodingTools(): Promise<CodingExtension> {
  try {
    return createCodingTools({ images: await createNodePhotonImages() });
  } catch (error) {
    console.warn("Piko image processor unavailable; only images within inline limits are readable.",
      error instanceof Error ? error.message : "unknown error");
    return CodingTools;
  }
}

/** Memory review edits files directly; a shell is not needed to maintain two Markdown paths. */
export function curatorTools(coding: CodingExtension) {
  return (coding.tools ?? []).filter(tool => tool.name !== "bash");
}
