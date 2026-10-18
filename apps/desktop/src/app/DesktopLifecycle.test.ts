import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

function layerElectronApp(
  appListeners: Map<string, (...args: readonly unknown[]) => void>,
  quit: Effect.Effect<void> = Effect.void,
  exit: (code: number) => Effect.Effect<void> = () => Effect.void,
) {
  const registerListener = (eventName: string, listener: (...args: readonly unknown[]) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        appListeners.set(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          appListeners.delete(eventName);
        }),
    ).pipe(Effect.asVoid);

  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    quit,
    exit,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: (listener) => registerListener("before-quit-for-update", listener),
    on: (eventName, listener) =>
      registerListener(eventName, listener as unknown as (...args: readonly unknown[]) => void),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
});

function layerElectronWindow(destroyAll: Effect.Effect<void> = Effect.void) {
  return Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: Effect.die("unexpected main window read"),
    currentMainOrFirst: Effect.die("unexpected current window read"),
    focusedMainOrFirst: Effect.die("unexpected focused window read"),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll,
    syncAllAppearance: () => Effect.void,
  });
}

function layerDesktopWindow(
  input: {
    readonly activate?: Effect.Effect<void>;
    readonly flushMainWindowBounds?: Effect.Effect<void>;
  } = {},
) {
  return Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: input.activate ?? Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: input.flushMainWindowBounds ?? Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: () => Effect.void,
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: () => Effect.void,
    runMainContentsCommand: () => Effect.void,
    syncAppearance: Effect.void,
  });
}

describe("DesktopLifecycle", () => {
  it.effect.each(["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "lets the updater's quit event proceed on %s",
    (platform) => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let windowsDestroyed = false;
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(
          layerElectronWindow(
            Effect.sync(() => {
              windowsDestroyed = true;
            }),
          ),
        ),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();
          yield* Effect.yieldNow;

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );
          assert.isTrue(windowsDestroyed);

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    },
  );

  it.effect("destroys windows before waiting for backend shutdown", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const shutdownRequested = yield* Deferred.make<void>();
      const allowShutdown = yield* Deferred.make<void>();
      const quitRequested = yield* Deferred.make<void>();
      const events: string[] = [];

      const quit = Effect.sync(() => {
        events.push("quit");
      }).pipe(Effect.andThen(Deferred.succeed(quitRequested, undefined)), Effect.asVoid);
      const exit = (code: number) =>
        Effect.sync(() => {
          events.push(`exit ${code}`);
        });
      const destroyAll = Effect.sync(() => {
        events.push("destroy");
      });
      const flushMainWindowBounds = Effect.sync(() => {
        events.push("flush");
      });

      const layerDesktopShutdown = Layer.succeed(DesktopShutdown.DesktopShutdown, {
        request: Effect.sync(() => {
          events.push("request");
        }).pipe(Effect.andThen(Deferred.succeed(shutdownRequested, undefined)), Effect.asVoid),
        awaitRequest: Deferred.await(shutdownRequested),
        markComplete: Deferred.succeed(allowShutdown, undefined).pipe(Effect.asVoid),
        awaitComplete: Deferred.await(allowShutdown),
        isComplete: Deferred.isDone(allowShutdown),
      });

      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners, quit, exit)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow(destroyAll)),
        Layer.provideMerge(layerDesktopWindow({ flushMainWindowBounds })),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(layerDesktopShutdown),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          const event = { preventDefault: () => undefined } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          yield* Deferred.await(shutdownRequested);
          const eventsBeforeCleanup = [...events];
          yield* Deferred.succeed(allowShutdown, undefined);
          yield* Deferred.await(quitRequested);

          assert.deepEqual(eventsBeforeCleanup, ["flush", "destroy", "request"]);
          assert.deepEqual(events, ["flush", "destroy", "request", "quit"]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect.each([
    { stuckOn: "flushMainWindowBounds", step: "saving window bounds" },
    { stuckOn: "awaitComplete", step: "stopping backends and services" },
  ] as const)("exits at the shutdown deadline when $stuckOn never finishes", ({ stuckOn, step }) =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const stepReached = yield* Deferred.make<void>();
      const shutdownRequested = yield* Deferred.make<void>();
      const exitCode = yield* Deferred.make<number>();
      const warnings = yield* Queue.unbounded<Record<string, unknown>>();
      let quitCount = 0;

      const stuck = Deferred.succeed(stepReached, undefined).pipe(Effect.andThen(Effect.never));
      const layerDesktopShutdown = Layer.succeed(DesktopShutdown.DesktopShutdown, {
        request: Deferred.succeed(shutdownRequested, undefined).pipe(Effect.asVoid),
        awaitRequest: Deferred.await(shutdownRequested),
        markComplete: Effect.void,
        awaitComplete: stuckOn === "awaitComplete" ? stuck : Effect.void,
        isComplete: Effect.succeed(false),
      });
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const logger = Logger.make(({ logLevel, fiber }) => {
        if (logLevel === "Warn") {
          Queue.offerUnsafe(warnings, fiber.getRef(References.CurrentLogAnnotations));
        }
      });

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(
          layerElectronApp(
            appListeners,
            Effect.sync(() => {
              quitCount += 1;
            }),
            (code) => Deferred.succeed(exitCode, code).pipe(Effect.asVoid),
          ),
        ),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(
          layerDesktopWindow({
            flushMainWindowBounds: stuckOn === "flushMainWindowBounds" ? stuck : Effect.void,
          }),
        ),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(layerDesktopShutdown),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit")?.({ preventDefault: () => undefined } as Electron.Event);
          yield* Deferred.await(stepReached);

          // A slow but healthy shutdown keeps the whole deadline.
          yield* TestClock.adjust(
            Duration.subtract(DesktopLifecycle.SHUTDOWN_DEADLINE, Duration.millis(1)),
          );
          assert.equal(yield* Queue.size(warnings), 0);

          yield* TestClock.adjust(Duration.millis(1));
          const warning = yield* Queue.take(warnings);
          assert.equal(warning.component, "desktop-lifecycle");
          assert.equal(warning.step, step);

          yield* TestClock.adjust(DesktopLifecycle.SHUTDOWN_DEADLINE_LOG_FLUSH);
          assert.equal(yield* Deferred.await(exitCode), 0);
          assert.equal(quitCount, 0);
          assert.isTrue(
            yield* Deferred.isDone(shutdownRequested),
            "backends get their stop request even when an earlier step is stuck",
          );
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(layer, Logger.layer([logger], { mergeWithExisting: false }))),
      );
    }),
  );

  it.effect("ignores app activation while quitting", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let activationCount = 0;
      const activate = Effect.sync(() => {
        activationCount += 1;
      });
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(layerDesktopWindow({ activate })),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          yield* Ref.set(state.quitting, true);

          appListeners.get("activate")?.();

          assert.equal(activationCount, 0);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
