import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

/**
 * Incremental line reader for a file that another process keeps appending to
 * (Git's `GIT_TRACE2_EVENT` target).
 *
 * Each `readLines` reads only the bytes past the last consumed offset, so the
 * total I/O is linear in the file size. Lines are split on the raw 0x0A byte,
 * which never occurs inside a multi-byte UTF-8 sequence, so a character split
 * across two reads is decoded whole. Bytes after the last newline are held back
 * until their line completes or `takeRemainder` drains them.
 */
export interface TraceTail {
  /** Complete lines appended since the previous call, without `\r`/`\n`. */
  readonly readLines: Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError>;
  /** The unterminated trailing line, if any. Clears it. */
  readonly takeRemainder: Effect.Effect<string>;
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function decodeLines(bytes: Uint8Array): string[] {
  const lines = decoder.decode(bytes).split("\n");
  // `bytes` ends with a newline, so the final element is the empty tail.
  lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export const makeTraceTail = Effect.fnUntraced(function* (
  filePath: string,
): Effect.fn.Return<TraceTail, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const mutex = yield* Semaphore.make(1);

  // Only touched while holding `mutex`, in the uninterruptible commit step.
  let offset = 0;
  let inode: number | null = null;
  let pending: Uint8Array[] = [];

  const readLines = mutex.withPermit(
    Effect.gen(function* () {
      const info = yield* fs.stat(filePath);
      const size = Number(info.size);
      const nextInode = Option.getOrNull(info.ino);
      // Shrunk or replaced: the old offset points into a different file.
      const restart =
        size < offset || (inode !== null && nextInode !== null && inode !== nextInode);
      const from = restart ? 0 : offset;
      if (size === from) {
        if (restart) {
          offset = 0;
          inode = nextInode;
          pending = [];
        }
        return [] as ReadonlyArray<string>;
      }

      const chunks: Uint8Array[] = [];
      yield* fs
        .stream(filePath, { offset: from, bytesToRead: size - from })
        .pipe(Stream.runForEach((chunk) => Effect.sync(() => void chunks.push(chunk))));

      return yield* Effect.uninterruptible(
        Effect.sync(() => {
          if (restart) pending = [];
          inode = nextInode ?? inode;
          let read = 0;
          const lines: string[] = [];
          for (const chunk of chunks) {
            read += chunk.length;
            const lastNewline = chunk.lastIndexOf(NEWLINE);
            if (lastNewline === -1) {
              pending.push(chunk);
              continue;
            }
            const complete = concatBytes([...pending, chunk.subarray(0, lastNewline + 1)]);
            const rest = chunk.subarray(lastNewline + 1);
            pending = rest.length > 0 ? [rest] : [];
            for (const line of decodeLines(complete)) lines.push(line);
          }
          offset = from + read;
          return lines;
        }),
      );
    }),
  );

  const takeRemainder = mutex.withPermit(
    Effect.sync(() => {
      const bytes = pending.length === 0 ? new Uint8Array(0) : concatBytes(pending);
      pending = [];
      return decoder.decode(bytes);
    }),
  );

  return { readLines, takeRemainder } satisfies TraceTail;
});
