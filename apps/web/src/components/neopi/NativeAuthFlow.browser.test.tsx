import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type NeoPiModelsAuthState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { NativeAuthFlow } from "./NativeAuthFlow";
import "~/index.css";

type Reply =
  | { readonly _tag: "Success"; readonly value: unknown }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<Error> };

const fixture = vi.hoisted(() => ({ current: undefined as ReturnType<typeof setup> | undefined }));
vi.mock("./modelsPageState", () => ({
  neopiModels: {
    authChanges: () => fixture.current!.auth,
    respondAuth: { run: () => fixture.current!.respond() },
    cancelAuth: { run: () => Promise.resolve({ _tag: "Success", value: undefined }) },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { run: () => Promise<Reply> }) => command.run,
}));

function setup() {
  const initial: NeoPiModelsAuthState = {
    flowId: "login",
    status: "running",
    message: null,
    url: null,
    instructions: null,
    userCode: null,
    prompt: { kind: "input", id: "first", title: "First answer", placeholder: null, secret: false },
  };
  const auth = Atom.make(AsyncResult.success(initial));
  const registry = AtomRegistry.make();
  const replies: Array<{ resolve: (reply: Reply) => void }> = [];
  const respond = () =>
    new Promise<Reply>((resolve) => {
      replies.push({ resolve });
    });
  const view = () => (
    <RegistryContext.Provider value={registry}>
      <NativeAuthFlow
        environmentId={EnvironmentId.make("native-auth")}
        flowId="login"
        providerId="neoproxy"
        title="Connect"
        variant="card"
        finish={() => {}}
      />
    </RegistryContext.Provider>
  );
  const advance = (prompt: NeoPiModelsAuthState["prompt"]) =>
    act(() => registry.set(auth, AsyncResult.success({ ...initial, prompt })));
  const current = { auth, registry, replies, respond, view, advance };
  fixture.current = current;
  return current;
}

it("keeps a replacement native prompt independent of a pending previous reply", async () => {
  const h = setup();
  using _registry = { [Symbol.dispose]: () => h.registry.dispose() };
  await using screen = await render(h.view());
  await screen.getByRole("textbox", { name: "First answer" }).fill("first value");
  await screen.getByRole("button", { name: "Continue" }).click();
  await expect.element(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

  await h.advance({
    kind: "input",
    id: "second",
    title: "Second answer",
    placeholder: null,
    secret: false,
  });
  const second = screen.getByRole("textbox", { name: "Second answer" });
  await expect.element(second).toHaveFocus();
  await expect.element(second).toHaveValue("");
  await second.fill("new draft");
  await act(() =>
    h.replies[0]!.resolve({ _tag: "Failure", cause: Cause.fail(new Error("Old reply failed")) }),
  );
  await expect.element(second).toHaveValue("new draft");
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  await screen.getByRole("button", { name: "Continue" }).click();

  await h.advance({
    kind: "confirm",
    id: "second",
    title: "Certificate",
    message: "Trust details",
  });
  await expect.element(screen.getByRole("heading", { name: "Certificate" })).toHaveFocus();
  await expect.element(screen.getByRole("button", { name: "Trust this server" })).toBeEnabled();
  await act(() => h.replies[1]!.resolve({ _tag: "Success", value: undefined }));
  await expect.element(screen.getByRole("button", { name: "Trust this server" })).toBeEnabled();
});
