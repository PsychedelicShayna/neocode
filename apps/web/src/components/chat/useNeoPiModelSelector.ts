import type { NeoPiModelSelectorResult, ProviderInstanceId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useMemo, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { neopiModels } from "../neopi/modelsPageState";
import { nativeSelectorRequests, type NativeSelectorContext } from "./neopiModelSwitcher";

const EMPTY_RESULTS: ReadonlyMap<ProviderInstanceId, NeoPiModelSelectorResult> = new Map();
/** Typing settles for this long before NeoPi is asked to rank; clearing the query is immediate. */
export const NATIVE_QUERY_DEBOUNCE_MS = 150;

/**
 * Each instance publishes independently; `pending` stays true until all have answered.
 * `hasResponse` exposes partial answers for the typed query. Older queries are discarded.
 */
export function useNeoPiModelSelector(
  context: NativeSelectorContext,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  typedQuery: string,
) {
  const [settledQuery, setSettledQuery] = useState(typedQuery);
  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(typedQuery), NATIVE_QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typedQuery]);
  const query = typedQuery === "" ? "" : settledQuery;
  const read = useAtomCommand(neopiModels.querySelector, { reportFailure: false });
  const { environmentId, projectId, connectedThread, connectedSession } = context;
  const threadId = connectedThread?.threadId;
  const threadInstanceId = connectedThread?.providerInstanceId;
  const sessionFile = connectedSession?.sessionFile;
  const sessionInstanceId = connectedSession?.providerInstanceId;
  const request = useMemo(() => {
    const targetContext: NativeSelectorContext = {
      environmentId,
      ...(projectId ? { projectId } : {}),
      ...(threadId && threadInstanceId
        ? { connectedThread: { threadId, providerInstanceId: threadInstanceId } }
        : {}),
      ...(sessionFile && sessionInstanceId
        ? { connectedSession: { sessionFile, providerInstanceId: sessionInstanceId } }
        : {}),
    };
    const requests = nativeSelectorRequests(targetContext, entries);
    return {
      key: JSON.stringify({ environmentId, requests, query }),
      scopeKey: JSON.stringify({ environmentId, requests }),
      environmentId,
      requests,
      query,
    };
  }, [
    environmentId,
    projectId,
    threadId,
    threadInstanceId,
    sessionFile,
    sessionInstanceId,
    entries,
    query,
  ]);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    results: ReadonlyMap<ProviderInstanceId, NeoPiModelSelectorResult>;
    errors: ReadonlyArray<string>;
    pending: boolean;
  } | null>(null);
  useEffect(() => {
    let current = true;
    if (!request.environmentId) {
      setSnapshot({
        key: request.key,
        results: EMPTY_RESULTS,
        errors: ["Connect an environment to query native models."],
        pending: false,
      });
      return;
    }
    const environmentId = request.environmentId;
    const results = new Map<ProviderInstanceId, NeoPiModelSelectorResult>();
    const errors = new Map<ProviderInstanceId, string>();
    let remaining = request.requests.length;
    const publish = () => {
      if (!current) return;
      setSnapshot({
        key: request.key,
        results: new Map(
          request.requests.flatMap(({ target }) => {
            const value = results.get(target.providerInstanceId);
            return value ? [[target.providerInstanceId, value] as const] : [];
          }),
        ),
        errors: request.requests.flatMap(({ target }) => {
          const error = errors.get(target.providerInstanceId);
          return error ? [error] : [];
        }),
        pending: remaining > 0,
      });
    };
    if (remaining === 0) publish();
    for (const { target, displayName } of request.requests) {
      void (async () => {
        try {
          const result = await read({ environmentId, input: { target, query: request.query } });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          if (result.value.error !== null)
            errors.set(target.providerInstanceId, `${displayName}: ${result.value.error}`);
          else results.set(target.providerInstanceId, result.value);
        } catch (cause) {
          errors.set(
            target.providerInstanceId,
            `${displayName}: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
        remaining--;
        publish();
      })();
    }
    return () => {
      current = false;
    };
  }, [request, read]);
  const current = snapshot?.key === request.key && query === typedQuery ? snapshot : null;
  return {
    results: current?.results ?? EMPTY_RESULTS,
    errors: current?.errors ?? [],
    pending: current?.pending ?? true,
    hasResponse: current !== null,
    scopeKey: request.scopeKey,
  };
}
