import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SPEECH_POST_PROCESSING_PROMPT, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { ChildProcessSpawner } from "effect/process";
import { make as makeClient } from "effect-neopi-rpc/client";
import { makeNeoPiTextGeneration } from "../../apps/server/src/textGeneration/NeoPiTextGeneration.ts";
import { buildTranscriptionPostProcessingPrompt } from "../../apps/server/src/textGeneration/TranscriptionPostProcessing.ts";
import { cases } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
    binary: { type: "string", default: "npi" },
    profile: { type: "string" },
  },
});
const { out, model } = values;
const samples = Number(values.samples);
const fixtures = cases.filter((fixture) => !values.case || fixture.id === values.case);
if (!out || !model || !fixtures.length || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error(
    "Use --out <directory> --model <configured model> [--case <id>] [--samples <count>].",
  );
}
const Results = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      sample: Schema.Number,
      text: Schema.String,
    }),
  ),
);
const decodeResults = Schema.decodeEffect(Results);
const encodeRows = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-eval-" });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const config = yield* ServerConfig.ServerConfig;
    const service = makeNeoPiTextGeneration({
      binary: values.binary,
      attachmentsDir: config.attachmentsDir,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        ...(values.profile ? { OMP_PROFILE: values.profile } : {}),
      },
      spawn: spawner.spawn,
      makeClient,
    });
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : [];
    const results = [];
    const review = [];
    const key = [];
    for (const fixture of fixtures) {
      const start = fixture.before.length;
      const prompt = buildTranscriptionPostProcessingPrompt(
        DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
        fixture.transcript,
        {
          text: fixture.before + fixture.selection + fixture.after,
          selection: { start, end: start + fixture.selection.length },
        },
        fixture.cue,
      );
      for (let sample = 1; sample <= samples; sample++) {
        const previous = baseline.find((row) => row.id === fixture.id && row.sample === sample);
        if (values.baseline && !previous)
          throw new Error(`Missing baseline for ${fixture.id} sample ${sample}.`);
        const { transcription } = yield* service.generateTranscriptionPostProcessing({
          cwd,
          prompt,
          modelSelection: { instanceId: ProviderInstanceId.make("neopi"), model },
        });
        results.push({ id: fixture.id, sample, text: transcription });
        const first = !previous || (yield* Random.nextBoolean);
        review.push({
          ...fixture,
          sample,
          A: first ? transcription : previous?.text,
          B: first ? previous?.text : transcription,
        });
        key.push({ id: fixture.id, sample, candidate: first ? "A" : "B" });
      }
    }
    yield* fs.makeDirectory(out, { recursive: true });
    for (const [name, rows] of [
      ["results", results],
      ["review", review],
      ["answer-key", key],
    ] as const) {
      yield* fs.writeFileString(path.join(out, name + ".json"), yield* encodeRows(rows));
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
