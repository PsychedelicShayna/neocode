import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { NeoPiModelsPage } from "./NeoPiModelsPage";
import "~/index.css";

const fixture = vi.hoisted(() => ({ current: undefined as ReturnType<typeof setup> | undefined }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomRefresh: () => fixture.current!.retry,
}));
vi.mock("./modelsPageState", () => ({
  neopiModels: {
    changes: () => fixture.current!.atom,
    read: { run: () => Promise.resolve({ _tag: "Success", value: undefined }) },
  },
  useModelsPageTarget: () => ({
    search: {},
    environmentId: EnvironmentId.make("native-retry"),
    target: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile: "/session.jsonl" },
    provider: { instanceId: "neopi" },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { run: () => Promise<unknown> }) => command.run,
}));

function setup() {
  const interrupted = () => AsyncResult.failure(Cause.interrupt(1));
  const atom = Atom.make(interrupted());
  const registry = AtomRegistry.make();
  let attempts = 0;
  const retry = () => {
    attempts += 1;
    registry.set(atom, interrupted());
  };
  const view = () => (
    <RegistryContext.Provider value={registry}>
      <NeoPiModelsPage />
    </RegistryContext.Provider>
  );
  const current = { atom, registry, retry, view, attempts: () => attempts };
  fixture.current = current;
  return current;
}

it("bounds interrupted native subscription retries and cancels the next attempt on close", async () => {
  const h = setup();
  using _registry = { [Symbol.dispose]: () => h.registry.dispose() };
  using _timers = fakeTimers();
  await using screen = await render(h.view());
  for (const delay of [400, 800, 1200]) {
    await expect.element(screen.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(delay));
  }
  expect(h.attempts()).toBe(3);
  await expect.element(screen.getByText("Couldn't read models from NeoPi")).toBeInTheDocument();
  await screen.getByRole("button", { name: "Retry" }).click();
  expect(h.attempts()).toBe(4);
  await expect.element(screen.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  await screen.unmount();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(h.attempts()).toBe(4);
});
