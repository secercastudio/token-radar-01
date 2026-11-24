// Token Radar radar-2 entry (Node 22, standard library only) — rewritten in this session.
//
// The program reads the sealed snapshot from /input/snapshot.json (or
// --input <file|dir>), scores every pre-token protocol with the model in
// lib/model.ts, writes the ranked board to /output/board.json, and copies this
// repository's dashboard/ and screenshots/ to /output. Last, it writes
// /output/dossier.json, the summary the judge reads, with the vendored
// make.fun library.
//
// The dashboard is a static page, no framework and no network:
// dashboard/index.html, dashboard/app.css and dashboard/app.js read
// /output/data.js, which this program writes from the same board. A starting
// point, not a winner: it covers the watchlist, states the model and gives
// every protocol a farm plan. Change the model, the page or the plan; keep
// the gate's shape.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const DOSSIER_TEXT_CAP = 65_536;
const SHOT_LIMIT = { max: 4, max_bytes: 524_288 };
const DASH_LIMIT = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value after `--name <value>` or `--name=<value>`, or `fallback` when absent. */
function cliValue(name: string, fallback: string): string {
  const argv = process.argv;
  const slot = argv.indexOf(`--${name}`);
  if (slot >= 0 && slot + 1 < argv.length) return argv[slot + 1]!;
  const glued = argv.find((a) => a.startsWith(`--${name}=`));
  if (glued === undefined) return fallback;
  return glued.slice(name.length + 3);
}

/** Copy one directory's regular files into `dest`, skipping dot-names; returns the names copied. */
function copyDirectory(source: string, dest: string): string[] {
  if (!existsSync(source)) return [];
  mkdirSync(dest, { recursive: true });
  const names: string[] = [];
  for (const entry of readdirSync(source)) {
    if (entry.startsWith('.')) continue;
    const from = join(source, entry);
    if (!statSync(from).isFile()) continue;
    copyFileSync(from, join(dest, entry));
    names.push(entry);
  }
  return names;
}

function fail(message: string, code: number): never {
  process.stderr.write(message);
  process.exit(code);
}

// --- inputs ---------------------------------------------------------------

const inputGiven = cliValue('input', '/input');
const snapshotPath = inputGiven.endsWith('.json') ? inputGiven : join(inputGiven, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(
    `token radar: no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input\n`,
    2,
  );
}
const outDir = cliValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const refused = boardIssue(board, snapshot);
if (refused !== null) {
  fail(`token radar: the model wrote a board the gate refuses: ${refused}\n`, 1);
}

// --- outputs --------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

copyDirectory(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyDirectory(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  const plural = shots.length === 1 ? '' : 's';
  fail(
    `token radar: screenshots/ holds ${shots.length} image${plural}: hand in 3, the board, a detail view and a filtered view\n`,
    1,
  );
}
for (const shot of shots) {
  if (!SHOT_NAME.test(shot)) {
    fail(`token radar: screenshots/${shot}: a name is letters, digits and . _ -, 1 to 128 characters\n`, 1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
const dossier = buildDossier(outDir, {
  text_max_bytes: DOSSIER_TEXT_CAP,
  screenshots: SHOT_LIMIT,
  dashboard: DASH_LIMIT,
});
writeFileSync(join(outDir, 'dossier.json'), dossier);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (3 files), ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}\n`,
);
