// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { workspaceKey } from "@t3tools/client-runtime/environment";
import {
  emptyNativeSessionFeed,
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

it("holds child demand when the workspace panel opens the view and releases it on close", () => {
  const dispatch = useAgentViewStore.getState().dispatch;
  const key = workspaceKey(target);
  act(() => {
    renderer = create(<Source feed={withChild()} />);
  });
  act(() => dispatch(key, { type: "open", id: "child" }));
  expect(demand.held).toEqual([[{ kind: "child", childId: "child" }]]);
  act(() => renderer!.update(<Source feed={withChild("run")} />));
  expect(demand.released).toBe(1);
  expect(demand.held.at(-1)).toEqual([{ kind: "child", childId: "child", runToken: "run" }]);
  act(() => dispatch(key, { type: "back" }));
  expect(demand.released).toBe(2);
});
