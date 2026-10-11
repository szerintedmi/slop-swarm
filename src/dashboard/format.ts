// Shared formatting. mdLite is the only HTML-producing helper; it escapes all source text.
/** Escape text for HTML element and attribute contexts. Everything agent-written goes through this. */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function usd(v: number | null | undefined, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${v.toFixed(digits)}`;
}

export function int(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString("en-US");
}

export function bytes(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** 95_000 -> "1m 35s"; 7_200_000 -> "2h 0m". */
export function dur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Relative to now: "in 5m 0s" / "3m 2s ago". */
export function rel(ts: number | null | undefined, now = Date.now()): string {
  if (ts == null) return "—";
  const d = ts - now;
  return d >= 0 ? `in ${dur(d)}` : `${dur(-d)} ago`;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DD HH:MM:SS". */
export function clock(ts: number | null | undefined): string {
  if (ts == null) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** Local "HH:MM:SS". */
export function hms(ts: number): string {
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s;
}

/** First line, shortened: for one-line previews. */
export function preview(s: string, n = 140): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

const HUES = [158, 28, 262, 205, 340, 95, 48, 290, 185, 0];

/** Stable per-agent hue (by name), so an agent has the same colour everywhere. */
export function agentHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length]!;
}

/**
 * Light, safe markdown: everything is escaped first; only headings, bold, inline code, fenced code
 * and list bullets are turned into tags (no links, no raw HTML, no attributes).
 */
export function mdLite(src: string): string {
  const out: string[] = [];
  let inCode = false;
  let list = false;
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const closeList = () => {
    if (list) out.push("</ul>");
    list = false;
  };
  for (const line of src.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) {
      closeList();
      out.push(inCode ? "</pre>" : `<pre class="code">`);
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(line) + "\n");
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      out.push(`<div class="md-h md-h${h[1]!.length}">${inline(h[2]!)}</div>`);
    } else if (li) {
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${inline(li[1]!)}</li>`);
    } else if (!line.trim()) {
      closeList();
      out.push(`<div class="md-gap"></div>`);
    } else {
      closeList();
      out.push(`<div>${inline(line)}</div>`);
    }
  }
  closeList();
  if (inCode) out.push("</pre>");
  return `<div class="md">${out.join("")}</div>`;
}

export const triggerText = (t: string) => ({ initial: "first wake", self: "chosen time", timer: "max sleep", message: "forge notifications", manual: "operator" }[t] ?? t);
export const isMarkdown = (p: string) => /\.(md|markdown|txt)$/i.test(p);
