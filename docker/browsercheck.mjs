#!/usr/bin/env node
// browsercheck: open a local page in headless Chromium the way a person would open it (file://), run a few steps,
// and report what happened: uncaught errors, console output, failed requests, screenshots. For agents testing the
// browser software they build. Local files only: no network beyond what the page itself requests (which goes
// through the container's normal egress, so most outside requests fail and are reported).
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

// The world's limit (the swarm config's browsercheck.timeout_s): the default, and the most --timeout may ask for.
const LIMIT_S = Number(process.env.BROWSERCHECK_TIMEOUT_S) > 0 ? Number(process.env.BROWSERCHECK_TIMEOUT_S) : 120;

const USAGE = `usage: browsercheck PATH [steps…]
  PATH              an .html file, or a directory with an index.html; opened as file://
steps, run in order after the page loads (default: --wait 2000 --shot /tmp/browsercheck.png):
  --wait MS         let the page run
  --click X,Y       click at viewport pixel X,Y
  --move X,Y        move the pointer to X,Y
  --drag X,Y,X2,Y2  press at X,Y, move to X2,Y2, release
  --key KEY         press a key (Space, Enter, ArrowLeft, a, …)
  --type TEXT       type text into the focused element
  --eval JS         evaluate JS in the page and print the result as JSON
  --shot FILE       save a screenshot (PNG); view it with your image/file reading tool
options:
  --size WxH        viewport (default 1280x800)
  --timeout S       give up sooner than this world's limit of ${LIMIT_S}s (the limit can't be raised)
The whole run (start, load, every step) stops at the limit. There is no GPU and one CPU: WebGL runs in software, so
heavy shaders are slow here even when they are fine on a real machine.
exit: 0 no errors · 1 the page reported errors · 2 usage · 3 time limit reached · 4 the browser failed`;

function die(msg) {
  console.error(msg);
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length || args[0] === "-h" || args[0] === "--help") die(USAGE);
let target = null;
let size = [1280, 800];
let timeoutS = LIMIT_S;
const steps = [];
const pair = (v, n, flag) => {
  const xs = String(v ?? "").split(",").map(Number);
  if (xs.length !== n || xs.some((x) => !Number.isFinite(x))) die(`${flag}: expected ${n} comma-separated numbers`);
  return xs;
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => (i + 1 < args.length ? args[++i] : die(`${a}: missing value`));
  if (a === "--size") {
    const m = /^(\d+)x(\d+)$/.exec(val());
    if (!m) die("--size: expected WxH");
    size = [Number(m[1]), Number(m[2])];
  } else if (a === "--timeout") {
    timeoutS = Number(val());
    if (!(timeoutS > 0)) die("--timeout: expected seconds");
    if (timeoutS > LIMIT_S) die(`--timeout: at most ${LIMIT_S}s in this world (the operator's limit)`);
  }
  else if (a === "--wait") steps.push(["wait", Number(val())]);
  else if (a === "--click") steps.push(["click", pair(val(), 2, a)]);
  else if (a === "--move") steps.push(["move", pair(val(), 2, a)]);
  else if (a === "--drag") steps.push(["drag", pair(val(), 4, a)]);
  else if (a === "--key") steps.push(["key", val()]);
  else if (a === "--type") steps.push(["type", val()]);
  else if (a === "--eval") steps.push(["eval", val()]);
  else if (a === "--shot") steps.push(["shot", val()]);
  else if (a.startsWith("--")) die(`unknown option ${a}\n\n${USAGE}`);
  else if (target === null) target = a;
  else die(`unexpected argument ${a}`);
}
if (target === null) die(USAGE);
let file = resolve(target);
if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
if (!existsSync(file)) die(`not found: ${file}`);
if (!steps.length) steps.push(["wait", 2000], ["shot", "/tmp/browsercheck.png"]);

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (kind, text) => console.log(`[${stamp()}] ${kind} ${text}`);
let errors = 0;
/** What is running now, for the timeout and failure messages. */
let doing = "starting Chromium";
let browser = null;
const watchdog = setTimeout(() => {
  log(
    "TIMEOUT",
    `stopped at the ${timeoutS}s limit while ${doing}. Everything above happened before that. Likely causes: the page ` +
      `blocks its main thread (a long loop or a busy requestAnimationFrame), or it is too heavy for software WebGL on one ` +
      `CPU; fewer or shorter steps, a smaller --size, or lighter rendering help.`,
  );
  try {
    browser?.process()?.kill("SIGKILL");
  } catch {}
  process.exit(3);
}, timeoutS * 1000);

/** A failure of the browser or a step (not of the page): say which step, and exit 4. */
function failed(e) {
  clearTimeout(watchdog);
  log("FAILED", `${doing}: ${(e?.message || String(e)).split("\n")[0]}`);
  try {
    browser?.process()?.kill("SIGKILL");
  } catch {}
  process.exit(4);
}
process.on("unhandledRejection", failed);

log("start", `${file} (limit ${timeoutS}s)`);
try {
  browser = await puppeteer.launch({
    executablePath: process.env.BROWSERCHECK_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    userDataDir: join(process.env.TMPDIR || "/tmp", `browsercheck-profile-${process.pid}`),
    args: [
      // The container is the sandbox (no user namespaces, all capabilities dropped): Chromium's own can't start.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // WebGL on the CPU (no GPU in the container).
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--autoplay-policy=no-user-gesture-required",
      "--allow-file-access-from-files",
      "--no-first-run",
      "--no-default-browser-check",
      `--crash-dumps-dir=${process.env.TMPDIR || "/tmp"}`,
    ],
  });
} catch (e) {
  failed(e);
}
try {
  const page = await browser.newPage();
  await page.setViewport({ width: size[0], height: size[1] });
  page.on("console", (m) => {
    if (m.type() === "error") errors++;
    log(`console.${m.type()}`, m.text());
  });
  page.on("pageerror", (e) => {
    errors++;
    log("PAGE ERROR", e?.stack || e?.message || String(e));
  });
  page.on("requestfailed", (r) => {
    errors++;
    log("REQUEST FAILED", `${r.url()} (${r.failure()?.errorText ?? "?"})`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) {
      errors++;
      log("HTTP", `${r.status()} ${r.url()}`);
    }
  });
  const url = pathToFileURL(file).href;
  doing = `loading ${url}`;
  log("open", url);
  // The watchdog has the time limit; puppeteer's own navigation timeout would fire first with a vaguer message.
  await page.goto(url, { waitUntil: "load", timeout: 0 });
  const info = await page.evaluate(() => {
    const gl = (() => {
      try {
        const c = document.createElement("canvas");
        return c.getContext("webgl2") ? "webgl2" : c.getContext("webgl") ? "webgl" : "none";
      } catch {
        return "none";
      }
    })();
    return {
      title: document.title,
      canvases: [...document.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height}`),
      text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      gl,
    };
  });
  log("loaded", `title=${JSON.stringify(info.title)} canvases=[${info.canvases.join(", ")}] webgl=${info.gl}`);
  if (info.text) log("text", JSON.stringify(info.text));
  for (const [kind, v] of steps) {
    doing = `step --${kind} ${Array.isArray(v) ? v.join(",") : v}`;
    if (kind === "wait") await new Promise((r) => setTimeout(r, v));
    else if (kind === "click") await page.mouse.click(v[0], v[1]);
    else if (kind === "move") await page.mouse.move(v[0], v[1], { steps: 10 });
    else if (kind === "drag") {
      await page.mouse.move(v[0], v[1]);
      await page.mouse.down();
      await page.mouse.move(v[2], v[3], { steps: 20 });
      await page.mouse.up();
    } else if (kind === "key") await page.keyboard.press(v);
    else if (kind === "type") await page.keyboard.type(v);
    else if (kind === "eval") {
      try {
        const r = await page.evaluate((js) => {
          // eslint-disable-next-line no-eval
          const out = (0, eval)(js);
          return Promise.resolve(out).then((x) => JSON.stringify(x) ?? "undefined");
        }, v);
        log("eval", r);
      } catch (e) {
        errors++;
        log("EVAL ERROR", e?.message || String(e));
      }
      continue;
    } else if (kind === "shot") {
      const out = resolve(v);
      mkdirSync(dirname(out), { recursive: true });
      await page.screenshot({ path: out });
      log("screenshot", out);
      continue;
    }
    log(kind, Array.isArray(v) ? v.join(",") : String(v));
  }
  doing = "closing Chromium";
  log("done", `${errors} error(s)`);
  process.exitCode = errors ? 1 : 0;
} catch (e) {
  failed(e);
} finally {
  clearTimeout(watchdog);
  await browser.close().catch(() => {});
}
