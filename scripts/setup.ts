// One-time setup, from a fresh clone or again at any time:
//
//   bun run setup             (add --dry-run to print what it would do and change nothing)
//
// 1. installs the locked dependencies and builds dist/chrome and dist/firefox
// 2. registers the bridge with Claude Code (user scope), with absolute paths and
//    this Bun's own path, so it works even where `bun` is not on Claude Code's PATH
// 3. offers the /browse command (copies skill/browse; never overwrites one you have)
// 4. offers semantic targeting (Jev): asks for the TypeSafe API key with hidden
//    input and writes it to ~/.config/typesafe/env, readable by you only. It
//    never prints the key, and keeps an existing one unless you say otherwise.
// 5. starts the bridge, so the extension finds it straight away
//
// Each step prints what it did. Without a terminal to answer in (stdin is not a
// TTY), it skips the questions and leaves the /browse command and Jev as they are.
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig, updateConfig } from "../bridge/security";
import { TYPESAFE_ENV_FILE, loadApiKey, saveApiKey } from "../bridge/jev";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BUN = process.execPath;
const DRY = process.argv.includes("--dry-run");
const ASK = process.stdin.isTTY === true && !DRY;
const PORT = Number(process.env.BRIDGE_PORT ?? 8787);
const MCP = join(ROOT, "bridge", "mcp.ts");

const say = (s: string) => console.log(s);
const step = (s: string) => console.log(`\n${s}`);
const done = (s: string) => console.log(`  ✓ ${DRY ? "(dry run) " : ""}${s}`);
const note = (s: string) => console.log(`  - ${s}`);

/** Run a program and return its exit code and output. Inherits the terminal when `show` is set. */
function run(cmd: string[], show = false): { code: number; out: string } {
  if (DRY) { note(`would run: ${cmd.map(quote).join(" ")}`); return { code: 0, out: "" }; }
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: show ? "inherit" : "pipe", stderr: show ? "inherit" : "pipe" });
  return { code: p.exitCode ?? 1, out: `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}` };
}
const quote = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** Read one line. Hidden input (for the API key) turns echo off; it needs a terminal. */
function readLine(hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const raw = hidden && stdin.isTTY === true;
    if (raw) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let buf = "";
    const finish = () => {
      stdin.off("data", onData);
      if (raw) { stdin.setRawMode(false); process.stdout.write("\n"); }
      stdin.pause();
      resolve(buf.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") { if (raw) stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (ch === "\n" || (raw && ch === "\r")) return finish();
        if (ch === "\r") continue;
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}
async function yes(question: string, dflt: boolean): Promise<boolean> {
  process.stdout.write(`  ${question} ${dflt ? "[Y/n]" : "[y/N]"} `);
  const a = (await readLine()).toLowerCase();
  return a ? a.startsWith("y") : dflt;
}

say(`Browsteer setup${DRY ? " (dry run: nothing is changed)" : ""}`);
say(`  folder: ${ROOT}`);
say(`  bun:    ${BUN} (v${Bun.version})`);
const [major, minor] = Bun.version.split(".").map(Number);
if (major < 1 || (major === 1 && minor < 3)) { console.error("\nBrowsteer needs Bun 1.3 or newer: https://bun.sh"); process.exit(1); }

// ── 1. Install and build ───────────────────────────────────────────────────────
step("1. Install and build");
if (run([BUN, "install", "--frozen-lockfile"], true).code !== 0) { console.error("bun install failed (see above)."); process.exit(1); }
done("dependencies installed");
if (run([BUN, "run", "scripts/build.ts"], true).code !== 0) { console.error("The build failed (see above)."); process.exit(1); }
done(`extension built: ${join(ROOT, "dist", "chrome")} and ${join(ROOT, "dist", "firefox")}`);

// ── 2. Register with Claude Code ───────────────────────────────────────────────
step("2. Add Browsteer to Claude Code");
const addArgs = ["mcp", "add", "-s", "user", "browsteer", "--", BUN, "run", MCP];
const claude = Bun.which("claude");
if (!claude) {
  note("Claude Code (`claude`) is not on PATH. Install it, then run this once:");
  say(`    claude ${addArgs.map(quote).join(" ")}`);
} else {
  // `claude` can be a .cmd shim on Windows, which only cmd.exe can start.
  const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(claude);
  const cl = (args: string[], show = false) => run(viaShell ? ["cmd.exe", "/d", "/c", claude, ...args] : [claude, ...args], show);
  const got = DRY ? { code: 1, out: "" } : cl(["mcp", "get", "browsteer"]);
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  if (got.code === 0 && norm(got.out).includes(norm(MCP)) && norm(got.out).includes(norm(BUN))) {
    done("already registered with these paths");
  } else {
    if (got.code === 0) { note("replacing the earlier registration, which pointed elsewhere"); cl(["mcp", "remove", "-s", "user", "browsteer"]); }
    if (cl(addArgs, true).code !== 0) { console.error("`claude mcp add` failed (see above). Run it yourself:"); say(`    claude ${addArgs.map(quote).join(" ")}`); }
    else done(`registered: ${quote(BUN)} run ${quote(MCP)}`);
  }
}

// ── 3. The /browse command ─────────────────────────────────────────────────────
step("3. The /browse command for Claude Code");
const skillSrc = join(ROOT, "skill", "browse");
const skillDst = join(homedir(), ".claude", "skills", "browse");
const sameTree = (a: string, b: string): boolean => readdirSync(a, { withFileTypes: true }).every((e) =>
  existsSync(join(b, e.name)) && (e.isDirectory() ? sameTree(join(a, e.name), join(b, e.name)) : readFileSync(join(a, e.name)).equals(readFileSync(join(b, e.name)))));
if (existsSync(skillDst)) {
  if (sameTree(skillSrc, skillDst)) done(`installed and up to date: ${skillDst}`);
  else note(`${skillDst} exists and differs from skill/browse. Left alone; copy it yourself to update.`);
} else if (!ASK) {
  note(`not installed. To add it: copy ${skillSrc} to ${skillDst}`);
} else if (await yes(`Copy it to ${skillDst}?`, true)) {
  mkdirSync(dirname(skillDst), { recursive: true });
  cpSync(skillSrc, skillDst, { recursive: true });
  done(`installed: ${skillDst}`);
} else note("skipped");

// ── 4. Semantic targeting (Jev) ────────────────────────────────────────────────
step("4. Semantic targeting (optional, off by default)");
say("  browser_find and browser_pursue can find controls by description by asking Jev, a");
say("  model run by TypeSafe. When on, page outlines (address, title, control names and");
say("  visible text) go to api.typesafe.ai. You can turn it off any time in the popup.");
const envOverride = process.env.BROWSTEER_JEV != null;
const on = loadConfig().jev;
const hasKey = () => loadApiKey() !== null;
const keyWhere = process.env.TYPESAFE_API_KEY ? "in the TYPESAFE_API_KEY environment variable" : TYPESAFE_ENV_FILE;

if (envOverride) note(`BROWSTEER_JEV is set in this environment, which overrides the saved setting.`);
if (!ASK) {
  note(`left as it is: ${on ? "on" : "off"}, API key ${hasKey() ? "found" : "not found"}`);
} else if (await yes(on ? "It is on. Keep it on?" : "Turn it on?", on)) {
  if (hasKey() && await yes(`An API key is already set (${keyWhere}). Keep it?`, true)) {
    done("kept the existing API key");
  } else {
    process.stdout.write("  TypeSafe API key (typing is hidden; leave empty to skip): ");
    const key = await readLine(true);
    if (/\s/.test(key)) note("that has spaces in it, so it was not saved");
    else if (key) {
      saveApiKey(key);
      done(`API key saved to ${TYPESAFE_ENV_FILE} (readable by you only)`);
      if (process.env.TYPESAFE_API_KEY) note("TYPESAFE_API_KEY is also set in the environment; where both exist, the bridge uses that one.");
    }
    else note(`no key saved. Add a line TYPESAFE_API_KEY=... to ${TYPESAFE_ENV_FILE} later.`);
  }
  if (!on) updateConfig({ jev: true });
  done(`semantic targeting is on${hasKey() ? "" : ", but it needs an API key before it works"}`);
} else {
  if (on) updateConfig({ jev: false });
  done("semantic targeting is off; no page content leaves this computer");
}

// ── 5. Start the bridge ────────────────────────────────────────────────────────
step("5. Start the bridge");
const answering = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}`)).ok; } catch { return false; } };
if (await answering()) done(`already running on 127.0.0.1:${PORT}`);
else if (DRY) note(`would start: ${quote(BUN)} run ${quote(join(ROOT, "bridge", "hub.ts"))}`);
else {
  // Detached, like the per-session shim does, so it outlives this script.
  try { nodeSpawn(BUN, ["run", join(ROOT, "bridge", "hub.ts")], { detached: true, stdio: "ignore", cwd: ROOT }).unref(); } catch {}
  let up = false;
  for (let i = 0; i < 30 && !up; i++) { await Bun.sleep(200); up = await answering(); }
  if (up) done(`running on 127.0.0.1:${PORT}`);
  else note("did not answer yet. It also starts the first time Claude Code uses Browsteer.");
}

say(`
Next:
  - Install the extension if you have not: Firefox from addons.mozilla.org (search "Browsteer"),
    or Chrome/Edge: chrome://extensions, Developer mode, Load unpacked, choose
    ${join(ROOT, "dist", "chrome")}
  - Its setup page turns green when it finds the bridge. Then open a page, click the
    Browsteer button, allow Claude for 1 hour and allow the site.
  - Start a new Claude Code session and paste the /browse command from the popup.`);
