import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type NeoPiModelSelectorResult,
} from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useNeoPiModelSelector } from "./useNeoPiModelSelector";
import type { NativeSelectorContext } from "./neopiModelSwitcher";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.read }));
vi.mock("../neopi/modelsPageState", () => ({ neopiModels: { querySelector: {} } }));

const instanceId = ProviderInstanceId.make("neopi-work");
const entries = deriveProviderInstanceEntries([
  {
    instanceId,
    driver: ProviderDriverKind.make("neopi"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-22T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
]);
const result = (selector: string): NeoPiModelSelectorResult => ({
  roles: [],
  error: null,
  items: [
    {
      selector,
      provider: "future",
      id: selector,
      name: selector,
      resolvedSelector: selector,
      facts: {
        intelligence: null,
        ttftMs: null,
        tokensPerSecond: null,
        contextWindow: null,
        effectiveContextWindow: null,
        inputCostPerMillion: null,
        outputCostPerMillion: null,
        performanceSource: null,
        serviceTier: null,
      },
    },
  ],
});
function deferred() {
  let resolve!: (value: { _tag: "Success"; value: NeoPiModelSelectorResult }) => void;
  const promise = new Promise<{ _tag: "Success"; value: NeoPiModelSelectorResult }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let renderer: ReactTestRenderer | undefined;
let latest: ReturnType<typeof useNeoPiModelSelector> | undefined;
function Probe({ context, query }: { context: NativeSelectorContext; query: string }) {
  latest = useNeoPiModelSelector(context, entries, query);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.read.mockReset();
  latest = undefined;
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("native selector query lifetime", () => {
  it("discards an older query that completes after the current ranked result", async () => {
    const first = deferred();
    const second = deferred();
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const context = {
      environmentId: EnvironmentId.make("remote"),
      projectId: ProjectId.make("project"),
    };
    await act(async () => {
      renderer = create(createElement(Probe, { context, query: "first" }));
    });
    await act(async () => {
      renderer!.update(createElement(Probe, { context, query: "second" }));
    });
    expect(latest?.pending).toBe(true);
    await act(async () => {
      second.resolve({ _tag: "Success", value: result("future/current:Exact") });
    });
    expect(latest?.results.get(instanceId)?.items.map((item) => item.selector)).toEqual([
      "future/current:Exact",
    ]);
    await act(async () => {
      first.resolve({ _tag: "Success", value: result("future/stale") });
    });
    expect(latest?.results.get(instanceId)?.items.map((item) => item.selector)).toEqual([
      "future/current:Exact",
    ]);
    expect(mocks.read.mock.calls.map((call) => call[0].input.query)).toEqual(["first", "second"]);
  });

  it("clears old project results immediately and rejects late responses after a context change", async () => {
    const first = deferred();
    const second = deferred();
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const environmentId = EnvironmentId.make("remote");
    const firstContext = { environmentId, projectId: ProjectId.make("first-project") };
    const secondContext = { environmentId, projectId: ProjectId.make("second-project") };
    await act(async () => {
      renderer = create(createElement(Probe, { context: firstContext, query: "" }));
    });
    await act(async () => {
      first.resolve({ _tag: "Success", value: result("future/first-project") });
    });
    expect(latest?.results.size).toBe(1);
    await act(async () => {
      renderer!.update(createElement(Probe, { context: secondContext, query: "" }));
    });
    expect(latest?.results.size).toBe(0);
    expect(latest?.pending).toBe(true);
    await act(async () => {
      second.resolve({
        _tag: "Success",
        value: { items: [], roles: [], error: "Native query rejected" },
      });
    });
    expect(latest?.results.size).toBe(0);
    expect(latest?.errors[0]).toContain("Native query rejected");
    expect(mocks.read.mock.calls.map((call) => call[0].input.target.projectId)).toEqual([
      "first-project",
      "second-project",
    ]);
  });
});
