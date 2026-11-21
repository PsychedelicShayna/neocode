import type { AssistantRow } from "@t3tools/client-runtime/neopi-transcript";
import { expect, it } from "vite-plus/test";
import { createNativeTimelineProjector } from "./nativeTimeline";

// From apps/web: NEOPI_PARAGRAPH_BENCH=1 vp test run --project unit --maxWorkers=1 src/components/neopi/nativeTimeline.bench.test.ts
it.skipIf(process.env.NEOPI_PARAGRAPH_BENCH !== "1")(
  "profiles the native timeline projection across 2,000 deltas and 50 paragraphs",
  () => {
    const timestamp = "2026-03-17T19:12:28.000Z";
    const entry = { id: "a", parentId: null, timestamp, type: "message" } as const;
    const rows: AssistantRow[] = [];
    let body = "";
    for (let index = 1; index <= 2_000; index++) {
      body += "Several words arrive from the provider. ";
      if (index % 40 === 0) body += "\n\n";
      rows.push({
        kind: "assistant",
        id: "a:0",
        entry,
        timestamp,
        live: true,
        text: body,
        textAppendGeneration: "single-provider-stream",
        images: [],
        meta: null,
      });
    }
    const samples = {
      paragraph: [[], [], [], []] as number[][],
      token: [[], [], [], []] as number[][],
    };
    for (let trial = 0; trial < 14; trial++) {
      for (const mode of trial % 2
        ? (["paragraph", "token"] as const)
        : (["token", "paragraph"] as const)) {
        const project = createNativeTimelineProjector();
        let visibleRefs = 0;
        let previous: object | undefined;
        let finalLength = 0;
        for (let quarter = 0; quarter < 4; quarter++) {
          const start = performance.now();
          for (let index = quarter * 500; index < (quarter + 1) * 500; index++) {
            const result = project([{ ...rows[index]! }], true, undefined, false, mode);
            const visible = result.entries.at(-1);
            if (visible !== previous) visibleRefs++;
            previous = visible;
            finalLength = visible?.kind === "message" ? visible.message.text.length : 0;
          }
          const microsPerDelta = (performance.now() - start) * 2;
          if (trial >= 3) samples[mode][quarter]!.push(microsPerDelta);
        }
        expect(finalLength).toBe(body.length);
        expect(visibleRefs).toBe(mode === "paragraph" ? 50 : 2_000);
      }
    }
    for (const mode of ["paragraph", "token"] as const) {
      const medianMicrosPerDeltaByQuarter = samples[mode].map(
        (quarter) => quarter.toSorted((a, b) => a - b)[Math.floor(quarter.length / 2)],
      );
      process.stdout.write(
        `${JSON.stringify({ mode, bodyChars: body.length, medianMicrosPerDeltaByQuarter, samples: samples[mode] })}\n`,
      );
    }
  },
);
