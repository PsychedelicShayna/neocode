import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

const MAX_EVENTS = 256;
const MAX_BYTES = 512 * 1024;

class EventBuffer<A> {
  private readonly events = new Array<A | undefined>(MAX_EVENTS);
  private readonly sizes = new Array<number>(MAX_EVENTS).fill(0);
  private head = 0;
  private count = 0;
  private bytes = 0;
  private dropped = false;

  constructor(private readonly retainedBytes: (event: A) => number) {}

  offer(event: A): void {
    const size = this.retainedBytes(event);
    if (size > MAX_BYTES) {
      this.clear();
      this.dropped = true;
      return;
    }
    while (this.count === MAX_EVENTS || this.bytes + size > MAX_BYTES) {
      this.removeOldest();
      this.dropped = true;
    }
    const index = (this.head + this.count) % MAX_EVENTS;
    this.events[index] = event;
    this.sizes[index] = size;
    this.count += 1;
    this.bytes += size;
  }

  /** Null means the next delivery must be a resync, not a partial event history. */
  take(): ReadonlyArray<A> | null {
    if (this.dropped) {
      this.clear();
      return null;
    }
    const batch: A[] = [];
    while (this.count > 0) {
      batch.push(this.events[this.head]!);
      this.removeOldest();
    }
    return batch;
  }

  clear(): void {
    while (this.count > 0) this.removeOldest();
    this.dropped = false;
  }

  private removeOldest(): void {
    this.bytes -= this.sizes[this.head]!;
    this.events[this.head] = undefined;
    this.sizes[this.head] = 0;
    this.head = (this.head + 1) % MAX_EVENTS;
    this.count -= 1;
  }
}

/** Isolates slow subscribers without ever applying backpressure to the producer. */
export function boundedEventStream<A, B, E, R>(
  register: (listener: (event: A) => Effect.Effect<void>) => Effect.Effect<() => void, E, R>,
  resync: Effect.Effect<ReadonlyArray<B>, E, R>,
  retainedBytes: (event: A) => number,
) {
  return Stream.suspend(() => {
    const buffer = new EventBuffer<A>(retainedBytes);
    return Stream.callback<void, E, R>(
      (wake) =>
        Effect.acquireRelease(
          register((event) =>
            Effect.sync(() => buffer.offer(event)).pipe(
              Effect.andThen(Queue.offer(wake, undefined)),
              Effect.asVoid,
            ),
          ),
          (unsubscribe) =>
            Effect.sync(() => {
              unsubscribe();
              buffer.clear();
            }),
        ),
      // Queue only wakeups, never payloads. A stalled RPC must not hold the
      // producer, other resources, or healthy subscribers back.
      { bufferSize: 1, strategy: "dropping" },
    ).pipe(
      Stream.flatMap(() =>
        Stream.unwrap(
          Effect.suspend((): Effect.Effect<ReadonlyArray<A | B>, E, R> => {
            const batch = buffer.take();
            return batch === null ? resync : Effect.succeed(batch);
          }).pipe(Effect.map(Stream.fromIterable)),
        ),
      ),
    );
  });
}
