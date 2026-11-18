import { describe, expect, it } from "vite-plus/test";
import type { KeybindingRule, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";

import {
  buildKeybindingRows,
  buildKeybindingCommandOptions,
  buildWhenVariableOptions,
  commandLabel,
  keybindingChordParts,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  recordKeybindingStep,
  parseWhenExpressionDraft,
  shortcutToKeybindingInput,
  unknownWhenVariables,
  whenAstToExpression,
  whenNodeRemoveLabel,
} from "./KeybindingsSettings.logic";

describe("KeybindingsSettings.logic", () => {
  it("lists composer, provider, and pull request commands with editable defaults", () => {
    const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "");
    for (const command of [
      "composer.host",
      "composer.effort",
      "composer.mode",
      "composer.dictation.toggle",
      "composer.workspace",
      "composer.branch",
      "composer.previousWorktree",
      "modelPicker.previousProvider",
      "modelPicker.nextProvider",
      "thread.copyReference",
      "pullRequest.copyNumber",
    ]) {
      expect(rows.find((row) => row.command === command)).toMatchObject({
        source: "Default",
        conflicts: [],
      });
    }
  });
  it.each(["pu", "pull request", "copy link", "thread id"])(
    "finds the copy link shortcut with %s",
    (query) => {
      const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, query);
      expect(rows).toContainEqual(
        expect.objectContaining({ command: "thread.copyReference", key: "mod+shift+c" }),
      );
    },
  );
  it("offers only the supported Stats opener, not controls from the retired local chart", () => {
    const bindings = DEFAULT_RESOLVED_KEYBINDINGS.toReversed();
    expect(buildKeybindingRows(bindings, "usage").map((row) => row.command)).toEqual([
      "usage.open",
    ]);
    expect(
      buildKeybindingCommandOptions(bindings).filter((command) => command.startsWith("usage.")),
    ).toEqual(["usage.open"]);
  });

  it("builds searchable rows with readable key and when values", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "terminal.toggle",
          shortcut: {
            key: "j",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "terminal",
    );

    expect(rows).toEqual([
      expect.objectContaining({
        command: "terminal.toggle",
        key: "mod+j",
        when: "!terminalFocus",
        defaultKey: "mod+j",
        defaultWhen: "",
        source: "Custom",
      }),
    ]);
  });

  it("captures platform-specific mod shortcuts", () => {
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toBe("mod+shift+k");
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "Win32",
      ),
    ).toBe("mod+shift+k");
  });

  it.each([
    ["@", "Digit2", "mod+shift+2"],
    ['"', "Digit2", "mod+shift+2"],
    ["@", "Quote", "mod+shift+'"],
  ])("captures %s at %s by physical key", (key, code, expected) => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key,
          code,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        },
        "MacIntel",
      ),
    ).toBe(expected);
  });

  it("captures Latin layout keys instead of their punctuation position", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "m",
          code: "Semicolon",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBe("mod+m");
  });

  it("serializes shortcuts and when expressions for upserts", () => {
    expect(
      shortcutToKeybindingInput({
        key: " ",
        modKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toBe("mod+alt+space");

    expect(
      whenAstToExpression({
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      }),
    ).toBe("editorFocus && !terminalFocus");

    expect(parseWhenExpressionDraft("editorFocus && (!terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "or",
          left: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
    expect(parseWhenExpressionDraft("editorFocus &&")).toEqual({
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    });

    expect(parseWhenExpressionDraft("!(terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "not",
        node: {
          type: "or",
          left: { type: "identifier", name: "terminalFocus" },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
  });

  it("describes the scope of each visual expression removal", () => {
    const condition = { type: "identifier", name: "terminalFocus" } as const;
    const negatedCondition = { type: "not", node: condition } as const;
    const group = { type: "and", left: condition, right: negatedCondition } as const;
    const negatedGroup = { type: "not", node: group } as const;

    expect(whenNodeRemoveLabel(group, 0)).toBe("Clear all conditions");
    expect(whenNodeRemoveLabel(condition, 1)).toBe("Remove condition");
    expect(whenNodeRemoveLabel(negatedCondition, 1)).toBe("Remove condition");
    expect(whenNodeRemoveLabel(group, 1)).toBe("Remove group and its conditions");
    expect(whenNodeRemoveLabel(negatedGroup, 1)).toBe("Remove group and its conditions");
  });

  it("formats static and project script command labels", () => {
    expect(commandLabel("commandPalette.toggle")).toBe("Command Palette: Toggle");
    expect(commandLabel("themeEditor.toggle")).toBe("Theme Editor: Toggle");
    expect(commandLabel("script.setup-db.run")).toBe("Run Script: Setup Db");
  });

  it("builds known when variable options from defaults without frontend labels", () => {
    const options = buildWhenVariableOptions();

    expect(options).toEqual(
      expect.arrayContaining([
        "terminalFocus",
        "terminalOpen",
        "isWeb",
        "isDesktop",
        "modelPickerOpen",
        "true",
        "false",
      ]),
    );
    expect(options).not.toContain("customModeActive");
  });

  it("builds command options from all static commands and resolved project bindings", () => {
    const options = buildKeybindingCommandOptions([
      {
        command: "script.setup-db.run",
        shortcut: {
          key: "r",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
      },
    ] satisfies ResolvedKeybindingsConfig);

    expect(options).toEqual(
      expect.arrayContaining([
        "chat.new",
        "rightPanel.toggleMaximized",
        "thread.stop",
        "usage.open",
        "script.setup-db.run",
      ]),
    );
    expect(
      DEFAULT_RESOLVED_KEYBINDINGS.some(
        (binding) => binding.command === "rightPanel.toggleMaximized",
      ),
    ).toBe(false);
  });

  it("reports unknown when variables without rejecting parseable expressions", () => {
    const parsed = parseWhenExpressionDraft("!terminalFocus && terminalFoc");

    expect(parsed.ok).toBe(true);
    expect(unknownWhenVariables(parsed.ok ? parsed.value : undefined)).toEqual(["terminalFoc"]);
  });

  it("marks each default shortcut for multi-binding commands as default", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "chat.new",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
        {
          command: "chat.new",
          shortcut: {
            key: "o",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: true,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows.map((row) => row.source)).toEqual(["Default", "Default"]);
  });

  it("reports conflicting shortcuts that share an active when context", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "chat.new",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
        {
          command: "chat.newLocal",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows[0]?.conflicts).toEqual(["Chat: New Local"]);
    expect(
      keybindingConflictLabels(rows, {
        rowId: rows[0]?.id ?? "",
        key: "mod+n",
        when: "",
      }),
    ).toEqual(["Chat: New Local"]);
  });

  describe("clash analysis", () => {
    const rowsFor = (rules: ReadonlyArray<KeybindingRule>) =>
      buildKeybindingRows(compileResolvedKeybindingsConfig(rules), "");
    const conflictsOf = (rules: ReadonlyArray<KeybindingRule>, command: string) =>
      rowsFor(rules).find((row) => row.command === command)?.conflicts;
    const draftConflicts = (
      rules: ReadonlyArray<KeybindingRule>,
      draft: { key: string; when?: string; command?: KeybindingRule["command"] },
      platform = "Linux",
    ) =>
      keybindingConflictLabels(
        rowsFor(rules),
        { rowId: "new", key: draft.key, when: draft.when ?? "", command: draft.command ?? null },
        platform,
      );

    it("finds no conflicts among the defaults", () => {
      for (const platform of ["Linux", "MacIntel"]) {
        const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "");
        for (const row of rows) {
          expect(
            keybindingConflictLabels(
              rows,
              {
                rowId: row.id,
                key: row.key,
                when: row.when,
                command: row.command,
                order: row.order,
              },
              platform,
            ),
            `${row.command} ${row.key} on ${platform}`,
          ).toEqual([]);
        }
      }
    });

    it("compares keys as the platform presses them, not as written", () => {
      const rules = [{ key: "ctrl+k", command: "sidebar.toggle" }] satisfies KeybindingRule[];
      expect(draftConflicts(rules, { key: "mod+k" }, "Linux")).toEqual(["Sidebar: Toggle"]);
      expect(draftConflicts(rules, { key: "mod+k" }, "MacIntel")).toEqual([]);
    });

    it("reports overlapping conditions but not exclusive ones", () => {
      const rules = [
        { key: "mod+g", command: "sidebar.toggle", when: "nativeSession && !composerFocus" },
      ] satisfies KeybindingRule[];
      expect(draftConflicts(rules, { key: "mod+g", when: "composerFocus" })).toEqual([]);
      expect(
        draftConflicts(rules, { key: "mod+g", when: "!nativeSession || editableFocus" }),
      ).toEqual(["Sidebar: Toggle"]);
      // Focus is in one place, so terminal-focused and preview-focused rules never meet.
      expect(
        conflictsOf(
          [
            { key: "mod+g", command: "preview.refresh", when: "previewFocus" },
            { key: "mod+g", command: "diff.toggle", when: "terminalFocus || editableFocus" },
          ],
          "preview.refresh",
        ),
      ).toEqual(["Diff: Toggle"]);
    });

    it("treats a later rule that only narrows an earlier one as an override", () => {
      const general = { key: "mod+g", command: "sidebar.toggle", when: "!terminalFocus" } as const;
      const narrow = {
        key: "mod+g",
        command: "diff.toggle",
        when: "nativeSession && !terminalFocus",
      } as const;
      expect(conflictsOf([general, narrow], "sidebar.toggle")).toEqual([]);
      // The other way round, the broad rule hides the narrow one entirely.
      expect(conflictsOf([narrow, general], "sidebar.toggle")).toEqual(["Diff: Toggle"]);
    });

    it("reports a chord that is the first chord of a sequence, not two sequences sharing it", () => {
      const rules = [{ key: "ctrl+w h", command: "sidebar.toggle" }] satisfies KeybindingRule[];
      expect(draftConflicts(rules, { key: "ctrl+w" })).toEqual(["Sidebar: Toggle"]);
      expect(draftConflicts(rules, { key: "ctrl+w l" })).toEqual([]);
      expect(draftConflicts(rules, { key: "ctrl+w h" })).toEqual(["Sidebar: Toggle"]);
    });

    it("reserves the terminal escape and font keys in a focused terminal", () => {
      const rules = [
        { key: "ctrl+\\ ctrl+\\", command: "terminal.leaveFocus", when: "terminalFocus" },
        { key: "mod+=", command: "terminal.fontSize.increase", when: "terminalFocus" },
      ] satisfies KeybindingRule[];
      expect(draftConflicts(rules, { key: "ctrl+\\" })).toEqual(["Terminal: Leave Focus"]);
      // A narrower later rule cannot take the key back from the terminal.
      expect(draftConflicts(rules, { key: "mod+=", when: "terminalFocus && isDesktop" })).toEqual([
        "Terminal: Font Size: Increase",
      ]);
      expect(draftConflicts(rules, { key: "ctrl+\\", when: "!terminalFocus" })).toEqual([]);
    });
  });

  it("splits a chord into its keycaps, keeping a literal plus key", () => {
    expect(keybindingChordParts("mod+shift+k")).toEqual(["mod", "shift", "k"]);
    expect(keybindingChordParts("mod++")).toEqual(["mod", "+"]);
    expect(keybindingChordParts("ctrl+shift++")).toEqual(["ctrl", "shift", "+"]);
    expect(keybindingChordParts("+")).toEqual(["+"]);
  });

  describe("recording a binding", () => {
    const keydown = (
      key: string,
      modifiers: Partial<Record<"ctrlKey" | "shiftKey", boolean>> = {},
    ) => ({
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...modifiers,
    });

    it("records a two-chord sequence whose second chord may be a bare key", () => {
      const first = recordKeybindingStep(null, keydown("w", { ctrlKey: true }), "Linux");
      expect(first).toEqual({ key: "mod+w", done: false });
      expect(
        recordKeybindingStep("mod+w", keydown("Shift", { shiftKey: true }), "Linux"),
      ).toBeNull();
      expect(recordKeybindingStep("mod+w", keydown("h"), "Linux")).toEqual({
        key: "mod+w h",
        done: true,
      });
    });

    it("does not take an auto-repeat of the first chord as the second", () => {
      expect(
        recordKeybindingStep(
          "mod+w",
          { ...keydown("w", { ctrlKey: true }), repeat: true },
          "Linux",
        ),
      ).toBeNull();
    });

    it("keeps a single chord on Enter and needs a modifier to start", () => {
      expect(recordKeybindingStep("mod+w", keydown("Enter"), "Linux")).toEqual({
        key: "mod+w",
        done: true,
      });
      expect(recordKeybindingStep(null, keydown("h"), "Linux")).toBeNull();
    });
  });
});
