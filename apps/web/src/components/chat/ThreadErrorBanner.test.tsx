import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  getThreadErrorBannerMessage,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("getThreadErrorBannerMessage", () => {
  it("extracts a readable nested message without trimming its whitespace", () => {
    const message =
      "  This model is not supported with a ChatGPT account.\nChoose another model.  ";
    const error = ` \n${JSON.stringify({ error: { message, code: "unsupported_model" } })}\t `;

    expect(getThreadErrorBannerMessage(error)).toBe(message);
  });

  it("keeps the diagnostics when the nested message is blank", () => {
    const error = JSON.stringify({ error: { message: " \n\t ", code: "unsupported_model" } });

    expect(getThreadErrorBannerMessage(error)).toBe(error);
  });
});

describe("ThreadErrorBanner", () => {
  it("stays hidden after its current error is dismissed", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-a", "Aborted", "failure-1");
    dismissThreadErrorBannerForSession(bannerKey);
    expect(
      shouldShowThreadErrorBanner("Aborted", isThreadErrorBannerDismissedForSession(bannerKey)),
    ).toBe(false);
  });

  it("reappears when a new error arrives on the same thread", () => {
    dismissThreadErrorBannerForSession(
      getThreadErrorBannerKey("env:new-error", "Turn failed", "failure-1"),
    );
    const newErrorKey = getThreadErrorBannerKey("env:new-error", "Provider crashed", "failure-2");
    expect(
      shouldShowThreadErrorBanner(
        "Provider crashed",
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });

  it("reappears for different diagnostics with the same headline on the same thread", () => {
    const firstError = JSON.stringify({ error: { message: "Turn failed", code: "first" } });
    const secondError = JSON.stringify({ error: { message: "Turn failed", code: "second" } });
    const dismissedKey = getThreadErrorBannerKey("env:thread-b", firstError, "same-occurrence");
    dismissThreadErrorBannerForSession(dismissedKey);
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", secondError, "same-occurrence");

    expect(isThreadErrorBannerDismissedForSession(dismissedKey)).toBe(true);
    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(secondError, isThreadErrorBannerDismissedForSession(newErrorKey)),
    ).toBe(true);
  });

  it("scopes dismissals to the thread that dismissed them", () => {
    dismissThreadErrorBannerForSession(
      getThreadErrorBannerKey("env:thread-c", "Aborted", "failure-1"),
    );
    const otherThreadKey = getThreadErrorBannerKey("env:other-thread", "Aborted", "failure-1");

    expect(isThreadErrorBannerDismissedForSession(otherThreadKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "Aborted",
        isThreadErrorBannerDismissedForSession(otherThreadKey),
      ),
    ).toBe(true);
  });

  it("keeps a dismissal across visiting threads with no error", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-d", "Aborted", "failure-1");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(shouldShowThreadErrorBanner(null, false)).toBe(false);
    expect(isThreadErrorBannerDismissedForSession(bannerKey)).toBe(true);
    expect(
      shouldShowThreadErrorBanner("Aborted", isThreadErrorBannerDismissedForSession(bannerKey)),
    ).toBe(false);
  });

  it("never shows a null error", () => {
    expect(shouldShowThreadErrorBanner(null, false)).toBe(false);
  });

  it.each(["local:101", "server:2026-11-05T01:00:00.000Z"])(
    "shows a later identical failure after dismissing occurrence %s",
    (occurrence) => {
      const threadKey = `env:repeat-${occurrence}`;
      const oldKey = getThreadErrorBannerKey(threadKey, "Connection lost", occurrence);
      dismissThreadErrorBannerForSession(oldKey);
      expect(
        shouldShowThreadErrorBanner(
          "Connection lost",
          isThreadErrorBannerDismissedForSession(oldKey),
        ),
      ).toBe(false);
      expect(shouldShowThreadErrorBanner(null, false)).toBe(false);

      const nextKey = getThreadErrorBannerKey(threadKey, "Connection lost", `${occurrence}:next`);
      expect(
        shouldShowThreadErrorBanner(
          "Connection lost",
          isThreadErrorBannerDismissedForSession(nextKey),
        ),
      ).toBe(true);
      // Revisiting the original occurrence still does not resurrect it.
      expect(isThreadErrorBannerDismissedForSession(oldKey)).toBe(true);
    },
  );
});
