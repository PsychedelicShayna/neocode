import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  currentComposerArgumentCompletions,
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";
import { composerCapabilitiesForProvider } from "./neopiComposerUi";

describe("native slash argument completions", () => {
  it("only offers and accepts completions for the current prefix, command, and session", () => {
    const source = async () => [];
    const otherSession = async () => [];
    const angela = { value: "Angela", label: "Angela", submitsCommand: true };
    const bella = { value: "Bella", label: "Bella", submitsCommand: true };
    const earlier = { command: "personality", prefix: "An", source, items: [angela] };

    expect(currentComposerArgumentCompletions(earlier, "personality", "An", source)).toEqual([
      angela,
    ]);
    const whileTyping = currentComposerArgumentCompletions(earlier, "personality", "Be", source);
    expect(whileTyping).toEqual([]);
    expect(whileTyping.includes(angela)).toBe(false);
    expect(currentComposerArgumentCompletions(earlier, "other", "An", source)).toEqual([]);
    expect(currentComposerArgumentCompletions(earlier, "personality", "An", otherSession)).toEqual(
      [],
    );

    const latest = { command: "personality", prefix: "Be", source, items: [bella] };
    expect(currentComposerArgumentCompletions(latest, "personality", "Be", source)).toEqual([
      bella,
    ]);
    expect(
      currentComposerArgumentCompletions(latest, "personality", "Be", source).includes(angela),
    ).toBe(false);
  });
});

describe("searchSlashCommandItems", () => {
  const nativeDriver = ProviderDriverKind.make("neopi");

  it.each(["model", "side", "btw", "clear"] as const)(
    "keeps native /%s authoritative rather than consuming it as a local GUI action",
    (command) => {
      const nativeCommand = {
        id: `native:${command}`,
        type: "provider-slash-command" as const,
        provider: ProviderDriverKind.make("neopi"),
        command: { name: command, source: "builtin" as const },
        label: `/${command}`,
        description: "Native command",
      };
      const localCommand = {
        id: `local:${command}`,
        type: "slash-command" as const,
        command,
        label: `/${command}`,
        description: "Local GUI action",
      };
      const menu = slashCommandItemsForPromptPosition(
        [localCommand, nativeCommand],
        true,
        composerCapabilitiesForProvider("neopi")?.ownsSlashCommands,
      );
      expect(searchSlashCommandItems(menu, command)).toEqual([nativeCommand]);
    },
  );

  it("does not offer a local picker when the native catalog is unavailable", () => {
    const menu = slashCommandItemsForPromptPosition(
      [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Local GUI action",
        },
      ],
      true,
      true,
    );
    expect(searchSlashCommandItems(menu, "model")).toEqual([]);
  });

  const aliasedCommand = {
    id: "native:model",
    type: "provider-slash-command" as const,
    provider: ProviderDriverKind.make("neopi"),
    command: { name: "model", aliases: ["Mi", "provider-switch", "model-switch"] },
    label: "/model",
    description: "Choose an inference configuration",
  };

  it.each(["mi", "/MI", "provider-sw", "pswtch", "mod"])(
    "finds advertised aliases with query %s without duplicating the command",
    (query) => {
      expect(searchSlashCommandItems([aliasedCommand], query)).toEqual([aliasedCommand]);
    },
  );

  it("ranks an exact alias ahead of a description-only match", () => {
    const descriptionMatch = {
      ...aliasedCommand,
      id: "native:describe",
      command: { name: "describe" },
      label: "/describe",
      description: "mi",
    };
    expect(searchSlashCommandItems([descriptionMatch, aliasedCommand], "mi")).toEqual([
      aliasedCommand,
      descriptionMatch,
    ]);
  });

  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      {
        id: "slash:clear",
        type: "slash-command",
        command: "clear",
        label: "/clear",
        description: "Clear the current GUI conversation",
      },
      {
        id: "provider-slash-command:neopi:ui",
        type: "provider-slash-command",
        provider: nativeDriver,
        command: { name: "ui" },
        label: "/ui",
        description: "Explore, build, and refine UI.",
      },
      {
        id: "provider-slash-command:neopi:frontend-design",
        type: "provider-slash-command",
        provider: nativeDriver,
        command: { name: "frontend-design" },
        label: "/frontend-design",
        description: "Create distinctive, production-grade frontend interfaces",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" | "skill" }>
    >;

    expect(searchSlashCommandItems(items, "ui").map((item) => item.id)).toEqual([
      "provider-slash-command:neopi:ui",
      "slash:clear",
    ]);
  });

  it("supports fuzzy provider command matches", () => {
    const items = [
      {
        id: "provider-slash-command:neopi:gh-fix-ci",
        type: "provider-slash-command",
        provider: nativeDriver,
        command: { name: "gh-fix-ci" },
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      },
      {
        id: "provider-slash-command:neopi:github",
        type: "provider-slash-command",
        provider: nativeDriver,
        command: { name: "github" },
        label: "/github",
        description: "General GitHub help",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" | "skill" }>
    >;

    expect(searchSlashCommandItems(items, "gfc").map((item) => item.id)).toEqual([
      "provider-slash-command:neopi:gh-fix-ci",
    ]);
  });

  it("includes skills by name and description", () => {
    const items = [
      {
        id: "skill:neopi:browser",
        type: "skill",
        provider: nativeDriver,
        skill: {
          name: "browser",
          path: "/skills/browser/SKILL.md",
          enabled: true,
          shortDescription: "Open and control the in-app browser",
        },
        label: "/skill:browser",
        description: "Open and control the in-app browser",
      },
    ] satisfies Array<Extract<ComposerCommandItem, { type: "skill" }>>;

    expect(searchSlashCommandItems(items, "browser").map((item) => item.id)).toEqual([
      "skill:neopi:browser",
    ]);
    expect(searchSlashCommandItems(items, "control").map((item) => item.id)).toEqual([
      "skill:neopi:browser",
    ]);
  });

  it("matches skills by display name", () => {
    const items = [
      {
        id: "skill:neopi:ask-matt",
        type: "skill",
        provider: nativeDriver,
        skill: {
          name: "ask-matt",
          displayName: "Ask Matt",
          path: "/skills/ask-matt/SKILL.md",
          enabled: true,
          shortDescription: "Find the right skill or workflow",
        },
        label: "/skill:ask-matt",
        description: "Find the right skill or workflow",
      },
    ] satisfies Array<Extract<ComposerCommandItem, { type: "skill" }>>;

    expect(searchSlashCommandItems(items, "ask matt").map((item) => item.id)).toEqual([
      "skill:neopi:ask-matt",
    ]);
    expect(searchSlashCommandItems(items, "/skill:ask-matt").map((item) => item.id)).toEqual([
      "skill:neopi:ask-matt",
    ]);
  });

  it("matches skills by their rendered prefix", () => {
    const items = [
      {
        id: "skill:neopi:browser",
        type: "skill",
        provider: nativeDriver,
        skill: {
          name: "browser",
          path: "/skills/browser/SKILL.md",
          enabled: true,
        },
        label: "/skill:browser",
        description: "Open and control the in-app browser",
      },
    ] satisfies Array<Extract<ComposerCommandItem, { type: "skill" }>>;

    expect(searchSlashCommandItems(items, "/skill:brow").map((item) => item.id)).toEqual([
      "skill:neopi:browser",
    ]);
    expect(searchSlashCommandItems(items, "/sk").map((item) => item.id)).toEqual([
      "skill:neopi:browser",
    ]);
    expect(searchSlashCommandItems(items, "/ill")).toEqual([]);
  });

  it("keeps skills alongside commands for an empty slash query", () => {
    const items = [
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch model",
      },
      {
        id: "skill:neopi:unslop",
        type: "skill",
        provider: nativeDriver,
        skill: {
          name: "unslop",
          path: "/skills/unslop/SKILL.md",
          enabled: true,
        },
        label: "/skill:unslop",
        description: "Cut AI tells from writing",
      },
    ] satisfies Array<Extract<ComposerCommandItem, { type: "slash-command" | "skill" }>>;

    expect(searchSlashCommandItems(items, "").map((item) => item.id)).toEqual([
      "slash:model",
      "skill:neopi:unslop",
    ]);
  });

  it("hides provider commands and start-only local commands after the first message line", () => {
    const items = [
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch model",
      },
      ...(["side", "btw", "clear"] as const).map((command) => ({
        id: `slash:${command}`,
        type: "slash-command" as const,
        command,
        label: `/${command}`,
        description: "Start-only local command",
      })),
      {
        id: "provider-slash-command:neopi:compact",
        type: "provider-slash-command",
        provider: nativeDriver,
        command: { name: "compact" },
        label: "/compact",
        description: "Compact the conversation",
      },
      {
        id: "skill:neopi:unslop",
        type: "skill",
        provider: nativeDriver,
        skill: {
          name: "unslop",
          path: "/skills/unslop/SKILL.md",
          enabled: true,
        },
        label: "/skill:unslop",
        description: "Cut AI tells from writing",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" | "skill" }>
    >;

    expect(slashCommandItemsForPromptPosition(items, false).map((item) => item.id)).toEqual([
      "slash:model",
      "skill:neopi:unslop",
    ]);
    expect(slashCommandItemsForPromptPosition(items, true).map((item) => item.id)).toEqual([
      "slash:model",
      "slash:side",
      "slash:btw",
      "slash:clear",
      "provider-slash-command:neopi:compact",
      "skill:neopi:unslop",
    ]);
  });
});
