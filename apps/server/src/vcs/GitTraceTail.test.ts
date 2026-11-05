import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { makeTraceTail } from "./GitTraceTail.ts";

interface StreamCall {
  readonly offset: number;
  readonly bytesToRead: number | undefined;
}

// Records how the tailer reads the file, so tests can assert it never rereads.
const makeSpiedFileSystem = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const streamCalls: StreamCall[] = [];
  let wholeFileReads = 0;
  const spied: FileSystem.FileSystem = Object.assign({}, fs, {
    stream: (path: string, options?: Parameters<FileSystem.FileSystem["stream"]>[1]) => {
      streamCalls.push({
        offset: Number(options?.offset ?? 0),
        bytesToRead: options?.bytesToRead === undefined ? undefined : Number(options.bytesToRead),
      });
      return fs.stream(path, options);
    },
    readFile: (...args: Parameters<FileSystem.FileSystem["readFile"]>) => {
      wholeFileReads += 1;
      return fs.readFile(...args);
    },
    readFileString: (...args: Parameters<FileSystem.FileSystem["readFileString"]>) => {
      wholeFileReads += 1;
      return fs.readFileString(...args);
    },
  });
  return { fs, spied, streamCalls, wholeFileReads: () => wholeFileReads };
});

const encode = (text: string) => new TextEncoder().encode(text);

const setup = Effect.gen(function* () {
  const { fs, spied, streamCalls, wholeFileReads } = yield* makeSpiedFileSystem;
  const file = yield* fs.makeTempFileScoped({ prefix: "git-trace-tail-test-", suffix: ".json" });
  const tail = yield* makeTraceTail(file).pipe(Effect.provideService(FileSystem.FileSystem, spied));
  const append = (bytes: Uint8Array) => fs.writeFile(file, bytes, { flag: "a" });
  return { fs, file, tail, append, streamCalls, wholeFileReads };
});

it.layer(NodeServices.layer)("makeTraceTail", (it) => {
  it.effect("reads each appended byte once instead of rereading the file", () =>
    Effect.gen(function* () {
      const { tail, append, streamCalls, wholeFileReads } = yield* setup;

      const collected: string[] = [];
      const appendedBytes: number[] = [];
      for (let i = 0; i < 50; i += 1) {
        const line = `{"event":"child_start","child_id":${i}}\n`;
        appendedBytes.push(encode(line).length);
        yield* append(encode(line));
        collected.push(...(yield* tail.readLines));
      }

      assert.strictEqual(collected.length, 50);
      assert.strictEqual(collected[0], '{"event":"child_start","child_id":0}');
      assert.strictEqual(collected[49], '{"event":"child_start","child_id":49}');
      assert.strictEqual(wholeFileReads(), 0);
      // One bounded read per append, each starting where the last one ended.
      assert.strictEqual(streamCalls.length, 50);
      let expectedOffset = 0;
      streamCalls.forEach((call, index) => {
        assert.strictEqual(call.offset, expectedOffset);
        assert.strictEqual(call.bytesToRead, appendedBytes[index]);
        expectedOffset += appendedBytes[index]!;
      });
    }),
  );

  it.effect("skips the read when nothing was appended", () =>
    Effect.gen(function* () {
      const { tail, append, streamCalls } = yield* setup;
      yield* append(encode("one\n"));
      assert.deepStrictEqual(yield* tail.readLines, ["one"]);
      assert.deepStrictEqual(yield* tail.readLines, []);
      assert.strictEqual(streamCalls.length, 1);
    }),
  );

  it.effect("holds back a partial trailing line until it completes", () =>
    Effect.gen(function* () {
      const { tail, append } = yield* setup;
      yield* append(encode("first\nsec"));
      assert.deepStrictEqual(yield* tail.readLines, ["first"]);
      yield* append(encode("ond\r\nthi"));
      assert.deepStrictEqual(yield* tail.readLines, ["second"]);
      yield* append(encode("rd\n"));
      assert.deepStrictEqual(yield* tail.readLines, ["third"]);
    }),
  );

  it.effect("decodes a multi-byte character split across two appends", () =>
    Effect.gen(function* () {
      const { tail, append } = yield* setup;
      const bytes = encode('{"hook_name":"pré-commit ✓ 🚀"}\n');
      // Cut inside the 4-byte rocket emoji.
      const cut = bytes.length - 4;
      yield* append(bytes.subarray(0, cut));
      assert.deepStrictEqual(yield* tail.readLines, []);
      yield* append(bytes.subarray(cut));
      assert.deepStrictEqual(yield* tail.readLines, ['{"hook_name":"pré-commit ✓ 🚀"}']);
    }),
  );

  it.effect("returns several lines from a single read", () =>
    Effect.gen(function* () {
      const { tail, append } = yield* setup;
      yield* append(encode("a\n\nb\nc"));
      assert.deepStrictEqual(yield* tail.readLines, ["a", "", "b"]);
      assert.strictEqual(yield* tail.takeRemainder, "c");
    }),
  );

  it.effect("takeRemainder drains the unterminated line once", () =>
    Effect.gen(function* () {
      const { tail, append } = yield* setup;
      yield* append(encode("done\nlast without newline"));
      assert.deepStrictEqual(yield* tail.readLines, ["done"]);
      assert.strictEqual(yield* tail.takeRemainder, "last without newline");
      assert.strictEqual(yield* tail.takeRemainder, "");
      assert.deepStrictEqual(yield* tail.readLines, []);
    }),
  );

  it.effect("restarts from the beginning when the file is truncated", () =>
    Effect.gen(function* () {
      const { fs, file, tail, append } = yield* setup;
      yield* append(encode("old line one\nold line two\npartial"));
      assert.deepStrictEqual(yield* tail.readLines, ["old line one", "old line two"]);

      yield* fs.writeFileString(file, "new\n");
      assert.deepStrictEqual(yield* tail.readLines, ["new"]);
      // The stale "partial" remainder from before the truncation is dropped.
      assert.strictEqual(yield* tail.takeRemainder, "");

      yield* append(encode("after\n"));
      assert.deepStrictEqual(yield* tail.readLines, ["after"]);
    }),
  );

  it.effect("restarts when the file is replaced by a different, larger file", () =>
    Effect.gen(function* () {
      const { fs, file, tail, append } = yield* setup;
      yield* append(encode("old\n"));
      assert.deepStrictEqual(yield* tail.readLines, ["old"]);

      // Renamed over the old file, so the inode necessarily differs (a removed
      // file's inode may be reused by the next one created).
      const replacement = yield* fs.makeTempFileScoped({ prefix: "git-trace-tail-new-" });
      yield* fs.writeFileString(replacement, "replacement one\nreplacement two\n");
      yield* fs.rename(replacement, file);
      assert.deepStrictEqual(yield* tail.readLines, ["replacement one", "replacement two"]);
    }),
  );
});
