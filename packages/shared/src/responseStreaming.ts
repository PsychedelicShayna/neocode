// An opening fence may sit at any indentation, since fences inside list
// items are indented past the marker. A closing fence may be indented at most
// three spaces more than its opener. Deeper lines are content in the block.
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
// CommonMark blank lines hold only spaces and tabs. Other whitespace, such as
// a no-break space, is paragraph content.
const BLANK_LINE_PATTERN = /^[ \t]*$/;
// A bullet or ordered marker followed by whitespace, at any indentation so
// nested items count. The trailing space is required, so a partial `-` or
// `1.` never matches before the model finishes the marker.
const LIST_ITEM_START_PATTERN = /[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/y;
// A section title: an ATX heading, or a line of only bold text, which models
// often use as a heading.
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
// An unindented ATX heading ends the paragraph or list above it, even with no
// blank line between them. A bold line would continue the paragraph instead.
const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;

const INDENT_END_PATTERN = /[^ \t]/g;
const TRAILING_SPACE_END_PATTERN = /[^ \t\r]/g;

export type AssistantParagraphScanner = (text: string) => number;

/** Tracks the same boundaries as the one-shot splitter for an append-only text block. */
export function createAssistantParagraphScanner(): AssistantParagraphScanner {
  let openFence: { marker: string; indent: number } | null = null;
  let boundary = 0;
  let lineStart = 0;
  let scannedLength = 0;
  let titleAwaitingContent = false;
  let markerStart = -1;
  let afterMarker = -1;
  let listLookaheadDone = false;
  return (text: string): number => {
    let newline = text.indexOf("\n", scannedLength);
    while (newline !== -1) {
      const line = text.slice(lineStart, newline).replace(/[ \t\r]+$/, "");
      LIST_ITEM_START_PATTERN.lastIndex = 0;
      if (
        openFence === null &&
        lineStart > 0 &&
        !titleAwaitingContent &&
        LIST_ITEM_START_PATTERN.test(line)
      ) {
        boundary = lineStart;
      }
      const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
      if (fenceMatch) {
        const indent = fenceMatch[1]!.length;
        const marker = fenceMatch[2]!;
        if (openFence === null) {
          openFence = { marker, indent };
          titleAwaitingContent = false;
        } else if (
          marker[0] === openFence.marker[0] &&
          marker.length >= openFence.marker.length &&
          indent <= openFence.indent + 3 &&
          line.length === indent + marker.length
        ) {
          // CommonMark: a closing fence carries no info string.
          openFence = null;
          boundary = newline + 1;
        }
      } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
        if (!titleAwaitingContent) {
          boundary = newline + 1;
        }
      } else if (openFence === null) {
        if (lineStart > 0 && !titleAwaitingContent && TOP_LEVEL_HEADING_PATTERN.test(line)) {
          boundary = lineStart;
        }
        titleAwaitingContent = SECTION_TITLE_PATTERN.test(line);
      }
      lineStart = newline + 1;
      newline = text.indexOf("\n", lineStart);
      markerStart = afterMarker = -1;
      listLookaheadDone = false;
    }

    // Tight lists expose the previous item before the new item ends. Only
    // the marker (at most 11 characters) may be inspected again on append.
    if (openFence === null && lineStart > 0 && !titleAwaitingContent && !listLookaheadDone) {
      const start = Math.max(lineStart, scannedLength);
      if (markerStart === -1) {
        INDENT_END_PATTERN.lastIndex = start;
        markerStart = INDENT_END_PATTERN.exec(text)?.index ?? -1;
      }
      if (markerStart !== -1 && afterMarker === -1) {
        LIST_ITEM_START_PATTERN.lastIndex = markerStart;
        if (LIST_ITEM_START_PATTERN.test(text)) afterMarker = LIST_ITEM_START_PATTERN.lastIndex;
        else if (text.length >= markerStart + 11) listLookaheadDone = true;
      }
      if (afterMarker !== -1) {
        TRAILING_SPACE_END_PATTERN.lastIndex = Math.max(start, afterMarker);
        if (TRAILING_SPACE_END_PATTERN.test(text)) {
          boundary = lineStart;
          listLookaheadDone = true;
        }
      }
    }
    scannedLength = text.length;
    return boundary;
  };
}

/**
 * Splits buffered assistant text at the last blank line, closing code fence,
 * or list item start that is not inside an open fenced code block. `ready` is
 * safe to deliver now because the markdown before it will not change shape as
 * more text arrives. `rest` stays buffered until the next boundary or
 * completion. Only fully terminated lines count, so a trailing partial line
 * never leaks; a list item start is the one lookahead that may sit on the
 * partial line, since tight lists have no blank lines between items and would
 * otherwise land all at once.
 *
 * A section title holds the boundary until a content line follows it, so a
 * title never lands alone and waits above a block that is still streaming.
 */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  const boundary = createAssistantParagraphScanner()(text);
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}
