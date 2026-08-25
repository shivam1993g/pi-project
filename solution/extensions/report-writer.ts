import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

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

export default function reportWriter(pi: ExtensionAPI) {
  const appRoot = process.cwd();
  const reportPath = path.join(appRoot, REPORT_FILE);
  let observedTestCommand: string | undefined;

  // Remember the command the agent actually used, so a repaired entry is truthful.
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = String(asRecord(event.input)?.command ?? "").trim();
    if (command && isTestCommand(command)) observedTestCommand = command;
    return undefined;
  });

  // Last moment before Pi stops for good.
  pi.on("agent_settled", async (_event, context) => {
    const existing = await readReport(reportPath);

    if (existing && entriesAreComplete(existing)) return; // agent did its job

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
    const { runs, ran } = await collectVitestEvidence(appRoot, context.signal);
    if (!ran) return; // cannot verify anything - do not write a claim we cannot support
    const assumptions = await readRecordedAssumptions(appRoot);
    await writeFile(reportPath, `${JSON.stringify(synthesizeReport(runs, assumptions), null, 2)}\n`, "utf8");
    if (context.hasUI) {
      context.ui.notify(`report.partial.json written from ${runs.length} recorded test result(s)`, "info");
    }
  });
}
