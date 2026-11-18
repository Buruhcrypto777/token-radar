// Token Radar: the entrypoint for the token-radar-01 bounty (Node 22, standard library only).
//
// Run it from this directory with the sealed snapshot beside it:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
//
// It scores every protocol in the snapshot with the radar-2 model in lib/model.ts, writes the
// ranked board to board.json, renders the dashboard's dataset as data.js, copies the static
// dashboard and the screenshots into the output directory, and finishes by writing dossier.json
// with the vendored make.fun dossier builder. The board is the gate's input and the dossier is
// the judge's reading copy. Both runs of the grader must produce the same bytes, so nothing here
// reads the clock, the network or any random source.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { findBoardProblem, scoreSnapshot, renderDataScript, decodeSnapshot } from './lib/model.ts';
import { buildDossier as makeDossier } from './vendor/makefun-board.ts';

/** The most bytes of dashboard source the dossier may carry. */
const MAX_TEXT_BYTES = 65_536;
/** How many screenshots the dossier accepts, and how big one may be. */
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
/** A screenshot's file name: letters, digits and . _ -, 1 to 128 characters, never starting with a dot. */
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The entrypoint's own directory, so dashboard/ and screenshots/ are found beside main.ts. */
const entryRoot = url.fileURLToPath(new url.URL('.', import.meta.url));

/** Write a message to stderr and stop the program with the given exit code. */
function abort(message: string, code: number): never {
  process.stderr.write(message);
  process.exit(code);
}

/** The value after `--name <value>` or `--name=<value>` on the command line, or `fallback`. */
function flagValue(name: string, fallback: string): string {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === `--${name}` && i + 1 < argv.length) return argv[i + 1]!;
    if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
  }
  return fallback;
}

/** Copy a directory's plain files into `target`, skipping dot-files; returns the names copied. */
function copyPlainFiles(sourceDir: string, targetDir: string): string[] {
  if (!fs.existsSync(sourceDir)) return [];
  fs.mkdirSync(targetDir, { recursive: true });
  const names: string[] = [];
  for (const entry of fs.readdirSync(sourceDir)) {
    if (entry.startsWith('.')) continue;
    const from = path.join(sourceDir, entry);
    if (!fs.statSync(from).isFile()) continue;
    fs.copyFileSync(from, path.join(targetDir, entry));
    names.push(entry);
  }
  return names;
}

const inputOption = flagValue('input', '/input');
const snapshotPath = inputOption.endsWith('.json') ? inputOption : path.join(inputOption, 'snapshot.json');
if (!fs.existsSync(snapshotPath)) {
  abort(`token radar: no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input\n`, 2);
}
const outputDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snap = decodeSnapshot(fs.readFileSync(snapshotPath, 'utf8'));
const { board, radar } = scoreSnapshot(snap);
const problem = findBoardProblem(board, snap);
if (problem !== null) {
  abort(`token radar: the model wrote a board the gate refuses: ${problem}\n`, 1);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
fs.writeFileSync(path.join(outputDir, 'data.js'), renderDataScript(radar));

copyPlainFiles(path.join(entryRoot, 'dashboard'), path.join(outputDir, 'dashboard'));
const shotNames = copyPlainFiles(path.join(entryRoot, 'screenshots'), path.join(outputDir, 'screenshots'));
if (shotNames.length < 3) {
  abort(`token radar: screenshots/ holds ${shotNames.length} image${shotNames.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`, 1);
}
for (const shot of shotNames) {
  if (!SHOT_NAME.test(shot)) {
    abort(`token radar: screenshots/${shot}: a name is letters, digits and . _ -, 1 to 128 characters\n`, 1);
  }
}

// The dossier is written last: the scorer rebuilds it from this output and compares bytes.
fs.writeFileSync(
  path.join(outputDir, 'dossier.json'),
  makeDossier(outputDir, {
    text_max_bytes: MAX_TEXT_BYTES,
    screenshots: SHOT_LIMITS,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

const report = [
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)`,
  `token radar: wrote ${path.join(outputDir, 'board.json')}, ${path.join(outputDir, 'data.js')}, ${path.join(outputDir, 'dashboard')} (3 files), ${path.join(outputDir, 'screenshots')} (${shotNames.length} images) and ${path.join(outputDir, 'dossier.json')}`,
];
process.stdout.write(`${report.join('\n')}\n`);
