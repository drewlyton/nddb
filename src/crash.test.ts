import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Crash injection against the *built* library, because the fault has to cross
 * a real process boundary. The build goes to a temp directory so this suite
 * can never race or dirty the repo's `dist/`.
 *
 * The honest claim here concerns process death, not power loss: a SIGKILLed
 * writer's completed writes are already in the shared page cache (#20), so
 * what these tests prove is recovery from a dead writer and from a torn tail.
 * The torn tail is injected at the fault point (see crash-child.mjs) — no
 * SIGKILL can produce one from a completed single write(2).
 */
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const childPath = fileURLToPath(new URL("./crash-child.mjs", import.meta.url));
const READY_TIMEOUT_MS = 10_000;

type Durability = import("./db.js").Durability;
type Open = typeof import("./db.js").open;

let buildDir: string;
let indexUrl: string;
let open: Open;

const dirs: string[] = [];
const children = new Set<ChildProcess>();

const newDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "nddb-crash-"));
  dirs.push(dir);
  return join(dir, "db.ndjson");
};

type ChildRun = {
  readonly acks: readonly string[];
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
};

/**
 * Run the fault-injection child and SIGKILL it once it reports `ready`.
 *
 * The child writes every ack before `ready`, so seeing the marker means the
 * fault point is reached and every acknowledged write already happened. A
 * watchdog kills a child that never reaches the fault point, so a hung child
 * fails the test rather than the suite.
 */
const runChild = (
  dbPath: string,
  durability: Durability,
  count: number,
  mode: "none" | "torn",
): Promise<ChildRun> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [childPath, indexUrl, dbPath, durability, String(count), mode],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(child);

    let stdout = "";
    let stderr = "";
    let killed = false;

    const stop = (): void => {
      if (!killed) {
        killed = true;
        child.kill("SIGKILL");
      }
    };
    const watchdog = setTimeout(stop, READY_TIMEOUT_MS);
    watchdog.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("ready\n")) {
        stop();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(watchdog);
      children.delete(child);
      reject(error);
    });
    child.on("exit", (_code, signal) => {
      clearTimeout(watchdog);
      children.delete(child);
      const acks = stdout
        .split("\n")
        .filter((line) => line.startsWith("ack "))
        .map((line) => line.slice("ack ".length));
      resolve({ acks, signal, stderr });
    });
  });

/** A reopened handle must see every id the dead child acknowledged. */
const expectAckedSurvive = (acked: readonly string[], dbPath: string): void => {
  const db = open(dbPath);
  try {
    for (const id of acked) {
      expect(db.get(id), `acked id ${id} was lost`).toBeDefined();
    }
  } finally {
    db.close();
  }
};

beforeAll(async () => {
  buildDir = mkdtempSync(join(tmpdir(), "nddb-crash-build-"));
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", buildDir], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  indexUrl = pathToFileURL(join(buildDir, "index.js")).href;
  open = ((await import(indexUrl)) as typeof import("./db.js")).open;
}, 120_000);

afterEach(() => {
  // A test that timed out may leave the child blocked; kill and reap it so a
  // failure cannot leak a spinning process.
  for (const child of children) {
    child.kill("SIGKILL");
  }
  children.clear();
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

describe.each(["buffered", "strict"] as const)("%s writer, SIGKILLed", (durability) => {
  it("keeps every acknowledged write and a clean tail", async () => {
    const dbPath = newDbPath();
    const count = 200;

    const run = await runChild(dbPath, durability, count, "none");
    expect(run.signal, run.stderr).toBe("SIGKILL");
    expect(run.acks).toHaveLength(count);

    expectAckedSurvive(run.acks, dbPath);
    expect(readFileSync(dbPath, "utf8").endsWith("\n")).toBe(true);
  }, 20_000);

  it("drops a torn tail on read, then truncates it before appending", async () => {
    const dbPath = newDbPath();
    const count = 200;

    const run = await runChild(dbPath, durability, count, "torn");
    expect(run.signal, run.stderr).toBe("SIGKILL");
    expect(run.acks).toHaveLength(count);

    const torn = readFileSync(dbPath, "utf8");
    expect(torn.endsWith("\n")).toBe(false);
    expect(torn.endsWith('{"op":"put","id":"torn"')).toBe(true);

    // Reopening tolerates the torn tail rather than throwing.
    const first = open(dbPath);
    try {
      expect(first.get("torn")).toBeUndefined();
    } finally {
      first.close();
    }
    expectAckedSurvive(run.acks, dbPath);

    // The first write after reopening repairs the tail, then appends cleanly.
    const db = open(dbPath);
    try {
      db.put({ id: "clean", n: 1 });
    } finally {
      db.close();
    }

    const repaired = readFileSync(dbPath, "utf8");
    expect(repaired.endsWith("\n")).toBe(true);
    expect(repaired.includes("torn")).toBe(false);
    const lines = repaired.split("\n").filter((line) => line !== "");
    // header + every acked put + the clean put
    expect(lines).toHaveLength(count + 2);

    const reread = open(dbPath);
    try {
      expect(reread.get("clean")).toBeDefined();
      for (const id of run.acks) {
        expect(reread.get(id), `acked id ${id} was lost`).toBeDefined();
      }
    } finally {
      reread.close();
    }
  }, 20_000);
});
