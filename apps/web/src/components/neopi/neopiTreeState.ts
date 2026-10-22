import type { NeoPiNavigateTreeResult } from "@t3tools/contracts";
import { nativeIdentityKey, type NativeIdentity } from "@t3tools/client-runtime/neopi-conversation";
import { useCallback } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { NativeAskAnswer } from "@t3tools/client-runtime/neopi-tree";

export interface NativeAnswerImage {
  readonly [key: string]: unknown;
  type: "image";
  data: string;
  mimeType: string;
}
interface NativeTreeDraft {
  summarize: boolean;
  instructions: string;
  message: string | null;
  result: NeoPiNavigateTreeResult | null;
  resumeResult: NeoPiNavigateTreeResult | null;
  answers: Record<string, NativeAskAnswer>;
  images: NativeAnswerImage[];
}
const empty: NativeTreeDraft = {
  summarize: false,
  instructions: "",
  message: null,
  result: null,
  answers: {},
  images: [],
  resumeResult: null,
};
export const useNativeTreeDraftStore = create(
  persist<{ drafts: Record<string, NativeTreeDraft> }>(() => ({ drafts: {} }), {
    name: "neocode:native-tree-drafts:v1",
  }),
);

export const nativeTreeSessionKey = (environmentId: string, identity: NativeIdentity | null) =>
  JSON.stringify([environmentId, identity ? nativeIdentityKey(identity) : null]);

/** Preserve reopened asks and unacknowledged tokens when the tree panel closes. */
export function useNativeTreeField<K extends keyof NativeTreeDraft>(key: string, field: K) {
  const value = useNativeTreeDraftStore((state) => state.drafts[key]?.[field] ?? empty[field]);
  const set = useCallback(
    (next: NativeTreeDraft[K] | ((previous: NativeTreeDraft[K]) => NativeTreeDraft[K])) => {
      useNativeTreeDraftStore.setState((state) => {
        const current = state.drafts[key] ?? empty;
        const value = typeof next === "function" ? next(current[field]) : next;
        return { drafts: { ...state.drafts, [key]: { ...current, [field]: value } } };
      });
    },
    [key, field],
  );
  return [value, set] as const;
}
