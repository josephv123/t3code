// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- The watchdog thread runs outside the Effect runtime, which lives on the main thread it watches.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";

export interface MainThreadWatchdogOptions {
  /** Slot 0 holds the main thread's last heartbeat, in `process.hrtime` nanoseconds. */
  readonly heartbeat: SharedArrayBuffer;
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly logDir: string;
  readonly stallAfterMs: number;
  readonly checkEveryMs: number;
}

export interface WatchdogState {
  /** The heartbeat the current stall started after, or null while the main thread is beating. */
  readonly stalledBeat: bigint | null;
  readonly lastCheck: bigint;
}

export type WatchdogEvent =
  | { readonly type: "main-thread-stall"; readonly stalledMs: number }
  | { readonly type: "main-thread-recovered"; readonly stalledMs: number };

const nanosToMillis = (nanos: bigint) => Number(nanos / 1_000_000n);

/**
 * `process.hrtime` is shared by every thread and pauses while the computer
 * sleeps, so a wake-up is not a stall. A check that itself ran a whole stall
 * late means the process was paused (SIGSTOP, or a sleep on a clock that kept
 * counting), which is not the main thread's fault either.
 */
export function checkHeartbeat(
  state: WatchdogState,
  now: bigint,
  beat: bigint,
  stallAfterMs: number,
): { readonly state: WatchdogState; readonly event: WatchdogEvent | null } {
  const stallAfter = BigInt(stallAfterMs) * 1_000_000n;
  if (state.stalledBeat !== null) {
    if (beat === state.stalledBeat) return { state: { ...state, lastCheck: now }, event: null };
    return {
      state: { stalledBeat: null, lastCheck: now },
      event: { type: "main-thread-recovered", stalledMs: nanosToMillis(beat - state.stalledBeat) },
    };
  }
  if (now - state.lastCheck >= stallAfter || now - beat < stallAfter) {
    return { state: { ...state, lastCheck: now }, event: null };
  }
  return {
    state: { stalledBeat: beat, lastCheck: now },
    event: { type: "main-thread-stall", stalledMs: nanosToMillis(now - beat) },
  };
}

// Which kernel wait the main thread is in tells a swap or disk wait (state D),
// a lock (futex) and an idle event loop (epoll) apart without a debugger.
function linuxMainThreadState(pid: number) {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/task/${pid}/stat`, "utf8");
    const wchan = NodeFS.readFileSync(`/proc/${pid}/task/${pid}/wchan`, "utf8");
    return { mainThreadState: stat.charAt(stat.lastIndexOf(")") + 2), mainThreadWchan: wchan };
  } catch {
    return {};
  }
}

function startMacSample(options: MainThreadWatchdogOptions): string | undefined {
  const samplePath = NodePath.join(options.logDir, `main-thread-stall-${Date.now()}.sample.txt`);
  try {
    const sample = NodeChildProcess.spawn(
      "/usr/bin/sample",
      [String(options.pid), "5", "-mayDie", "-file", samplePath],
      { stdio: "ignore" },
    );
    sample.on("error", () => undefined);
    sample.unref();
    return samplePath;
  } catch {
    return undefined;
  }
}

function start(options: MainThreadWatchdogOptions) {
  const beats = new BigInt64Array(options.heartbeat);
  const recordPath = NodePath.join(options.logDir, "main-thread-stalls.ndjson");
  let state: WatchdogState = { stalledBeat: null, lastCheck: process.hrtime.bigint() };
  // One stack per run: sampling suspends the process for every stack it takes.
  let sampled = false;
  setInterval(() => {
    const tick = checkHeartbeat(
      state,
      process.hrtime.bigint(),
      Atomics.load(beats, 0),
      options.stallAfterMs,
    );
    state = tick.state;
    if (tick.event === null) return;
    const record: Record<string, unknown> = {
      ...tick.event,
      at: new Date().toISOString(),
      pid: options.pid,
      rssBytes: process.memoryUsage.rss(),
    };
    if (tick.event.type === "main-thread-stall") {
      if (options.platform === "linux") Object.assign(record, linuxMainThreadState(options.pid));
      if (options.platform === "darwin" && !sampled) {
        sampled = true;
        record.samplePath = startMacSample(options);
      }
    }
    try {
      NodeFS.mkdirSync(options.logDir, { recursive: true });
      NodeFS.appendFileSync(recordPath, `${JSON.stringify(record)}\n`);
    } catch {
      // Nowhere left to report to.
    }
  }, options.checkEveryMs);
}

const workerOptions = NodeWorkerThreads.workerData as MainThreadWatchdogOptions | null;
// Only the watchdog worker carries a heartbeat; tests and test runners load this file too.
if (workerOptions?.heartbeat instanceof SharedArrayBuffer) start(workerOptions);
