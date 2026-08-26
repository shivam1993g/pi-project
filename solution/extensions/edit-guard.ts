import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";

/**
 * Circuit breaker for edit thrashing.
 *
 * The agent periodically gets stuck rewriting one file - almost always its own
 * test - and cannot converge. Measured across runs on identical configuration:
 *
 *   healthy runs   57-70 calls    max  6-7 edits to any single file
 *   thrashing runs 122-178 calls  max 19-20 edits to a single file
 *
 * A 178-call run cost EUR 0.55 against EUR 0.087 for a 23-call run of the same
 * idea. Thrashing, not prompt size, is the dominant cost risk.
 *
 * This intervenes through the tool_call hook rather than by asking the model to
 * restrain itself. An earlier prompt-based attempt ("do not continue while a
 * test is red ... return to step 1") removed the agent's exit condition and made
 * thrashing worse. Blocking a call feeds `reason` back as the tool result, so
 * the guidance arrives exactly where the agent is already looking - the same
 * mechanism protected-paths uses.
 *
 * Nudges are deliberately sparse: two pieces of advice, then a hard stop on that
 * one file. It never suggests deleting tests, because an empty tests_run scores
 * `partial` no matter how good the application is.
 */

const FIRST_NUDGE = 10;
const SECOND_NUDGE = 16;
const HARD_STOP = 24;

export default function editGuard(pi: ExtensionAPI) {
  const appRoot = process.cwd();
  const edits = new Map<string, number>();
  const delivered = new Set<string>();

  pi.on("tool_call", async (event, context) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

    const candidate = String((event.input as Record<string, unknown>).path ?? "");
    if (!candidate) return undefined;
    const key = path.relative(appRoot, path.resolve(appRoot, candidate));

    const count = (edits.get(key) ?? 0) + 1;
    edits.set(key, count);

    const notify = (message: string) => {
      if (context.hasUI) context.ui.notify(`edit-guard: ${message}`, "warning");
    };

    if (count === FIRST_NUDGE && !delivered.has(`${key}:1`)) {
      delivered.add(`${key}:1`);
      notify(`${key} edited ${count} times`);
      return {
        block: true,
        reason:
          `You have edited ${key} ${count} times without converging. ` +
          `Run \`npm test\` and read the actual failure before editing it again, ` +
          `rather than adjusting it speculatively.`,
      };
    }

    if (count === SECOND_NUDGE && !delivered.has(`${key}:2`)) {
      delivered.add(`${key}:2`);
      notify(`${key} edited ${count} times`);
      return {
        block: true,
        reason:
          `${key} has now been edited ${count} times and is still not settling. ` +
          `Replace its contents with the smallest test that covers one user journey ` +
          `and that you are confident passes, then move on to the remaining work. ` +
          `Do not leave the file without any test.`,
      };
    }

    if (count > HARD_STOP) {
      notify(`${key} blocked after ${HARD_STOP} edits`);
      return {
        block: true,
        reason:
          `Editing ${key} is not converging after ${HARD_STOP} attempts and further ` +
          `edits are blocked. Leave this file as it stands and complete the rest of ` +
          `the work, including writing report.partial.json.`,
      };
    }

    return undefined;
  });
}
