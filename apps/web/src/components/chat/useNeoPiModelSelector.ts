import type { NeoPiModelSelectorResult, ProviderInstanceId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useMemo, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { neopiModels } from "../neopi/modelsPageState";
import { nativeSelectorRequests, type NativeSelectorContext } from "./neopiModelSwitcher";

const EMPTY_RESULTS: ReadonlyMap<ProviderInstanceId, NeoPiModelSelectorResult> = new Map();

export function useNeoPiModelSelector(
  context: NativeSelectorContext,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  query: string,
) {
  const read = useAtomCommand(neopiModels.querySelector, { reportFailure: false });
  const { environmentId, projectId, connectedThread } = context;
  const threadId = connectedThread?.threadId;
  const threadInstanceId = connectedThread?.providerInstanceId;
  const request = useMemo(() => {
    const targetContext: NativeSelectorContext = {
      environmentId,
      ...(projectId ? { projectId } : {}),
      ...(threadId && threadInstanceId
        ? { connectedThread: { threadId, providerInstanceId: threadInstanceId } }
        : {}),
    };
    const requests = nativeSelectorRequests(targetContext, entries);
    return {
      key: JSON.stringify({ environmentId, requests, query }),
      environmentId,
      requests,
      query,
    };
  }, [environmentId, projectId, threadId, threadInstanceId, entries, query]);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    results: ReadonlyMap<ProviderInstanceId, NeoPiModelSelectorResult>;
    errors: ReadonlyArray<string>;
  } | null>(null);
  useEffect(() => {
    let current = true;
    const run = async () => {
      if (!request.environmentId) {
        if (current)
          setSnapshot({
            key: request.key,
            results: EMPTY_RESULTS,
            errors: ["Connect an environment to query native models."],
          });
        return;
      }
      const environmentId = request.environmentId;
      const responses = await Promise.all(
        request.requests.map(async ({ target, displayName }) => {
          try {
            const result = await read({ environmentId, input: { target, query: request.query } });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return {
              instanceId: target.providerInstanceId,
              value: result.value,
              error: result.value.error !== null ? `${displayName}: ${result.value.error}` : null,
            };
          } catch (cause) {
            return {
              instanceId: target.providerInstanceId,
              value: null,
              error: `${displayName}: ${cause instanceof Error ? cause.message : String(cause)}`,
            };
          }
        }),
      );
      if (!current) return;
      setSnapshot({
        key: request.key,
        results: new Map(
          responses.flatMap((response) =>
            response.value && !response.error
              ? [[response.instanceId, response.value] as const]
              : [],
          ),
        ),
        errors: responses.flatMap((response) => (response.error ? [response.error] : [])),
      });
    };
    void run();
    return () => {
      current = false;
    };
  }, [request, read]);
  const current = snapshot?.key === request.key ? snapshot : null;
  return {
    results: current?.results ?? EMPTY_RESULTS,
    errors: current?.errors ?? [],
    pending: current === null,
  };
}
