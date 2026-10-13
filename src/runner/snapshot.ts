// Home snapshots between the runner and the controller (docs/plans/2026-10-12-hosted-control-plane.md §2.6): a
// framed stream both ends own, instead of tar, so extraction rules are ours and the same on macOS and Linux.
//
//   frame := u32be headerLength, header JSON, then `size` content bytes for a file
//   end   := u32be 0
//   header: { p: path, t: "f" | "d" | "l", m: mode, s: size, mt: mtimeMs, l?: link target }
//
// Writers never follow symlinks (a link is stored as a link). Readers write only under the allowed roots, never
// through a symlink, never outside the target dir.
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, symlinkSync, utimesSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeRelPath } from "./protocol.ts";

interface Header {
  p: string;
  t: "f" | "d" | "l";
  m: number;
  s: number;
  mt: number;
  l?: string;
}

export interface SnapshotSource {
  /** Archive path prefix, e.g. "home" or "runtime/sessions". */
  prefix: string;
  /** Host dir; skipped when missing. */
  dir: string;
}

const CHUNK = 256 * 1024;
const enc = new TextEncoder();

function frame(h: Header): Uint8Array {
  const json = enc.encode(JSON.stringify(h));
  const out = new Uint8Array(4 + json.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  return out;
}

/** Walk `sources` (lstat, no symlink following), skipping names in `exclude` at any depth. */
export function* walkSnapshot(sources: SnapshotSource[], exclude: ReadonlySet<string>, skipped?: string[]): Generator<{ h: Header; abs: string }> {
  const walk = function* (abs: string, rel: string): Generator<{ h: Header; abs: string }> {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (exclude.has(name)) continue;
      // A name the reader refuses (a backslash, say) would fail the whole snapshot: leave that entry out.
      if (!safeRelPath(name)) {
        skipped?.push(`${rel}/${name}`);
        continue;
      }
      const a = join(abs, name);
      const r = `${rel}/${name}`;
      const st = lstatSync(a, { throwIfNoEntry: false });
      if (!st) continue;
      const base = { p: r, m: st.mode & 0o777, mt: Math.round(st.mtimeMs) };
      if (st.isSymbolicLink()) yield { h: { ...base, t: "l", s: 0, l: readlinkSync(a) }, abs: a };
      else if (st.isDirectory()) {
        yield { h: { ...base, t: "d", s: 0 }, abs: a };
        yield* walk(a, r);
      } else if (st.isFile()) yield { h: { ...base, t: "f", s: st.size }, abs: a };
    }
  };
  for (const s of sources) {
    const st = lstatSync(s.dir, { throwIfNoEntry: false });
    if (!st?.isDirectory()) continue;
    yield { h: { p: s.prefix, t: "d", m: st.mode & 0o777, s: 0, mt: Math.round(st.mtimeMs) }, abs: s.dir };
    yield* walk(s.dir, s.prefix);
  }
}

/** Bytes a snapshot of `sources` carries (file contents only). */
export function snapshotBytes(sources: SnapshotSource[], exclude: ReadonlySet<string>, skipped?: string[]): number {
  let n = 0;
  for (const { h } of walkSnapshot(sources, exclude, skipped)) if (h.t === "f") n += h.s;
  return n;
}

/** A snapshot of `sources` as a stream. A file that shrank while being read is padded, one that grew is cut, so frames stay valid. */
export function snapshotStream(sources: SnapshotSource[], exclude: ReadonlySet<string>): ReadableStream<Uint8Array> {
  const it = walkSnapshot(sources, exclude);
  let current: { fd: number; left: number } | null = null;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (current) {
        const n = Math.min(CHUNK, current.left);
        const buf = new Uint8Array(n);
        let got = 0;
        try {
          got = readSync(current.fd, buf, 0, n, null);
        } catch {
          got = 0;
        }
        // Short read (file shrank): pad with zeros to the size the header promised.
        current.left -= n;
        c.enqueue(got === n ? buf : buf.fill(0, got));
        if (current.left === 0) {
          closeSync(current.fd);
          current = null;
        }
        return;
      }
      const next = it.next();
      if (next.done) {
        c.enqueue(new Uint8Array(4));
        c.close();
        return;
      }
      const { h, abs } = next.value;
      if (h.t === "f" && h.s > 0) {
        try {
          current = { fd: openSync(abs, "r"), left: h.s };
        } catch {
          // Vanished since the walk: send it empty.
          h.s = 0;
        }
      }
      c.enqueue(frame(h));
    },
    cancel() {
      if (current) closeSync(current.fd);
    },
  });
}

/** Reads exactly what is asked from a byte stream. */
class Reader {
  private buf = new Uint8Array(0);
  private done = false;
  constructor(private readonly r: { read(): Promise<{ done: boolean; value?: Uint8Array }> }) {}
  async need(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.r.read();
      if (done) this.done = true;
      else if (value?.length) {
        const b = new Uint8Array(this.buf.length + value.length);
        b.set(this.buf);
        b.set(value, this.buf.length);
        this.buf = b;
      }
    }
    return this.buf.length >= n;
  }
  take(n: number): Uint8Array {
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
  /** Up to `max` bytes already buffered or next from the stream. */
  async some(max: number): Promise<Uint8Array> {
    if (!this.buf.length) await this.need(1);
    return this.take(Math.min(max, this.buf.length));
  }
}

export class SnapshotError extends Error {}

/**
 * Write a snapshot stream under `target` (which must exist and be empty or fresh). Only paths whose first segment
 * is in `roots` (or equal to a root) are accepted. Returns the number of file bytes written.
 */
export async function extractSnapshot(stream: ReadableStream<Uint8Array>, target: string, roots: readonly string[]): Promise<number> {
  const r = new Reader(stream.getReader());
  const rootOk = (p: string) => roots.some((root) => p === root || p.startsWith(`${root}/`));
  /** No path component under target may be a symlink (a link frame earlier in the stream). */
  const noLinkOnTheWay = (rel: string) => {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const st = lstatSync(join(target, ...parts.slice(0, i)), { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) throw new SnapshotError(`snapshot: ${rel} goes through a symlink`);
      if (st && !st.isDirectory()) throw new SnapshotError(`snapshot: ${rel} goes through a file`);
    }
  };
  let bytes = 0;
  const dirTimes: { abs: string; mt: number }[] = [];
  for (;;) {
    if (!(await r.need(4))) throw new SnapshotError("snapshot: truncated (no end marker)");
    const len = new DataView(r.take(4).buffer).getUint32(0);
    if (len === 0) break;
    if (len > 1 << 20) throw new SnapshotError("snapshot: header too large");
    if (!(await r.need(len))) throw new SnapshotError("snapshot: truncated header");
    const h = JSON.parse(new TextDecoder().decode(r.take(len))) as Header;
    if (typeof h.p !== "string" || !safeRelPath(h.p) || !rootOk(h.p)) throw new SnapshotError(`snapshot: refused path ${JSON.stringify(h.p)}`);
    if (!["f", "d", "l"].includes(h.t) || !Number.isInteger(h.s) || h.s < 0) throw new SnapshotError(`snapshot: bad header for ${h.p}`);
    noLinkOnTheWay(h.p);
    const abs = join(target, h.p);
    const mode = (Number.isInteger(h.m) ? h.m : 0o644) & 0o777;
    if (lstatSync(abs, { throwIfNoEntry: false }) && h.t !== "d") throw new SnapshotError(`snapshot: duplicate entry ${h.p}`);
    if (h.t === "d") {
      mkdirSync(abs, { recursive: true });
      chmodSync(abs, mode | 0o700);
      dirTimes.push({ abs, mt: h.mt });
    } else if (h.t === "l") {
      mkdirSync(dirname(abs), { recursive: true });
      symlinkSync(String(h.l ?? ""), abs);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      const fd = openSync(abs, "w", mode | 0o600);
      try {
        let left = h.s;
        while (left > 0) {
          const chunk = await r.some(Math.min(left, CHUNK));
          if (!chunk.length) throw new SnapshotError(`snapshot: truncated file ${h.p}`);
          writeSync(fd, chunk);
          left -= chunk.length;
        }
      } finally {
        closeSync(fd);
      }
      chmodSync(abs, mode);
      if (Number.isFinite(h.mt)) utimesSync(abs, new Date(h.mt), new Date(h.mt));
      bytes += h.s;
    }
  }
  // Directory times last: writing their contents moved them.
  for (const d of dirTimes.reverse()) if (Number.isFinite(d.mt)) utimesSync(d.abs, new Date(d.mt), new Date(d.mt));
  return bytes;
}
