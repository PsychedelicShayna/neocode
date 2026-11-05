import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

let cleanup: (() => Promise<void>) | undefined;

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

async function loadWithStorage(storage: Storage) {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: storage }));
  vi.stubGlobal("localStorage", storage);
  return import("./useLocalStorage");
}

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

async function mountPreference<T, E>(
  storage: Storage,
  initialValue: T,
  schema: Schema.Codec<T, E>,
) {
  const { useLocalStorage } = await loadWithStorage(storage);
  const { act, createElement } = await import("react");
  const { create } = await import("react-test-renderer");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  let current!: ReturnType<typeof useLocalStorage<T, E>>;
  function Probe() {
    current = useLocalStorage("preference", initialValue, schema);
    return null;
  }
  let renderer!: import("react-test-renderer").ReactTestRenderer;
  await act(() => {
    renderer = create(createElement(Probe));
  });
  cleanup = async () => {
    await act(() => renderer.unmount());
  };
  return {
    get current() {
      return current;
    },
    set: async (value: T | ((previous: T) => T)) => {
      await act(() => current[1](value));
    },
  };
}

describe("local storage errors", () => {
  it("preserves read failure context", async () => {
    const cause = new Error("storage unavailable");
    const { getLocalStorageItem, LocalStorageOperationError } = await loadWithStorage(
      createStorage({
        getItem: () => {
          throw cause;
        },
      }),
    );

    try {
      getLocalStorageItem("read-key", Schema.String);
      expect.unreachable("expected the read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "read-key",
        cause,
      });
    }
  });

  it("retries when access to browser storage becomes available", async () => {
    const storage = createStorage();
    storage.setItem("read-key", JSON.stringify("saved value"));
    let blocked = true;
    vi.stubGlobal("window", {
      get localStorage() {
        if (blocked) throw new Error("storage unavailable");
        return storage;
      },
    });
    const { getLocalStorageItem, LocalStorageOperationError } = await import("./useLocalStorage");

    expect(() => getLocalStorageItem("read-key", Schema.String)).toThrow(
      LocalStorageOperationError,
    );
    blocked = false;
    expect(getLocalStorageItem("read-key", Schema.String)).toBe("saved value");
  });

  it.each(["", "not-json"])("preserves decode failure context for %j", async (value) => {
    const { getLocalStorageItem, LocalStorageOperationError } = await loadWithStorage(
      createStorage({ getItem: () => value }),
    );

    try {
      getLocalStorageItem("decode-key", Schema.String);
      expect.unreachable("expected decoding to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "decode",
        storageKey: "decode-key",
        cause: expect.anything(),
      });
    }
  });

  it("preserves write failure context", async () => {
    const cause = new Error("storage quota exceeded");
    const { LocalStorageOperationError, setLocalStorageItem } = await loadWithStorage(
      createStorage({
        setItem: () => {
          throw cause;
        },
      }),
    );

    try {
      setLocalStorageItem("write-key", "value", Schema.String);
      expect.unreachable("expected the write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "write-key",
        cause,
      });
    }
  });

  it("preserves removal failure context", async () => {
    const cause = new Error("storage unavailable");
    const { LocalStorageOperationError, removeLocalStorageItem } = await loadWithStorage(
      createStorage({
        removeItem: () => {
          throw cause;
        },
      }),
    );

    try {
      removeLocalStorageItem("remove-key");
      expect.unreachable("expected the removal to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStorageOperationError);
      expect(error).toMatchObject({
        operation: "remove",
        storageKey: "remove-key",
        cause,
      });
    }
  });
});

describe("local storage preference recovery", () => {
  it.each(["not-json", JSON.stringify("obsolete boolean value")])(
    "replaces an invalid stored value %j with a direct preference update",
    async (invalid) => {
      const storage = createStorage();
      storage.setItem("preference", invalid);
      const hook = await mountPreference(storage, false, Schema.Boolean);
      expect(hook.current[0]).toBe(false);
      await hook.set(true);
      expect(storage.getItem("preference")).toBe("true");
      expect(hook.current[0]).toBe(true);
    },
  );

  it("uses the displayed default as the base for functional updates", async () => {
    const storage = createStorage();
    storage.setItem("preference", "{invalid");
    const hook = await mountPreference(storage, true, Schema.Boolean);
    expect(hook.current[0]).toBe(true);
    await hook.set((previous) => !previous);
    expect(storage.getItem("preference")).toBe("false");
    expect(hook.current[0]).toBe(false);
  });

  it("allows removing an invalid preference", async () => {
    const storage = createStorage();
    storage.setItem("preference", "{invalid");
    const hook = await mountPreference<boolean | null, boolean | null>(
      storage,
      false,
      Schema.NullOr(Schema.Boolean),
    );
    await hook.set(null);
    expect(storage.getItem("preference")).toBeNull();
    expect(hook.current[0]).toBe(false);
  });

  it("does not write after storage access is denied", async () => {
    const cause = new Error("storage access denied");
    const setItem = vi.fn();
    const hook = await mountPreference(
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
    expect(hook.current[0]).toBe(false);
    expect(vi.mocked(console.error).mock.calls.at(-1)?.[1]).toMatchObject({
      operation: "read",
      cause,
    });
  });

  it("does not overwrite storage when a functional updater throws", async () => {
    const storage = createStorage();
    storage.setItem("preference", "true");
    const hook = await mountPreference(storage, false, Schema.Boolean);
    const cause = new Error("updater failed");
    await hook.set(() => {
      throw cause;
    });
    expect(storage.getItem("preference")).toBe("true");
    expect(hook.current[0]).toBe(true);
    expect(vi.mocked(console.error).mock.calls.at(-1)?.[1]).toMatchObject({
      operation: "update",
      cause,
    });
  });
});
