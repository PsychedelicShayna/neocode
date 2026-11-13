import * as Schema from "effect/Schema";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render, stubGlobal } from "../../test/render";
import {
  getLocalStorageItem,
  LocalStorageOperationError,
  useLocalStorage,
} from "./useLocalStorage";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

async function mountPreference<T, E>(
  storage: Storage,
  initialValue: T,
  schema: Schema.Codec<T, E>,
) {
  await using lifetime = new AsyncDisposableStack();
  lifetime.use(stubGlobal("localStorage", storage));
  lifetime.use(vi.spyOn(console, "error").mockImplementation(() => {}));
  let current!: ReturnType<typeof useLocalStorage<T, E>>;
  function Probe() {
    const preference = useLocalStorage("preference", initialValue, schema);
    useLayoutEffect(() => {
      current = preference;
    }, [preference]);
    return <output aria-label="Preference">{String(preference[0])}</output>;
  }
  const screen = lifetime.use(await render(<Probe />));
  const owned = lifetime.move();
  return {
    set: async (value: T | ((previous: T) => T)) => {
      await act(() => current[1](value));
    },
    screen,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

describe("local storage errors", () => {
  it("retries when access to browser storage becomes available", async () => {
    const storage = createStorage();
    storage.setItem("read-key", JSON.stringify("saved value"));
    let blocked = true;
    const storageWithAccess = createStorage({
      getItem: (key) => {
        if (blocked) throw new Error("storage unavailable");
        return storage.getItem(key);
      },
    });
    using _storage = stubGlobal("localStorage", storageWithAccess);

    expect(() => getLocalStorageItem("read-key", Schema.String)).toThrow(
      LocalStorageOperationError,
    );
    blocked = false;
    expect(getLocalStorageItem("read-key", Schema.String)).toBe("saved value");
  });
});

describe("local storage preference recovery", () => {
  it.each(["not-json", JSON.stringify("obsolete boolean value")])(
    "replaces an invalid stored value %j with a direct preference update",
    async (invalid) => {
      const storage = createStorage();
      storage.setItem("preference", invalid);
      await using hook = await mountPreference(storage, false, Schema.Boolean);
      await expect
        .element(hook.screen.getByRole("status", { name: "Preference" }))
        .toHaveTextContent("false");
      await hook.set(true);
      expect(storage.getItem("preference")).toBe("true");
      await expect
        .element(hook.screen.getByRole("status", { name: "Preference" }))
        .toHaveTextContent("true");
    },
  );

  it("uses the displayed default as the base for functional updates", async () => {
    const storage = createStorage();
    storage.setItem("preference", "{invalid");
    await using hook = await mountPreference(storage, true, Schema.Boolean);
    await expect
      .element(hook.screen.getByRole("status", { name: "Preference" }))
      .toHaveTextContent("true");
    await hook.set((previous) => !previous);
    expect(storage.getItem("preference")).toBe("false");
    await expect
      .element(hook.screen.getByRole("status", { name: "Preference" }))
      .toHaveTextContent("false");
  });

  it("allows removing an invalid preference", async () => {
    const storage = createStorage();
    storage.setItem("preference", "{invalid");
    await using hook = await mountPreference<boolean | null, boolean | null>(
      storage,
      false,
      Schema.NullOr(Schema.Boolean),
    );
    await hook.set(null);
    expect(storage.getItem("preference")).toBeNull();
    await expect
      .element(hook.screen.getByRole("status", { name: "Preference" }))
      .toHaveTextContent("false");
  });

  it("does not write after storage access is denied", async () => {
    const cause = new Error("storage access denied");
    const setItem = vi.fn();
    await using hook = await mountPreference(
      createStorage({
        getItem: () => {
          throw cause;
        },
        setItem,
      }),
      false,
      Schema.Boolean,
    );
    await hook.set(true);
    expect(setItem).not.toHaveBeenCalled();
    await expect
      .element(hook.screen.getByRole("status", { name: "Preference" }))
      .toHaveTextContent("false");
    expect(vi.mocked(console.error).mock.calls.at(-1)?.[1]).toMatchObject({
      operation: "read",
      cause,
    });
  });

  it("does not overwrite storage when a functional updater throws", async () => {
    const storage = createStorage();
    storage.setItem("preference", "true");
    await using hook = await mountPreference(storage, false, Schema.Boolean);
    const cause = new Error("updater failed");
    await hook.set(() => {
      throw cause;
    });
    expect(storage.getItem("preference")).toBe("true");
    await expect
      .element(hook.screen.getByRole("status", { name: "Preference" }))
      .toHaveTextContent("true");
    expect(vi.mocked(console.error).mock.calls.at(-1)?.[1]).toMatchObject({
      operation: "update",
      cause,
    });
  });
});
