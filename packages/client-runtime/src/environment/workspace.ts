import {
  EnvironmentId,
  NeoPiNativeSessionRef,
  type AssetResource,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { nativeWorkspaceResourceId } from "@t3tools/shared/neopiWorkspace";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { NativeSessionTarget } from "../neopiNativeSessions.ts";
import { parseScopedThreadKey } from "./scoped.ts";

/** A workspace owns tool-panel metadata, never the conversation or its execution. */
export type WorkspaceRef = ScopedThreadRef | NativeSessionTarget;

const nativePrefix = "native:";
const decodeNativeResource = Schema.decodeUnknownOption(
  Schema.fromJsonString(NeoPiNativeSessionRef),
);

/** Existing terminal/preview wire fields named threadId are resource namespaces, not SQL keys. */
export function workspaceResourceId(target: WorkspaceRef): string {
  return "threadId" in target ? target.threadId : nativeWorkspaceResourceId(target.ref);
}

export function workspaceKey(target: WorkspaceRef): string {
  const localId =
    "threadId" in target
      ? target.threadId
      : nativePrefix +
        JSON.stringify({
          providerInstanceId: target.ref.providerInstanceId,
          sessionFile: target.ref.sessionFile,
        });
  return `${target.environmentId}:${localId}`;
}

export function parseWorkspaceKey(key: string): WorkspaceRef | null {
  const marker = `:${nativePrefix}`;
  const separator = key.indexOf(marker);
  if (separator < 0) return parseScopedThreadKey(key);
  if (separator === 0) return null;
  const decoded = decodeNativeResource(key.slice(separator + marker.length));
  if (Option.isNone(decoded)) return null;
  return { environmentId: EnvironmentId.make(key.slice(0, separator)), ref: decoded.value };
}

export function workspaceFileResource(
  target: WorkspaceRef,
  path: string,
  kind: "workspace-file" | "media-file",
): Extract<
  AssetResource,
  { _tag: "workspace-file" | "media-file" | "native-workspace-file" | "native-media-file" }
> {
  return "threadId" in target
    ? { _tag: kind, threadId: target.threadId, path }
    : {
        _tag: kind === "workspace-file" ? "native-workspace-file" : "native-media-file",
        ref: target.ref,
        path,
      };
}
