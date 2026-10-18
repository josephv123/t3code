// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node worker.
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import type { MainThreadWatchdogOptions } from "./MainThreadWatchdogWorker.ts";

const HEARTBEAT_INTERVAL = Duration.seconds(1);
// Well past a major GC or a slow synchronous Electron call.
const STALL_AFTER = Duration.seconds(10);

const { logWarning } = makeComponentLogger("desktop-main-thread-watchdog");

/**
 * Records main-thread stalls to `main-thread-stalls.ndjson` in the log
 * directory, with a `sample` of the process on macOS. The check runs on a
 * worker thread because a stalled main thread cannot report on itself.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const heartbeat = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
    const beats = new BigInt64Array(heartbeat);
    const beat = Effect.sync(() => {
      Atomics.store(beats, 0, process.hrtime.bigint());
    });
    yield* beat;
    const workerData: MainThreadWatchdogOptions = {
      heartbeat,
      pid: process.pid,
      platform: environment.platform,
      logDir: environment.logDir,
      stallAfterMs: Duration.toMillis(STALL_AFTER),
      checkEveryMs: Duration.toMillis(HEARTBEAT_INTERVAL),
    };
    const worker = yield* Effect.acquireRelease(
      Effect.try(
        () =>
          new NodeWorkerThreads.Worker(
            NodePath.join(__dirname, "telemetry", "MainThreadWatchdogWorker.cjs"),
            { workerData },
          ),
      ),
      (worker) => Effect.promise(() => worker.terminate()),
    );
    // The watchdog must never be what delays an exit.
    worker.unref();
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    worker.on("error", (cause) => {
      runFork(logWarning("main thread watchdog stopped", { cause }));
    });
    yield* beat.pipe(Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)), Effect.forkScoped);
  }).pipe(Effect.catch((cause) => logWarning("main thread watchdog unavailable", { cause }))),
);
