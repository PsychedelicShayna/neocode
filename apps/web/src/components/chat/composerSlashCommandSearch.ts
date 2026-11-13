import type { NativeCommandCompletion } from "@t3tools/client-runtime/neopi-native-sessions";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { scoreProviderSkill } from "../../providerSkillSearch";

type SlashSearchItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "skill" }
>;

export interface ComposerArgumentCompletions {
  readonly command: string;
  readonly prefix: string;
  readonly source: (command: string, prefix: string) => Promise<readonly NativeCommandCompletion[]>;
  readonly items: readonly NativeCommandCompletion[];
}

/** Only offer an answer for the same request and native session that produced it. */
export function currentComposerArgumentCompletions(
  result: ComposerArgumentCompletions | null,
  command: string | undefined,
  prefix: string,
  source: ComposerArgumentCompletions["source"] | undefined,
): readonly NativeCommandCompletion[] {
  if (!result || result.command !== command || result.prefix !== prefix || result.source !== source)
    return [];
  return result.items;
}

/** Native command ownership prevents local GUI actions from consuming runtime commands. */
export function slashCommandItemsForPromptPosition(
  items: ReadonlyArray<SlashSearchItem>,
  isAtPromptStart: boolean,
  providerOwnsCommands = false,
): SlashSearchItem[] {
  return items.filter(
    (item) =>
      (!providerOwnsCommands || item.type !== "slash-command") &&
      (isAtPromptStart ||
        item.type === "skill" ||
        (item.type === "slash-command" &&
          item.command !== "side" &&
          item.command !== "btw" &&
          item.command !== "clear")),
  );
}

function scoreCommandName(value: string, query: string): number | null {
  return scoreQueryMatch({
    value: value.toLowerCase(),
    query,
    exactBase: 0,
    prefixBase: 2,
    boundaryBase: 4,
    includesBase: 6,
    fuzzyBase: 100,
    boundaryMarkers: ["-", "_", "/"],
  });
}

function scoreSlashCommandItem(item: SlashSearchItem, query: string): number | null {
  if (item.type === "skill") {
    if (query === "skill") {
      return 0;
    }
    const skillQuery = query.startsWith("skill:") ? query.slice("skill:".length) : query;
    const skillScore = skillQuery ? scoreProviderSkill(item.skill, skillQuery) : 0;
    if (skillScore !== null) {
      return skillScore;
    }
    return "skill".startsWith(query) ? Number.MAX_SAFE_INTEGER : null;
  }

  const primaryValue = item.type === "slash-command" ? item.command : item.command.name;
  const description = item.description.toLowerCase();

  const scores = [
    scoreCommandName(primaryValue, query),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  if (item.type === "provider-slash-command") {
    for (const alias of item.command.aliases ?? []) {
      const score = scoreCommandName(alias, query);
      if (score !== null) scores.push(score);
    }
  }

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

export function searchSlashCommandItems(
  items: ReadonlyArray<SlashSearchItem>,
  query: string,
): SlashSearchItem[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: SlashSearchItem;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker:
          item.type === "slash-command"
            ? `0\u0000${item.command}`
            : item.type === "provider-slash-command"
              ? `1\u0000${item.command.name}\u0000${item.provider}`
              : `2\u0000${item.skill.name}\u0000${item.provider}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
}
