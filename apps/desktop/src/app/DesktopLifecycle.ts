import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export class DesktopLifecycleRelaunchError extends Schema.TaggedError<DesktopLifecycleRelaunchError>()(
  "DesktopLifecycleRelaunchError",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop relaunch failed for reason "${this.reason}".`;
  }
}

export type DesktopLifecycleRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme;

type DesktopLifecycleRegistrationServices =
  | DesktopLifecycleRuntimeServices
  | ElectronWindow.ElectronWindow;

/**
 * @effect-expect-leaking DesktopEnvironment | DesktopShutdown | DesktopState | DesktopWindow | ElectronApp | ElectronTheme | ElectronWindow
 */
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly relaunch: (
      reason: string,
    ) => Effect.Effect<void, never, DesktopLifecycleRuntimeServices>;
    readonly register: Effect.Effect<
      void,
      never,
      Scope.Scope | DesktopLifecycleRegistrationServices
    >;
  }
>()("@t3tools/desktop/app/DesktopLifecycle") {}

const {
  logInfo: logLifecycleInfo,
  logWarning: logLifecycleWarning,
  logError: logLifecycleError,
} = makeComponentLogger("desktop-lifecycle");

// Quitting waits for the window bounds write and for every shutdown finalizer,
// the last of which stops the backends. Nothing bounds that wait as a whole (a
// backend stop takes the instance lock before its own timeout starts), so past
// this deadline the app exits without them rather than hold quit, or a macOS
// logout, until the user force-quits. Keep it above the stop timeout in
// DesktopApp.stopAllPoolInstances so a slow but healthy backend stop finishes.
export const SHUTDOWN_DEADLINE = Duration.seconds(10);
// app.exit() skips the finalizer that flushes the trace file, which is written
// in one-second batches. Waiting out two batches keeps the deadline warning.
export const SHUTDOWN_DEADLINE_LOG_FLUSH = Duration.seconds(2);

function addScopedListener<Args extends ReadonlyArray<unknown>>(
  target: unknown,
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> {
  const eventTarget = target as {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
  };
  const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
  return Effect.acquireRelease(
    Effect.sync(() => {
      eventTarget.on(eventName, untypedListener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(eventName, untypedListener);
      }),
  ).pipe(Effect.asVoid);
}

/** Succeeds with `false` when the shutdown missed `SHUTDOWN_DEADLINE`. */
const requestDesktopShutdownAndWait = Effect.fn("desktop.lifecycle.requestShutdownAndWait")(
  function* (
    afterBoundsFlush: Effect.Effect<void> = Effect.void,
  ): Effect.fn.Return<
    boolean,
    never,
    DesktopShutdown.DesktopShutdown | DesktopWindow.DesktopWindow
  > {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    let step = "saving window bounds";
    // Await a fork rather than time the steps in place: a timeout waits for the
    // effect it interrupts, so a stuck uninterruptible step would hold it too.
    const steps = yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* desktopWindow.flushMainWindowBounds;
        step = "closing windows";
        yield* afterBoundsFlush;
        step = "stopping backends and services";
        yield* shutdown.request;
        yield* shutdown.awaitComplete;
      }),
    );
    const finished = Option.isSome(
      yield* Fiber.join(steps).pipe(Effect.timeoutOption(SHUTDOWN_DEADLINE)),
    );
    if (!finished) {
      // Its own span, so the warning is recorded before the exit that follows.
      yield* logLifecycleWarning("shutdown missed its deadline; exiting anyway", {
        step,
        deadlineMs: Duration.toMillis(SHUTDOWN_DEADLINE),
      }).pipe(Effect.withSpan("desktop.lifecycle.shutdownDeadline"));
      // The stuck step may come before the request. Backends then still get
      // their stop signal while the warning is written.
      yield* shutdown.request;
      yield* Effect.sleep(SHUTDOWN_DEADLINE_LOG_FLUSH);
    }
    return finished;
  },
);

// After a missed deadline the windows and quit listeners may still be in place,
// and quit() would wait on them again. exit() closes windows without asking.
const leaveAfterShutdown = (finished: boolean) =>
  Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    yield* finished ? electronApp.quit : electronApp.exit(0);
  });

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
  allowQuit: () => boolean,
  markQuitAllowed: () => void,
): void {
  if (allowQuit()) {
    void runEffect(
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);
        yield* logLifecycleInfo("before-quit received");
      }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
    );
    return;
  }

  event.preventDefault();
  let shutdownFinished = true;
  void runEffect(
    Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* Ref.set(state.quitting, true);
      yield* logLifecycleInfo("before-quit received");
      shutdownFinished = yield* requestDesktopShutdownAndWait(
        electronWindow.destroyAll.pipe(
          Effect.catchCause((cause) =>
            logLifecycleError("failed to destroy windows before shutdown", { cause }),
          ),
        ),
      );
    }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
  ).finally(() => {
    markQuitAllowed();
    void runEffect(
      leaveAfterShutdown(shutdownFinished).pipe(
        Effect.withSpan("desktop.lifecycle.quitAfterShutdown"),
      ),
    );
  });
}

function quitFromSignal(
  signal: "SIGINT" | "SIGTERM",
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
): void {
  void runEffect(
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ signal });
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      yield* logLifecycleInfo("process signal received", { signal });
      yield* leaveAfterShutdown(yield* requestDesktopShutdownAndWait());
    }).pipe(Effect.withSpan("desktop.lifecycle.processSignal")),
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = DesktopLifecycle.of({
  relaunch: Effect.fn("desktop.lifecycle.relaunch")(function* (reason) {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const state = yield* DesktopState.DesktopState;
    yield* logLifecycleInfo("desktop relaunch requested", { reason });
    yield* Effect.gen(function* () {
      yield* Effect.yieldNow;
      yield* Ref.set(state.quitting, true);
      yield* requestDesktopShutdownAndWait();
      if (environment.isDevelopment) {
        yield* electronApp.exit(75);
        return;
      }
      yield* electronApp.relaunch({
        execPath: process.execPath,
        args: process.argv.slice(1),
      });
      yield* electronApp.exit(0);
    }).pipe(
      Effect.catchCause((cause) => {
        const error = new DesktopLifecycleRelaunchError({ reason, cause });
        return logLifecycleError(error.message, { error });
      }),
      Effect.forkDetach,
      Effect.asVoid,
    );
  }),
  register: Effect.gen(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const context = yield* Effect.context<DesktopLifecycleRegistrationServices>();
    const runEffect = Effect.runPromiseWith(context);
    let quitAllowed = false;
    let updaterQuitAllowed = false;
    yield* electronTheme.onUpdated(() => {
      void runEffect(
        desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
      );
    });
    yield* electronApp.onBeforeQuitForUpdate(() => {
      // Electron's updater owns the remaining quit/install/relaunch sequence.
      // Cancelling the following app "before-quit" event breaks that sequence,
      // most visibly on macOS where the native updater performs the relaunch.
      updaterQuitAllowed = true;
      // This event is synchronous and the updater's quit proceeds as soon as
      // the listener returns, so a forked destroyAll would race the quit
      // and windows could still be open when the process exits (visible on
      // macOS). Destroy them inline.
      Effect.runSyncWith(context)(
        electronWindow.destroyAll.pipe(
          Effect.andThen(logLifecycleInfo("allowing updater-controlled quit")),
          Effect.catchCause((cause) =>
            logLifecycleError("failed to destroy windows before updater quit", { cause }),
          ),
          Effect.withSpan("desktop.lifecycle.beforeQuitForUpdate"),
        ),
      );
    });
    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      handleBeforeQuit(
        event,
        runEffect,
        () => quitAllowed || updaterQuitAllowed,
        () => {
          quitAllowed = true;
        },
      );
    });
    yield* electronApp.on("activate", () => {
      void runEffect(
        Effect.gen(function* () {
          const state = yield* DesktopState.DesktopState;
          if (yield* Ref.get(state.quitting)) return;
          yield* desktopWindow.activate;
        }).pipe(Effect.withSpan("desktop.lifecycle.activate")),
      );
    });
    yield* electronApp.on("window-all-closed", () => {
      void runEffect(
        Effect.gen(function* () {
          const app = yield* ElectronApp.ElectronApp;
          const state = yield* DesktopState.DesktopState;
          if (environment.platform !== "darwin" && !(yield* Ref.get(state.quitting))) {
            yield* app.quit;
          }
        }).pipe(Effect.withSpan("desktop.lifecycle.windowAllClosed")),
      );
    });

    if (environment.platform !== "win32") {
      yield* addScopedListener(process, "SIGINT", () => {
        quitFromSignal("SIGINT", runEffect);
      });
      yield* addScopedListener(process, "SIGTERM", () => {
        quitFromSignal("SIGTERM", runEffect);
      });
    }
  }).pipe(Effect.withSpan("desktop.lifecycle.register")),
});

export const layer = Layer.succeed(DesktopLifecycle, make);
