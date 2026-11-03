// Micro benchmark for path-click.ts transformMarkdown. Run: node path-click.bench.mjs
// Compares a git revision (BASE env, default dbfb243 = pre-Everything version; i.e. `git show $BASE:path-click.ts`)
// against the working tree, with the Everything feature off / on (cold cache) / on (warm cache).
// Set BASE=HEAD to compare against the last commit instead.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// path-click.ts imports getNativeClipboard from pi-tui (not installed here; unused by transformMarkdown).
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== "@earendil-works/pi-tui") return next(specifier, context);
    const source = "export const getNativeClipboard = () => undefined;";
    return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
  },
});

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "path-click-bench-")));
const cwd = path.join(root, "proj");
for (const d of ["src/components", "src/utils", "docs", "tests/unit", "scripts"]) {
  mkdirSync(path.join(cwd, d), { recursive: true });
}
for (const f of ["src/components/Button.tsx", "src/utils/format.ts", "docs/guide.md", "package.json", "tests/unit/format.test.ts", "scripts/build.mjs", "README.md"]) {
  writeFileSync(path.join(cwd, f), "");
}
const baselineFile = path.join(root, "path-click.head.mts");
writeFileSync(baselineFile, execFileSync("git", ["show", `${process.env.BASE ?? "dbfb243"}:path-click.ts`], { cwd: here }));

const abs = (p) => path.join(cwd, p);
// ~4 KB realistic assistant message, ~40 path-like tokens.
const message = `I looked through the project and here is what I found.

The button component lives in src/components/Button.tsx and its styles were in
\`src/components/Button.module.css\` (that file no longer exists). The formatter is
src/utils/format.ts:42 and the old helper src/utils/old/helper.ts was removed.
See also [the guide](docs/guide.md) and [API reference](docs/api/v2/reference.md).

## Changes

1. Updated \`src/utils/format.ts\` to handle input/output conversion and/or rounding.
2. Moved the logic from src/utils/legacy.ts into src/utils/format.ts:10:5.
3. Added tests in tests/unit/format.test.ts and tests/unit/parse.test.ts.
4. The build script scripts/build.mjs now calls scripts/release.mjs, which reads
   ${abs("package.json")} and writes ${abs("dist/out/index.js")}.
5. Client/server communication (read/write, true/false) is unchanged.

Relevant upstream docs: https://nodejs.org/api/fs.html#fsstatsyncpath-options and
https://github.com/voidtools/everything/issues/1 plus <https://example.com/a/b/c>.

### Notes

- \`docs/guide.md#L12\` explains the yes/no flags; \`docs/missing-guide.md\` was never written.
- The config moved from ./config/app.json to ./src/config/app.json (neither exists yet).
- The parent workspace file ../workspace.code-workspace and ../other/project/x.ts.
- Check ~/.config/pi/settings.json and ~/nonexistent-dir/file.txt for local overrides.
- Windows path C:\\Windows\\System32\\drivers\\etc\\hosts and C:\\Windows\\nope\\missing.dll.
- Typical ratio is 3/4 and the A/B test ran for 2/3 of the time.
- Files: README.md, \`README.md\`, \`src/index.ts\`, \`src/components/Card.tsx\`.
- Tests: \`tests/unit/format.test.ts:7\`, tests/e2e/login.spec.ts, tests/unit/snapshots/a.snap.

\`\`\`ts
// fenced code is never touched: src/components/Button.tsx
import { format } from "./src/utils/format";
\`\`\`

Finally, the CI config in .github/workflows/ci.yml references scripts/build.mjs and
scripts/missing.sh; the package entry point is src/index.ts; lint config is
.eslintrc.json. Everything else (src/utils/*, docs/*) looks fine. It works on
macOS/Linux/Windows and in Node 22/24. See src/components/Button.tsx:12:3 for the
prop types and src/components/Missing.tsx for the planned component.

## Follow-up

If you want, I can also rename src/utils/format.ts to src/utils/formatting.ts, update
the imports in src/components/Button.tsx and src/components/Header.tsx, and delete
docs/old/changelog.md. The migration guide (docs/migration.md) should mention that
the CLI flag --out-dir/--outDir is accepted in both spellings, and that the default
log level is info/warn depending on NODE_ENV. Performance is roughly O(n) per
request/response pair; memory stays under 50 MB/s of throughput in my tests.

Let me know whether you prefer the smaller change (only touching the formatter and its
tests) or the full refactor, which also updates the documentation, the release script
and the CI workflow. Either way I will run the whole test suite before committing.
`.repeat(1);

const ITER = Number(process.env.ITER ?? 400);
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
function bench(label, fn, before) {
  for (let i = 0; i < 30; i++) { before?.(); fn(); }
  const times = [];
  for (let i = 0; i < ITER; i++) {
    before?.();
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return { label, median: median(times), p90: sorted[Math.floor(sorted.length * 0.9)] };
}

const base = await import(pathToFileURL(baselineFile).href);
const next = await import(pathToFileURL(path.join(here, "path-click.ts")).href);
const out = next.transformMarkdown(message, cwd, "file", { everything: true });
const count = (s, re) => (s.match(re) ?? []).length;
console.log(`message: ${message.length} chars; links: file=${count(out, /\]\(file:/g)} es=${count(out, /\]\(es:/g)} (baseline file=${count(base.transformMarkdown(message, cwd), /\]\(file:/g)})`);
if (process.env.SHOW) console.log(out);

const results = [
  bench(`baseline (${process.env.BASE ?? "dbfb243"})`, () => base.transformMarkdown(message, cwd)),
  bench("new, everything off", () => next.transformMarkdown(message, cwd, "file", {})),
  bench("new, everything on, cold cache", () => next.transformMarkdown(message, cwd, "file", { everything: true }), next.clearPartialPathCache),
  bench("new, everything on, warm cache", () => next.transformMarkdown(message, cwd, "file", { everything: true })),
];
console.log(`iterations=${ITER}`);
for (const r of results) {
  console.log(`${r.label.padEnd(34)} median ${r.median.toFixed(3)} ms   p90 ${r.p90.toFixed(3)} ms`);
}
rmSync(root, { recursive: true, force: true });
