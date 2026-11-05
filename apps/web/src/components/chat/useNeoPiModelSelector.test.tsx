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
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { NATIVE_QUERY_DEBOUNCE_MS, useNeoPiModelSelector } from "./useNeoPiModelSelector";
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
const otherInstanceId = ProviderInstanceId.make("neopi-personal");
const multipleEntries = [
  ...entries,
  { ...entries[0]!, instanceId: otherInstanceId, displayName: "Personal NeoPi" },
];
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
function Probe({
  context,
  query,
  instanceEntries = entries,
}: {
  context: NativeSelectorContext;
  query: string;
  instanceEntries?: ReadonlyArray<ProviderInstanceEntry>;
}) {
  latest = useNeoPiModelSelector(context, instanceEntries, query);
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native selector query lifetime", () => {
  it("discards an older query that completes after the current ranked result", async () => {
    const first = deferred();
    const second = deferred();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
    // Typing waits for the debounce, and meanwhile the settled "first" answer is not offered.
    expect(latest?.pending).toBe(true);
    expect(mocks.read.mock.calls.map((call) => call[0].input.query)).toEqual(["first"]);
    await act(async () => {
      vi.advanceTimersByTime(NATIVE_QUERY_DEBOUNCE_MS);
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
    const firstScope = latest?.scopeKey;
    await act(async () => {
      renderer!.update(createElement(Probe, { context: secondContext, query: "" }));
    });
    expect(latest?.results.size).toBe(0);
    expect(latest?.pending).toBe(true);
    expect(latest?.hasResponse).toBe(false);
    expect(latest?.scopeKey).not.toBe(firstScope);
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

  it("invalidates same-project results when the canonical native session changes", async () => {
    const first = deferred();
    const second = deferred();
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const environmentId = EnvironmentId.make("remote");
    const projectId = ProjectId.make("project");
    const context = (sessionFile: string): NativeSelectorContext => ({
      environmentId,
      projectId,
      connectedSession: { providerInstanceId: instanceId, sessionFile },
    });
    await act(async () => {
      renderer = create(
        createElement(Probe, { context: context("/sessions/first.jsonl"), query: "" }),
      );
    });
    await act(async () => {
      renderer!.update(
        createElement(Probe, { context: context("/sessions/second.jsonl"), query: "" }),
      );
    });
    expect(latest?.pending).toBe(true);
    expect(latest?.results.size).toBe(0);
    await act(async () => {
      second.resolve({ _tag: "Success", value: result("future/second-session") });
    });
    await act(async () => {
      first.resolve({ _tag: "Success", value: result("future/stale-first-session") });
    });
    expect(latest?.results.get(instanceId)?.items.map((item) => item.selector)).toEqual([
      "future/second-session",
    ]);
    expect(mocks.read.mock.calls.map((call) => call[0].input.target)).toEqual([
      { providerInstanceId: instanceId, projectId, sessionFile: "/sessions/first.jsonl" },
      { providerInstanceId: instanceId, projectId, sessionFile: "/sessions/second.jsonl" },
    ]);
  });

  it("publishes a healthy instance before a slow one and preserves instance order", async () => {
    const first = deferred();
    const second = deferred();
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await act(async () => {
      renderer = create(
        createElement(Probe, {
          context: { environmentId: EnvironmentId.make("remote") },
          query: "",
          instanceEntries: multipleEntries,
        }),
      );
    });
    expect(latest?.hasResponse).toBe(false);
    await act(async () => {
      second.resolve({ _tag: "Success", value: result("future/healthy") });
    });
    expect(latest?.pending).toBe(true);
    expect(latest?.hasResponse).toBe(true);
    expect(latest?.results.get(otherInstanceId)?.items[0]?.selector).toBe("future/healthy");
    expect(latest?.results.has(instanceId)).toBe(false);

    await act(async () => {
      first.resolve({ _tag: "Success", value: result("future/slow") });
    });
    expect(latest?.pending).toBe(false);
    expect([...latest!.results.keys()]).toEqual([instanceId, otherInstanceId]);
  });

  it("publishes one instance's failure without waiting for or hiding another instance", async () => {
    const second = deferred();
    mocks.read.mockRejectedValueOnce(new Error("Offline")).mockReturnValueOnce(second.promise);
    await act(async () => {
      renderer = create(
        createElement(Probe, {
          context: { environmentId: EnvironmentId.make("remote") },
          query: "",
          instanceEntries: multipleEntries,
        }),
      );
    });
    expect(latest?.pending).toBe(true);
    expect(latest?.hasResponse).toBe(true);
    expect(latest?.errors[0]).toContain("Offline");
    await act(async () => {
      second.resolve({ _tag: "Success", value: result("future/available") });
    });
    expect(latest?.pending).toBe(false);
    expect(latest?.results.get(otherInstanceId)?.items[0]?.selector).toBe("future/available");
    expect(latest?.errors[0]).toContain("Offline");
  });

  it("rejects a slow old-query answer after publishing part of the new query", async () => {
    const oldFirst = deferred();
    const oldSecond = deferred();
    const newFirst = deferred();
    const newSecond = deferred();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.read
      .mockReturnValueOnce(oldFirst.promise)
      .mockReturnValueOnce(oldSecond.promise)
      .mockReturnValueOnce(newFirst.promise)
      .mockReturnValueOnce(newSecond.promise);
    const context = { environmentId: EnvironmentId.make("remote") };
    await act(async () => {
      renderer = create(
        createElement(Probe, { context, query: "old", instanceEntries: multipleEntries }),
      );
    });
    await act(async () => {
      oldFirst.resolve({ _tag: "Success", value: result("future/old-first") });
    });
    expect(latest?.hasResponse).toBe(true);
    await act(async () => {
      renderer!.update(
        createElement(Probe, { context, query: "new", instanceEntries: multipleEntries }),
      );
    });
    expect(latest?.hasResponse).toBe(false);
    expect(latest?.results.size).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(NATIVE_QUERY_DEBOUNCE_MS);
    });
    await act(async () => {
      newSecond.resolve({ _tag: "Success", value: result("future/new-second") });
    });
    await act(async () => {
      oldSecond.resolve({ _tag: "Success", value: result("future/stale-second") });
    });
    expect(latest?.pending).toBe(true);
    expect(latest?.results.size).toBe(1);
    expect(latest?.results.get(otherInstanceId)?.items[0]?.selector).toBe("future/new-second");
    await act(async () => {
      newFirst.resolve({ _tag: "Success", value: result("future/new-first") });
    });
    expect(latest?.pending).toBe(false);
    expect(latest?.results.get(instanceId)?.items[0]?.selector).toBe("future/new-first");
  });
});
