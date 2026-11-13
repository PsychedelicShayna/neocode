import { ComposerContextId, type ComposerContextRecord } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewAnnotationImage } from "./TimelineUserMessageRow.logic";

function annotation() {
  return {
    version: 1 as const,
    contextId: ComposerContextId.make("annotation-1"),
    kind: "preview-annotation" as const,
    label: "Checkout button",
    annotationId: "producer-id",
    pageUrl: "https://example.test/checkout",
    pageTitle: "Checkout",
    comment: "This changed after clicking",
    targetSummary: "1 selected element",
    styleChanges: [],
    screenshotContextId: ComposerContextId.make("screenshot-1"),
  };
}

describe("resolvePreviewAnnotationImage", () => {
  it("resolves the bound image before legacy name and position fallbacks", () => {
    const image = {
      type: "image" as const,
      id: "thread-1-screenshot",
      name: "capture.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const record = annotation();
    const screenshotRecord = {
      version: 1 as const,
      contextId: record.screenshotContextId,
      kind: "image" as const,
      label: image.name,
      attachmentId: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    };
    const legacyImage = { ...image, id: "legacy", name: "preview-annotation-producer-id.png" };

    expect(
      resolvePreviewAnnotationImage({
        record,
        recordsById: new Map<string, ComposerContextRecord>([
          [record.contextId, record],
          [screenshotRecord.contextId, screenshotRecord],
        ]),
        userImages: [legacyImage, image],
        previewImages: [legacyImage],
        annotationRecordIds: [record.contextId],
      }),
    ).toBe(image);
  });

  it("returns no image for an unresolved binding without a legacy fallback", () => {
    const record = annotation();
    expect(
      resolvePreviewAnnotationImage({
        record,
        recordsById: new Map(),
        userImages: [],
        previewImages: [],
        annotationRecordIds: [record.contextId],
      }),
    ).toBeNull();
  });
});
