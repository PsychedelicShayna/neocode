// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { Sheet, SheetPopup } from "~/components/ui/sheet";
import { isModalSurfaceOpen } from "./exLineFocus";

describe("whether a modal holds the keyboard from the Ex line", () => {
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  // The narrow window's right panel: a sheet that stays mounted while closed.
  const panelSheet = (open: boolean) => (
    <Sheet open={open}>
      <SheetPopup keepMounted showCloseButton={false} transitionDurationMs={0}>
        panel
      </SheetPopup>
    </Sheet>
  );

  it("does not count the closed panel sheet that stays in the page", async () => {
    await act(async () => root.render(panelSheet(false)));
    expect(document.querySelector('[data-slot="sheet-popup"]')).not.toBeNull();
    expect(isModalSurfaceOpen()).toBe(false);
  });

  it("counts the panel sheet once it is open", async () => {
    await act(async () => root.render(panelSheet(true)));
    expect(isModalSurfaceOpen()).toBe(true);
  });

  it("counts an open dialog", async () => {
    await act(async () =>
      root.render(
        <Dialog open>
          <DialogPopup>dialog</DialogPopup>
        </Dialog>,
      ),
    );
    expect(isModalSurfaceOpen()).toBe(true);
  });
});
