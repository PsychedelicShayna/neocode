import { describe, expect, it, vi } from "vite-plus/test";
import { useLayoutEffect } from "react";
import { act, fakeTimers, render } from "../../../test/render";
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
function setup() {
  mocks.read.mockReset();
  let current: ReturnType<typeof useNeoPiModelSelector> | undefined;
  function Probe({
    context,
    query,
    instanceEntries = entries,
  }: {
    context: NativeSelectorContext;
    query: string;
    instanceEntries?: ReadonlyArray<ProviderInstanceEntry>;
  }) {
    const value = useNeoPiModelSelector(context, instanceEntries, query);
    useLayoutEffect(() => {
      current = value;
    }, [value]);
    return null;
  }
  return { Probe, read: () => current };
}

describe("native selector query lifetime", () => {
  it("discards an older query that completes after the current ranked result", async () => {
    const h = setup();
    const first = deferred();
    const second = deferred();
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const context = {
      environmentId: EnvironmentId.make("remote"),
      projectId: ProjectId.make("project"),
    };
    using _timers = fakeTimers();
    await using screen = await render(<h.Probe context={context} query="first" />);
    await screen.rerender(
      <h.Probe context={{ ...context }} query="first" instanceEntries={[...entries]} />,
    );
    await screen.rerender(<h.Probe context={context} query="second" />);
    expect(h.read()?.pending).toBe(true);
    await act(() => vi.advanceTimersByTime(NATIVE_QUERY_DEBOUNCE_MS));
    expect(h.read()?.pending).toBe(true);
    await act(() => second.resolve({ _tag: "Success", value: result("future/current:Exact") }));
    expect(
      h
        .read()
        ?.results.get(instanceId)
        ?.items.map((item) => item.selector),
    ).toEqual(["future/current:Exact"]);
    await act(() => first.resolve({ _tag: "Success", value: result("future/stale") }));
    expect(
      h
        .read()
        ?.results.get(instanceId)
        ?.items.map((item) => item.selector),
    ).toEqual(["future/current:Exact"]);
  });

  it("clears old project results immediately and rejects late responses after a context change", async () => {
    const h = setup();
    const first = deferred();
    const second = deferred();
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const environmentId = EnvironmentId.make("remote");
    const firstContext = { environmentId, projectId: ProjectId.make("first-project") };
    const secondContext = { environmentId, projectId: ProjectId.make("second-project") };
    await using screen = await render(<h.Probe context={firstContext} query="" />);
    await act(() => first.resolve({ _tag: "Success", value: result("future/first-project") }));
    expect(h.read()?.results.size).toBe(1);
    const firstScope = h.read()?.scopeKey;
    await screen.rerender(<h.Probe context={secondContext} query="" />);
    expect(h.read()?.results.size).toBe(0);
    expect(h.read()?.pending).toBe(true);
    expect(h.read()?.hasResponse).toBe(false);
    expect(h.read()?.scopeKey).not.toBe(firstScope);
    await act(() =>
      second.resolve({
        _tag: "Success",
        value: { items: [], roles: [], error: "Native query rejected" },
      }),
    );
    expect(h.read()?.results.size).toBe(0);
    expect(h.read()?.errors[0]).toContain("Native query rejected");
  });

  it("invalidates same-project results when the canonical native session changes", async () => {
    const h = setup();
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
    await using screen = await render(
      <h.Probe context={context("/sessions/first.jsonl")} query="" />,
    );
    await screen.rerender(<h.Probe context={context("/sessions/second.jsonl")} query="" />);
    expect(h.read()?.pending).toBe(true);
    expect(h.read()?.results.size).toBe(0);
    await act(() => second.resolve({ _tag: "Success", value: result("future/second-session") }));
    await act(() =>
      first.resolve({ _tag: "Success", value: result("future/stale-first-session") }),
    );
    expect(
      h
        .read()
        ?.results.get(instanceId)
        ?.items.map((item) => item.selector),
    ).toEqual(["future/second-session"]);
  });

  it("publishes a healthy instance before a slow one and preserves instance order", async () => {
    const h = setup();
    const first = deferred();
    const second = deferred();
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await using _screen = await render(
      <h.Probe
        context={{ environmentId: EnvironmentId.make("remote") }}
        query=""
        instanceEntries={multipleEntries}
      />,
    );
    expect(h.read()?.hasResponse).toBe(false);
    await act(() => second.resolve({ _tag: "Success", value: result("future/healthy") }));
    expect(h.read()?.pending).toBe(true);
    expect(h.read()?.hasResponse).toBe(true);
    expect(h.read()?.results.get(otherInstanceId)?.items[0]?.selector).toBe("future/healthy");
    expect(h.read()?.results.has(instanceId)).toBe(false);
    await act(() => first.resolve({ _tag: "Success", value: result("future/slow") }));
    expect(h.read()?.pending).toBe(false);
    expect([...h.read()!.results.keys()]).toEqual([instanceId, otherInstanceId]);
  });

  it("publishes one instance's failure without waiting for or hiding another instance", async () => {
    const h = setup();
    const second = deferred();
    mocks.read.mockRejectedValueOnce(new Error("Offline")).mockReturnValueOnce(second.promise);
    await using _screen = await render(
      <h.Probe
        context={{ environmentId: EnvironmentId.make("remote") }}
        query=""
        instanceEntries={multipleEntries}
      />,
    );
    expect(h.read()?.pending).toBe(true);
    expect(h.read()?.hasResponse).toBe(true);
    expect(h.read()?.errors[0]).toContain("Offline");
    await act(() => second.resolve({ _tag: "Success", value: result("future/available") }));
    expect(h.read()?.pending).toBe(false);
    expect(h.read()?.results.get(otherInstanceId)?.items[0]?.selector).toBe("future/available");
    expect(h.read()?.errors[0]).toContain("Offline");
  });

  it("rejects a slow old-query answer after publishing part of the new query", async () => {
    const h = setup();
    const oldFirst = deferred();
    const oldSecond = deferred();
    const newFirst = deferred();
    const newSecond = deferred();
    mocks.read
      .mockReturnValueOnce(oldFirst.promise)
      .mockReturnValueOnce(oldSecond.promise)
      .mockReturnValueOnce(newFirst.promise)
      .mockReturnValueOnce(newSecond.promise);
    const context = { environmentId: EnvironmentId.make("remote") };
    using _timers = fakeTimers();
    await using screen = await render(
      <h.Probe context={context} query="old" instanceEntries={multipleEntries} />,
    );
    await act(() => oldFirst.resolve({ _tag: "Success", value: result("future/old-first") }));
    expect(h.read()?.hasResponse).toBe(true);
    await screen.rerender(
      <h.Probe context={context} query="new" instanceEntries={multipleEntries} />,
    );
    expect(h.read()?.hasResponse).toBe(false);
    expect(h.read()?.results.size).toBe(0);
    await act(() => vi.advanceTimersByTime(NATIVE_QUERY_DEBOUNCE_MS));
    await act(() => newSecond.resolve({ _tag: "Success", value: result("future/new-second") }));
    await act(() => oldSecond.resolve({ _tag: "Success", value: result("future/stale-second") }));
    expect(h.read()?.pending).toBe(true);
    expect(h.read()?.results.size).toBe(1);
    expect(h.read()?.results.get(otherInstanceId)?.items[0]?.selector).toBe("future/new-second");
    await act(() => newFirst.resolve({ _tag: "Success", value: result("future/new-first") }));
    expect(h.read()?.pending).toBe(false);
    expect(h.read()?.results.get(instanceId)?.items[0]?.selector).toBe("future/new-first");
  });
});
