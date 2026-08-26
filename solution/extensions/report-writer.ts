import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASELINE_STYLES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "styles",
  "baseline.css",
);

/**
 * Safety net for `report.partial.json`.
 *
 * The runner treats a missing report as a hard failure: readPartialResult()
 * falls back to FALLBACK_PARTIAL, whose status is hardcoded "failed", no matter
 * how good the generated app is. Across our baseline runs the agent produced a
 * working, fully tested app and then exhausted its step budget before writing
 * the report, scoring nothing.
 *
 * This extension closes that gap deterministically instead of asking the model
 * to comply. It NEVER invents a passing test: every entry it writes comes from
 * a real Vitest run, and a failing suite is recorded as failed.
 */

type TestResult = "passed" | "failed";
interface TestRun {
  command: string;
  journey: string;
  result: TestResult;
}

const REPORT_FILE = "report.partial.json";
const VITEST_TIMEOUT_MS = 120_000;
const DEFAULT_TEST_COMMAND = "npm test";

function isTestCommand(command: string): boolean {
  return /\bvitest\b/.test(command) || /\bnpm\s+(run\s+)?test\b/.test(command);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** A report is usable only if the runner would accept its tests_run entries. */
export function entriesAreComplete(report: Record<string, unknown>): boolean {
  const entries = report.tests_run;
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.every((entry) => {
    const record = asRecord(entry);
    return (
      typeof record?.command === "string" &&
      typeof record?.journey === "string" &&
      (record?.result === "passed" || record?.result === "failed")
    );
  });
}

async function readReport(reportPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(JSON.parse(await readFile(reportPath, "utf8")));
  } catch {
    return undefined;
  }
}

/** Run Vitest ourselves and read its machine-readable output. Ground truth. */
export async function collectVitestEvidence(
  appRoot: string,
  signal?: AbortSignal,
): Promise<{ runs: TestRun[]; ran: boolean }> {
  const outputFile = path.join(appRoot, ".report-writer-vitest.json");
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ["vitest", "run", "--reporter=json", `--outputFile=${outputFile}`];

  const finished = await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(command, args, { cwd: appRoot, stdio: "ignore", shell: false });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(false);
    }, VITEST_TIMEOUT_MS);
    signal?.addEventListener("abort", () => {
      child.kill("SIGKILL");
      done(false);
    });
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    // A non-zero exit just means tests failed; the JSON report is still written.
    child.on("close", () => {
      clearTimeout(timer);
      done(true);
    });
  });

  if (!finished) return { runs: [], ran: false };

  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = asRecord(JSON.parse(await readFile(outputFile, "utf8")));
  } catch {
    parsed = undefined;
  }
  await rm(outputFile, { force: true }).catch(() => undefined);
  if (!parsed) return { runs: [], ran: false };

  const runs: TestRun[] = [];
  const files = Array.isArray(parsed.testResults) ? parsed.testResults : [];
  for (const file of files) {
    const assertions = asRecord(file)?.assertionResults;
    if (!Array.isArray(assertions)) continue;
    for (const assertion of assertions) {
      const record = asRecord(assertion);
      const title = typeof record?.title === "string" ? record.title : undefined;
      if (!title) continue;
      // Anything not explicitly passed (failed, skipped, todo) counts as failed.
      runs.push({
        command: DEFAULT_TEST_COMMAND,
        journey: title,
        result: record?.status === "passed" ? "passed" : "failed",
      });
    }
  }
  return { runs, ran: true };
}


const ANALYSIS_FILE = "analysis.json";

/**
 * The skill asks the agent to record its ambiguity decisions in analysis.json
 * before it writes any code - early, while it is still functioning. We harvest
 * them here, at the end, when it usually is not. These are the agent's own
 * recorded decisions; nothing is invented.
 */
export async function readRecordedAssumptions(appRoot: string): Promise<string[]> {
  const analysis = await readReport(path.join(appRoot, ANALYSIS_FILE));
  const ambiguities = analysis?.ambiguities;
  if (!Array.isArray(ambiguities)) return [];
  const assumptions: string[] = [];
  for (const item of ambiguities) {
    const record = asRecord(item);
    const question = typeof record?.question === "string" ? record.question.trim() : "";
    const decision = typeof record?.decision === "string" ? record.decision.trim() : "";
    if (!question && !decision) continue;
    const rationale = typeof record?.rationale === "string" ? record.rationale.trim() : "";
    const head = question && decision ? `${question} Decided: ${decision}` : question || decision;
    assumptions.push(rationale ? `${head} (${rationale})` : head);
  }
  return assumptions;
}

export function synthesizeReport(runs: TestRun[], assumptions: string[] = []): Record<string, unknown> {
  const everyTestPassed = runs.length > 0 && runs.every((run) => run.result === "passed");
  const passing = runs.filter((run) => run.result === "passed").map((run) => run.journey);
  return {
    status: everyTestPassed ? "success" : "partial",
    app_url: "http://localhost:3000",
    start_command: "npm run dev",
    summary:
      runs.length > 0
        ? `Application verified by ${runs.length} Vitest journey test${runs.length === 1 ? "" : "s"}, ` +
          `${passing.length} passing. Report reconstructed from the recorded test run because the agent did not emit one.`
        : "The agent did not emit a report and no Vitest results could be recorded.",
    implemented_features: passing,
    assumptions,
    tests_run: runs,
  };
}


const TSC_TIMEOUT_MS = 120_000;

interface CommandOutcome {
  code: number | null;
  output: string;
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, output });
    };
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

/**
 * What the runner will check, checked here first. Returns a human-readable
 * problem report, or undefined when the workspace is clean.
 *
 * A single stray character in a test file - `/^Charge/ i` instead of
 * `/^Charge/i` - failed the production-build check AND stopped Vitest
 * collecting any tests at all, taking a working application down to `partial`.
 * The agent is told to run tests and the build before finishing. It does not.
 */
export async function findBlockingProblems(appRoot: string): Promise<string | undefined> {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const typecheck = await runCommand(npx, ["tsc", "--noEmit"], appRoot, TSC_TIMEOUT_MS);
  if (typecheck.code !== 0) {
    const detail = typecheck.output.trim().split("\n").slice(0, 12).join("\n");
    return `\`npx tsc --noEmit\` fails, so \`npm run build\` cannot pass:\n\n${detail}`;
  }

  const { runs, ran } = await collectVitestEvidence(appRoot);
  if (!ran) return "Vitest could not run to completion in this workspace.";
  if (runs.length === 0) return "Vitest collected zero tests. Every user journey must have a test that runs.";

  const failing = runs.filter((run) => run.result !== "passed");
  if (failing.length > 0) {
    return `${failing.length} test(s) are not passing:\n\n` + failing.map((r) => `- ${r.journey}`).join("\n");
  }
  return undefined;
}

function repairInstruction(problems: string): string {
  return [
    "Automated verification of the workspace failed.",
    "",
    problems,
    "",
    "Fix this now, then run `npm test` and `npm run build` to confirm both pass.",
    "Change only what is needed to make them pass. Do not start new features.",
  ].join("\n");
}


const BASELINE_MARKER = "/* agentcofounder-baseline */";

/**
 * Append the baseline stylesheet to the generated app.
 *
 * Every run so far has left src/styles.css byte-identical to the template,
 * which styles only the placeholder screen the agent replaces - so the app
 * renders with unstyled browser defaults. Element-selector rules appended at
 * the end apply to whatever markup the agent wrote, and lose to any class rule
 * it authored itself, so this fills gaps rather than overriding intent.
 */
export async function applyBaselineStyles(appRoot: string, baselinePath: string): Promise<boolean> {
  const stylesPath = path.join(appRoot, "src", "styles.css");
  let current: string;
  try {
    current = await readFile(stylesPath, "utf8");
  } catch {
    return false; // no stylesheet to extend; the app may not import one
  }
  if (current.includes(BASELINE_MARKER)) return false; // already applied

  let baseline: string;
  try {
    baseline = await readFile(baselinePath, "utf8");
  } catch {
    return false;
  }
  await writeFile(stylesPath, `${current.trimEnd()}\n\n${BASELINE_MARKER}\n${baseline.trimStart()}`, "utf8");
  return true;
}


/**
 * Cheap provisional report, written during the run.
 *
 * Every other safety net here hangs off agent_settled. If a child process the
 * agent starts never returns - a hanging `npm test` was the case that exposed
 * this - Pi never settles, the runner kills it at CHALLENGE_TIMEOUT_MS, and none
 * of this extension runs at all. No report means FALLBACK_PARTIAL and a
 * hardcoded "failed", however much working code is on disk.
 *
 * So put an honest floor on disk as early as there is one to write: zero
 * entries, status `partial`, no claims. It costs no model tokens and no
 * subprocess. ensureReport() replaces it with real Vitest evidence at settle.
 */
async function writeProvisionalReport(appRoot: string): Promise<boolean> {
  const reportPath = path.join(appRoot, REPORT_FILE);
  if (await readReport(reportPath)) return false; // something is already there
  const assumptions = await readRecordedAssumptions(appRoot);
  const report = {
    ...synthesizeReport([], assumptions),
    summary:
      "Provisional report written by the harness while the run was still in progress. " +
      "It was not replaced with verified test evidence, so the run did not reach a clean finish.",
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return true;
}

export default function reportWriter(pi: ExtensionAPI) {
  const appRoot = process.cwd();
  const reportPath = path.join(appRoot, REPORT_FILE);
  let observedTestCommand: string | undefined;
  let repairAttempted = false;
  let provisionalWritten = false;
  let reportIsStale = false;

  // Remember the command the agent actually used, so a repaired entry is truthful.
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = String(asRecord(event.input)?.command ?? "").trim();
    if (command && isTestCommand(command)) observedTestCommand = command;
    return undefined;
  });

  // A floor on disk, in case the run never settles.
  pi.on("turn_end", async (_event, context) => {
    if (provisionalWritten) return;
    provisionalWritten = true;
    const wrote = await writeProvisionalReport(appRoot).catch(() => false);
    if (wrote && context.hasUI) context.ui.notify("Provisional report.partial.json written", "info");
  });

  // Last moment before Pi stops for good.
  pi.on("agent_settled", async (_event, context) => {
    // Presentation first: it changes no behaviour, so it must not be gated on
    // verification passing or on the agent having cooperated.
    const styled = await applyBaselineStyles(appRoot, BASELINE_STYLES_PATH);
    if (styled && context.hasUI) context.ui.notify("Applied baseline stylesheet", "info");

    // Always leave a valid report on disk before anything else, so a repair
    // attempt that never comes back cannot leave the run with nothing.
    await ensureReport(context);

    if (repairAttempted) return;
    repairAttempted = true;

    const problems = await findBlockingProblems(appRoot);
    if (!problems) return;

    // sendUserMessage is on ExtensionAPI (pi), NOT on the per-handler context.
    // An earlier version called context.sendUserMessage and the defensive typeof
    // check silently swallowed it, leaving this whole path dead across three runs.
    if (typeof pi.sendUserMessage !== "function") return; // report is already written
    if (context.hasUI) context.ui.notify("Verification failed - requesting one repair pass", "warning");
    reportIsStale = true;
    // Fire, do NOT await. Awaiting here deadlocks: sendUserMessage resolves only
    // once Pi processes the message, and Pi cannot start until this handler
    // returns. An earlier version awaited it and hung until CHALLENGE_TIMEOUT_MS.
    void Promise.resolve(pi.sendUserMessage(repairInstruction(problems))).catch(() => undefined);
    // Pi runs again; agent_settled fires a second time and ensureReport() reruns
    // against the repaired workspace.
  });

  async function ensureReport(context: ExtensionContext) {
    const existing = await readReport(reportPath);

    if (!reportIsStale && existing && entriesAreComplete(existing)) return; // agent did its job

    // Case 1: a report exists but its entries would be discarded by the runner.
    if (existing && Array.isArray(existing.tests_run) && existing.tests_run.length > 0) {
      const repaired = existing.tests_run.map((entry) => {
        const record = asRecord(entry) ?? {};
        return {
          command:
            typeof record.command === "string" && record.command.trim()
              ? record.command
              : (observedTestCommand ?? DEFAULT_TEST_COMMAND),
          journey: typeof record.journey === "string" ? record.journey : "unnamed journey",
          result: record.result === "passed" ? "passed" : "failed",
        } satisfies TestRun;
      });
      const existingAssumptions = Array.isArray(existing.assumptions) ? existing.assumptions : [];
      const assumptions =
        existingAssumptions.length > 0 ? existingAssumptions : await readRecordedAssumptions(appRoot);
      await writeFile(
        reportPath,
        `${JSON.stringify({ ...existing, assumptions, tests_run: repaired }, null, 2)}\n`,
        "utf8",
      );
      if (context.hasUI) context.ui.notify("report.partial.json: filled in missing tests_run fields", "info");
      return;
    }

    // Case 2: no usable report at all. Rebuild it from a real Vitest run.
    // Even when Vitest cannot run we still write a report: zero entries is an
    // honest claim (the runner scores it `partial`), whereas writing nothing
    // triggers FALLBACK_PARTIAL and a hardcoded "failed".
    const { runs } = await collectVitestEvidence(appRoot, context.signal);
    const assumptions = await readRecordedAssumptions(appRoot);
    await writeFile(reportPath, `${JSON.stringify(synthesizeReport(runs, assumptions), null, 2)}\n`, "utf8");
    if (context.hasUI) {
      context.ui.notify(`report.partial.json written from ${runs.length} recorded test result(s)`, "info");
    }
  }
}
