import { sha256 } from "@noble/hashes/sha2";
import type { NeoPiNativeSessionRef } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";

/** Resource IDs reach terminal history filenames; canonical paths must not. */
export function nativeWorkspaceResourceId(ref: NeoPiNativeSessionRef): string {
  const identity = JSON.stringify([ref.providerInstanceId, ref.sessionFile]);
  return `native:${Base64Url.encode(sha256(new TextEncoder().encode(identity)))}`;
}
