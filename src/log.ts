// Structured JSON logs (docs/plans/2026-10-12-hosted-control-plane.md §2.7). One JSON object per line, with field
// names from the OpenTelemetry log data model and `slopswarm.*` attributes, so an exporter can be added later
// without renaming. Every line carries world, run, agent and wake id when it has them. A human line goes to the
// console as before.
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface LogContext {
  world?: string | null;
  run?: string | null;
  agent?: string | null;
  wake_id?: number | string | null;
}

export type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogLine {
  timestamp: string;
  severity_text: Severity;
  body: string;
  "service.name": string;
  "slopswarm.world"?: string;
  "slopswarm.run"?: string;
  "slopswarm.agent"?: string;
  "slopswarm.wake_id"?: number | string;
  [attr: string]: unknown;
}

export interface Logger {
  log(severity: Severity, body: string, ctx?: LogContext & Record<string, unknown>): void;
  info(body: string, ctx?: LogContext & Record<string, unknown>): void;
  warn(body: string, ctx?: LogContext & Record<string, unknown>): void;
  error(body: string, ctx?: LogContext & Record<string, unknown>): void;
  /** The same logger with fixed context. */
  with(ctx: LogContext): Logger;
}

export function logLine(service: string, severity: Severity, body: string, ctx: LogContext & Record<string, unknown> = {}, now = Date.now()): LogLine {
  const { world, run, agent, wake_id, ...attrs } = ctx;
  const line: LogLine = { timestamp: new Date(now).toISOString(), severity_text: severity, body, "service.name": service };
  if (world) line["slopswarm.world"] = world;
  if (run) line["slopswarm.run"] = run;
  if (agent) line["slopswarm.agent"] = agent;
  if (wake_id !== undefined && wake_id !== null) line["slopswarm.wake_id"] = wake_id;
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) line[k.includes(".") ? k : `slopswarm.${k}`] = v;
  return line;
}

/**
 * `file`: append JSON lines there (created on first write). `console`: a human line per entry (default: to
 * stdout, with the time). Pass `console: false` for a file-only logger.
 */
export function createLogger(service: string, o: { file?: string; console?: ((line: string) => void) | false; now?: () => number } = {}, base: LogContext = {}): Logger {
  const now = o.now ?? Date.now;
  const human = o.console === false ? null : (o.console ?? ((l: string) => console.log(l)));
  let dirMade = false;
  const log = (severity: Severity, body: string, ctx: LogContext & Record<string, unknown> = {}) => {
    const t = now();
    const line = logLine(service, severity, body, { ...base, ...ctx }, t);
    if (o.file) {
      try {
        if (!dirMade) mkdirSync(dirname(o.file), { recursive: true });
        dirMade = true;
        appendFileSync(o.file, JSON.stringify(line) + "\n");
      } catch {
        /* logging never fails the caller */
      }
    }
    if (human) human(`[${new Date(t).toISOString().slice(11, 19)}]${severity === "INFO" ? "" : ` ${severity}`} ${body}`);
  };
  const logger: Logger = {
    log,
    info: (b, c) => log("INFO", b, c),
    warn: (b, c) => log("WARN", b, c),
    error: (b, c) => log("ERROR", b, c),
    with: (ctx) => createLogger(service, o, { ...base, ...ctx }),
  };
  return logger;
}

/** Lines of a JSON log file at or after `since` (unix ms), at most `limit` (the newest). Malformed lines are skipped. */
export function readLogFile(file: string, since = 0, limit = 1000): LogLine[] {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return [];
  const out: LogLine[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.startsWith("{")) continue;
    try {
      const d = JSON.parse(l) as LogLine;
      if (Date.parse(d.timestamp) >= since) out.push(d);
    } catch {
      /* torn line */
    }
  }
  return out.slice(-limit);
}

/** One log line for a terminal: time, service, severity, context, body. */
export function formatLogLine(l: LogLine): string {
  const ctx = [l["slopswarm.world"], l["slopswarm.agent"], l["slopswarm.wake_id"] !== undefined ? `#${l["slopswarm.wake_id"]}` : undefined].filter(Boolean).join(" ");
  return `${l.timestamp.slice(0, 19).replace("T", " ")} ${String(l["service.name"]).padEnd(10)} ${l.severity_text.padEnd(5)} ${ctx ? `[${ctx}] ` : ""}${l.body}`;
}

/** Several JSON log files merged by time, duplicates dropped (a remote runner's log may also be pumped locally). */
export function readLogs(files: string[], since = 0, limit = 5000): LogLine[] {
  const seen = new Set<string>();
  return files
    .flatMap((f) => readLogFile(f, since, limit))
    .filter((l) => {
      const k = JSON.stringify(l);
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-limit);
}
