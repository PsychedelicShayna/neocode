import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./ThreadErrorBanner";

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
      getThreadErrorBannerKey("env:thread-b", "Turn failed", "failure-1"),
    );
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", "Provider crashed", "failure-2");

    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "Provider crashed",
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
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
  it("aligns the warning and dismiss icons with the first line of a multi-line error", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={"The first error line\ncontinues on a second line"}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss error"');
    expect(markup).not.toContain("controlAlignment");
    expect(markup).toContain("flex gap-2 items-start");
    expect(markup).toContain("min-h-7 pt-1 sm:min-h-6 sm:pt-0.5");
    expect(markup).toContain("h-lh w-4");
    expect(markup).toContain("h-lh self-start");
  });
});
