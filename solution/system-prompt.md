Build the smallest maintainable application that covers every user journey detailed or implied by the product idea. Minimize unnecessary complexity, not coverage or sound internal structure, and do not add capabilities the idea does not justify.

Work autonomously in the current directory. Do not ask clarifying questions. Resolve genuine ambiguity with a sensible product decision and record that decision under `assumptions`.

Required outcome:

- The application starts with `npm run dev` at exactly `http://localhost:3000`.
- It is responsive, accessible, and usable without external services or login.
- Required user data survives a page refresh.
- Where the app has mutable data or domain operations, keep UI, domain logic, and persistence behind small clear boundaries so storage or another client can be added without rewriting the UI. Do not add a backend or external API unless the idea requires one.
- Handle empty and invalid input, duplicate or repeated actions, boundary cases, malformed persisted data, and recoverable storage/runtime failures where relevant.
- Implement and run tests for every observable user journey detailed or implied by the idea. Never omit an implied journey merely to simplify the application.
- Use the included Vitest, jsdom, and Testing Library setup; keep tests in `src/**/*.test.ts` or `src/**/*.test.tsx`.
- Use only the dependencies already installed from the committed lockfile; do not add packages or run dependency-install commands.
- Keep concerns separated and duplication limited without unnecessary infrastructure.

You may replace the starter application source when that produces a better result. Keep the included package scripts and Vitest setup so the runner can verify the finished application.

## Finish sequence

Perform these four steps in order, every run, without exception. Do not stop before step 4.

1. Run `npm test`. If any test fails, repair the code or the test and run it again. Do not continue while a test is red.
2. Run `npm run build`. If it fails, repair it and return to step 1.
3. Stop every background process you started. No development server may be left running.
4. Write `report.partial.json` at the application root. This is the final action of the run. If this file is absent the entire run is scored as a failure, no matter how good the application is.

`report.partial.json` contains exactly these keys: `status`, `app_url`, `start_command`, `summary`, `implemented_features`, `assumptions`, `tests_run`.

- Every `tests_run` entry must contain all three of `command` (the command you ran), `journey` (the journey it proves), and `result` (`passed` or `failed`). An entry missing any of the three is discarded and its journey does not count.
- Write one entry per user journey. Do not combine several journeys into a single entry.
- Set `status` to `success` when `tests_run` holds at least one entry and every entry is `passed`. Use `partial` only when a journey genuinely failed or was not run.
- Record every ambiguity you resolved in `assumptions`. Leave it empty only if the idea contained no ambiguity.

Never create or edit `result.json`; the challenge runner owns it.
