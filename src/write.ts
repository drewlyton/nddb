import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import type { Action } from "./action.js";
import { FORMAT_VERSION, serialiseAction } from "./log.js";

export type Durability = "buffered" | "strict";

export type LogWriter = {
  readonly path: string;
  append(action: Action): void;
  flush(): void;
  close(): void;
};

const NEWLINE = 0x0a;
const HEADER = `{"nddb":${FORMAT_VERSION}}\n`;

/** Last byte of the file, read through a fresh fd because the log fd is write-only. */
const lastByte = (path: string, size: number): number => {
  const readFd = openSync(path, "r");
  try {
    const byte = Buffer.allocUnsafe(1);
    return readSync(readFd, byte, 0, 1, size - 1) === 0 ? -1 : byte.readUInt8(0);
  } finally {
    closeSync(readFd);
  }
};

/**
 * Flush the parent directory so the file's *name* is durable.
 *
 * Only the directory entry is at stake, and some platforms refuse directory
 * fsync (EINVAL/EISDIR), so every failure here is swallowed (#8).
 */
const fsyncParent = (path: string): void => {
  let dirFd: number | undefined;
  try {
    dirFd = openSync(dirname(path), "r");
    fsyncSync(dirFd);
  } catch {
    // Best effort by design (#8); the caller's data is not at risk.
  } finally {
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch {
        // Closing a directory fd we opened cannot fail usefully.
      }
    }
  }
};

/**
 * One-time prep on the first append: repair a torn tail, then emit the header
 * if nddb is the one creating the file.
 */
const prepareFirstWrite = (
  fd: number,
  path: string,
  existed: boolean,
  expectedSize: number,
): void => {
  const size = fstatSync(fd).size;

  if (size > 0 && lastByte(path, size) !== NEWLINE) {
    // A torn tail would fuse our record onto it into one malformed line, which
    // a reader stopping at the first malformed line would silently drop (#9).
    // The guard runs first so bytes someone else appended are never truncated.
    if (size !== expectedSize) {
      throw new Error(`${path} changed since it was read; refusing to repair a torn tail`);
    }
    const bytes = readFileSync(path);
    ftruncateSync(fd, bytes.lastIndexOf(NEWLINE) + 1);
  }

  // A header is never retrofitted: an existing empty file stays headerless (#9).
  if (!existed && size === 0) {
    writeSync(fd, HEADER);
    fsyncParent(path);
  }
};

export const createWriter = (
  path: string,
  options?: { readonly durability?: Durability },
): LogWriter => {
  const durability = options?.durability ?? "buffered";
  const existed = existsSync(path);
  const expectedSize = existed ? statSync(path).size : 0;

  let fd: number | undefined;
  let closed = false;

  const append = (action: Action): void => {
    if (closed) {
      throw new Error("log writer is closed");
    }
    if (fd === undefined) {
      const opened = openSync(path, "a");
      try {
        prepareFirstWrite(opened, path, existed, expectedSize);
      } catch (error) {
        closeSync(opened);
        throw error;
      }
      fd = opened;
    }
    // One write(2) with no position: O_APPEND makes offset and write one
    // atomic step, while pwrite ignores the offset on Linux — a portability
    // trap (#20).
    const line = serialiseAction(action);
    const written = writeSync(fd, line);
    if (written !== Buffer.byteLength(line)) {
      // A short write tears the record silently; record size is documented
      // rather than enforced (#8), but a partial line is never a success.
      throw new Error(`short write: wrote ${written} of ${Buffer.byteLength(line)} bytes`);
    }
    if (durability === "strict") {
      // A failed fsync means the write is not durable: never swallow it (#8).
      fsyncSync(fd);
    }
  };

  const flush = (): void => {
    if (closed) {
      throw new Error("log writer is closed");
    }
    // Strict already fsynced every append, so flush is a no-op there (#8).
    if (fd !== undefined && durability === "buffered") {
      fsyncSync(fd);
    }
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    try {
      flush();
    } finally {
      // Release the fd even when the flush fails; the error still surfaces.
      if (fd !== undefined) {
        closeSync(fd);
        fd = undefined;
      }
      closed = true;
    }
  };

  return { path, append, flush, close };
};
