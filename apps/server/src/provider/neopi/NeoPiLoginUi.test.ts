import { assert, it } from "@effect/vitest";
import type { UiRequestFrame } from "effect-neopi-rpc/client";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeNeoPiLoginUi, NEOPI_LOGIN_UI_LIMIT } from "./NeoPiLoginUi.ts";

const frame = (id: string, loginId?: string): UiRequestFrame => ({
  type: "extension_ui_request",
  id,
  method: "input",
  ...(loginId ? { loginId } : {}),
});

it.effect("fails a flow whose reader falls behind instead of dropping its prompts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ui = makeNeoPiLoginUi();
      const flow = yield* ui.subscribe("flow");
      for (let index = 0; index <= NEOPI_LOGIN_UI_LIMIT; index++)
        ui.publish(frame(`p${index}`, "flow"));
      const exit = yield* Stream.runCollect(flow).pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  ),
);

it.effect("keeps nothing for a flow nobody follows and stops following when the scope ends", () =>
  Effect.gen(function* () {
    const ui = makeNeoPiLoginUi();
    ui.publish(frame("early", "flow"));
    const collected = yield* Effect.scoped(
      Effect.gen(function* () {
        const flow = yield* ui.subscribe("flow");
        ui.publish(frame("unrelated"));
        ui.publish(frame("mine", "flow"));
        return yield* flow.pipe(Stream.take(1), Stream.runCollect);
      }),
    );
    assert.deepEqual(
      collected.map((item) => item.id),
      ["mine"],
    );
  }),
);
