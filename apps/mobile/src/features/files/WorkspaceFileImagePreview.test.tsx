import { act, useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  image: null as null | { onError: (event: { nativeEvent: { error: string } }) => void },
  opener: null as null | { disabled: boolean; onPress: () => void },
  failure: null as null | { detail: string; onAction: () => void },
  previewUri: null as string | null,
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => children,
  Pressable: (props: NonNullable<typeof state.opener> & { children: ReactNode }) => {
    state.opener = props;
    return props.children;
  },
  Image: (props: NonNullable<typeof state.image>) => {
    state.image = props;
    return null;
  },
}));
vi.mock("./FilePreviewFeedback", () => ({ FilePreviewLoading: () => null }));
vi.mock("../../components/EmptyState", () => ({
  EmptyState: (props: NonNullable<typeof state.failure>) => {
    useLayoutEffect(() => {
      state.failure = props;
      return () => {
        state.failure = null;
      };
    }, [props]);
    return null;
  },
}));
vi.mock("../../components/FilePreviewModal", () => ({
  FilePreviewModal: ({ source }: { source: { uri: string } | null }) => {
    state.previewUri = source?.uri ?? null;
    return null;
  },
}));
vi.mock("../../components/NativePresentation", () => ({
  PresentationSource: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/mediaActions", () => ({ useMediaActions: () => ({ actions: [] }) }));
vi.mock("../../components/MediaActionsMenu", () => ({
  MediaActionsMenu: ({ children }: { children: ReactNode }) => children,
}));

import { WorkspaceFileImagePreview } from "./WorkspaceFileImagePreview";

afterEach(() => vi.unstubAllGlobals());

describe("workspace image load recovery", () => {
  it.each(["The URL has expired.", ""])(
    "recovers a native image failure after a signed-URL refresh and remount (%s)",
    async (error) => {
      const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
      const container = {
        nodeType: 1,
        tagName: "DIV",
        namespaceURI: "http://www.w3.org/1999/xhtml",
        ownerDocument: document,
        addEventListener() {},
        removeEventListener() {},
      };
      vi.stubGlobal("document", document);
      vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const root = createRoot(container as unknown as HTMLElement);
      let finishRefresh: (() => void) | undefined;
      let refreshes = 0;
      const uri = "https://environment.example/api/assets/image";
      function FileScreen() {
        const [revision, setRevision] = useState(0);
        const retry = () => {
          refreshes += 1;
          finishRefresh = () => setRevision((current) => current + 1);
        };
        return (
          <WorkspaceFileImagePreview
            key={revision}
            accessibilityLabel="image.png"
            uri={uri}
            onRetry={retry}
          />
        );
      }
      try {
        await act(() => root.render(<FileScreen />));
        expect(state.failure).toBeNull();
        expect(state.opener?.disabled).toBe(false);

        await act(() => state.image?.onError({ nativeEvent: { error } }));
        expect(state.failure?.detail).toBe(error || "The image could not be rendered.");
        expect(state.opener?.disabled).toBe(true);
        expect(state.previewUri).toBeNull();

        await act(() => state.failure?.onAction());
        expect(refreshes).toBe(1);
        // The URL service may reissue the same URL; the screen revision must still
        // discard the failed native Image and its disabled full-screen opener.
        await act(() => finishRefresh?.());
        expect(state.failure).toBeNull();
        expect(state.opener?.disabled).toBe(false);
        await act(() => state.opener?.onPress());
        expect(state.previewUri).toBe(uri);
      } finally {
        await act(() => root.unmount());
      }
    },
  );
});
