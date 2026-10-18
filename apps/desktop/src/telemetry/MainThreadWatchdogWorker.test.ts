import { assert, describe, it } from "@effect/vitest";

import {
  checkHeartbeat,
  type WatchdogEvent,
  type WatchdogState,
} from "./MainThreadWatchdogWorker.ts";

const STALL_AFTER_MS = 10_000;
const seconds = (value: number) => BigInt(value * 1_000_000_000);

/** Runs one check per second of `now`, with the heartbeat each check sees. */
function run(beats: ReadonlyArray<readonly [now: number, beat: number]>) {
  let state: WatchdogState = { stalledBeat: null, lastCheck: seconds(beats[0]![0] - 1) };
  const events: Array<readonly [number, WatchdogEvent]> = [];
  for (const [now, beat] of beats) {
    const tick = checkHeartbeat(state, seconds(now), seconds(beat), STALL_AFTER_MS);
    state = tick.state;
    if (tick.event !== null) events.push([now, tick.event]);
  }
  return events;
}

describe("checkHeartbeat", () => {
  it("reports a stall once and its length when the main thread beats again", () => {
    const beats = Array.from({ length: 14 }, (_, index) => [index + 1, 0] as const);
    const events = run([...beats, [15, 14.5], [16, 15.5]]);

    assert.deepEqual(events, [
      [10, { type: "main-thread-stall", stalledMs: 10_000 }],
      [15, { type: "main-thread-recovered", stalledMs: 14_500 }],
    ]);
  });

  it("stays quiet while the main thread beats", () => {
    const beats = Array.from({ length: 30 }, (_, index) => [index + 1, index + 0.5] as const);
    assert.deepEqual(run(beats), []);
  });

  it("does not blame the main thread when the whole process was paused", () => {
    // Nothing ran between 1 s and 61 s (SIGSTOP, or a sleep on a clock that kept counting).
    assert.deepEqual(
      run([
        [1, 0.5],
        [61, 0.5],
        [62, 61.5],
      ]),
      [],
    );
  });
});
