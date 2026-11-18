// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  emptyNativeSessionFeed,
  nativeSessionKey,
  type NativeSessionFeed,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { afterEach, expect, it, vi } from "vite-plus/test";

const demand = vi.hoisted(() => ({
  held: [] as unknown[][],
  released: 0,
}));
vi.mock("../../../state/neopiNativeSessions", () => ({
  nativeSessionAtoms: {
    holdDemand: (_target: unknown, items: unknown[]) => {
      demand.held.push(items);
      return () => {
        demand.released += 1;
      };
    },
  },
}));
import { useAgentViewStore } from "./agentViewStore";
import { useNativeAgentHubSource } from "./useNativeAgentHubSource";

const target = {
  environmentId: EnvironmentId.make("env"),
  ref: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile: "/s.jsonl" },
};
const request = () => Promise.resolve({});

function withChild(runToken?: string): NativeSessionFeed {
  const feed = emptyNativeSessionFeed();
  return {
    ...feed,
    observation: {
      ...feed.observation,
      entities: new Map([
        [
          "roster:child",
          {
            ordinal: 0,
            revision: 1,
            value: {
              class: "roster",
              value: {
                id: "child",
                ...(runToken ? { runToken } : {}),
                inventory: { id: "child", status: "running" },
              },
            },
          },
        ],
      ]),
    },
  };
}

function Source({ feed }: { feed: NativeSessionFeed }) {
  useNativeAgentHubSource({ target, feed, request });
  return null;
}

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  useAgentViewStore.setState({ byKey: {} });
  demand.held = [];
  demand.released = 0;
});

it("raises detail for an opened child known only from the inventory, then names its run", () => {
  act(() => {
    useAgentViewStore.getState().dispatch(nativeSessionKey(target), { type: "open", id: "child" });
  });
  act(() => {
    renderer = create(<Source feed={withChild()} />);
  });
  expect(demand.held).toEqual([[{ kind: "child", childId: "child" }]]);
  act(() => renderer!.update(<Source feed={withChild("run")} />));
  expect(demand.released).toBe(1);
  expect(demand.held.at(-1)).toEqual([{ kind: "child", childId: "child", runToken: "run" }]);
});
