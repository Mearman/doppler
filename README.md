# Doppler

Offline and real-time aircraft Doppler audio geolocation: a TypeScript library, a CLI (`doppler`) and an installable PWA (Progressive Web App) that locate where an audio recording was made from the Doppler shifts of aircraft flyovers.

Stack: TypeScript (ESM only), Zod, React with Mantine and vanilla-extract (site), tsdown (library and CLI build), esbuild (site build), Vitest, Playwright, semantic-release. pnpm manages packages.

## Getting started

Prerequisites: Node 22 or later, and pnpm at the version in `packageManager` in `package.json` (Corepack installs it).

```sh
pnpm install
```

`pnpm-workspace.yaml` is not a real workspace. It holds pnpm settings only:

- `saveExact` writes exact versions. Add and upgrade packages with `pnpm add`, never by editing `package.json`.
- `minimumReleaseAge` rejects any release younger than seven days. An install that fails as "too new" needs an older version, or `minimumReleaseAgeExclude` for a package you own.
- `allowBuilds` permits the `esbuild` install script only. Every other dependency install script is blocked.

No environment variables are required to build, test or run. The scheduled ADS-B workflow reads `HF_TOKEN` from CI secrets.

## Build, test, and lint

| Task | Command |
| --- | --- |
| Build library (`dist/`) and CLI (`dist-cli/`) | `pnpm build` |
| Build the PWA into `site-dist/` | `pnpm site` |
| Typecheck (five tsconfig projects) | `pnpm typecheck` |
| Lint, as CI runs it | `pnpm lint:check` |
| Lint and auto-fix | `pnpm lint` |
| Unit and integration tests | `pnpm test` |
| Browser tests (builds first) | `pnpm test:e2e` |

Run one test file or one test:

```sh
pnpm vitest run src/physics/geo.unit.test.ts
pnpm vitest run src/physics/geo.unit.test.ts -t "test name" --coverage.enabled=false
pnpm exec playwright test -g "test name"
```

Coverage is on by default in `vitest.config.ts`. Add `--coverage.enabled=false` to skip it. `playwright test` serves `site-dist/` and does not rebuild it, so run `pnpm build && pnpm site` first after a source change.

Run the CLI from source or from the build:

```sh
pnpm tsx cli/doppler.ts locate fixtures/colsto-flyover-36m.wav --json
node dist-cli/doppler.mjs --help
```

CI (`.github/workflows/ci.yml`) runs, in order: typecheck, lint, tests, build, `publint` plus `attw --pack --profile esm-only` (package export checks), site build, Playwright. `pnpm prepublishOnly` runs the same gates locally.

## Architecture

The repository has four consumers of one core:

- **`src/`** is the isomorphic core. It must run in Node, browsers and Web Workers. `tsconfig.json` sets `types: []` with a `WebWorker` lib, so a Node-only global in `src/` fails to compile there. It excludes `src/node/`, `src/browser/` and `*.test.ts`, which other tsconfig projects check.
- **`src/node/`** and **`src/browser/`** are the platform edges (file system, ADS-B streaming, microphone capture, `localStorage` session storage). Each has an `entry.ts` that re-exports `src/index.ts` plus its own surface. These are the package exports `@mearman/doppler`, `@mearman/doppler/node` and `@mearman/doppler/browser`.
- **`cli/doppler.ts`** is the CLI. It imports from `../src` directly and is bundled to `dist-cli/doppler.mjs`, the package `bin`.
- **`site/`** is the PWA. `site/build.ts` bundles `site/client/app.tsx`, the solver Web Worker and the service worker with esbuild. `site/build-site.ts` writes `index.html`, the manifest and `precache.json`. `site/precache.ts` appends a SHA-256 digest of the precached files to the manifest version, so the service worker refreshes its cache whenever any precached byte changes.

Data flows through four layers inside `src/`, each importing only from the layers above it in this list:

1. `schemas.ts` (with `define.ts`, `own.ts`, `record.ts`): Zod schemas and the types inferred from them. All data that crosses a boundary (JSON files, worker messages, stored sessions) is parsed with them.
2. `physics/`: geodesy (`geo.ts`), atmosphere and speed of sound, retarded-time closest-point-of-approach, Ramer-Douglas-Peucker trajectory simplification (`rdp.ts`) and algebra helpers.
3. `dsp/`: FFT, decimation, spectrogram, ridge tracking that turns a spectrogram into Doppler observations, dechirp, and side channels such as ENF (Electric Network Frequency) detection and WAV encoding.
4. `solver/`: the constellation index of known flight segments, Gauss-Newton refinement of the observer position, and `DopplerSessionEngine` (`session.ts`), which accumulates observations across listening episodes into a log-posterior over location hypotheses.

`bundled.ts` holds a synthetic reference dataset (Oxford, UK) used as the default dataset by the CLI and the site worker. The browser runs the engine inside `site/client/solver-worker.ts`, which the UI drives through typed request and reply messages.

## Conventions

- **Schema-attached guards.** Define a boundary schema as `export const XSchema = define(z.object({...}))` and export the type under the bare name (`export type X = z.infer<typeof XSchema>`), so the value and the type never share a name. `define` adds `.is()` by defining the property on the schema itself, since a spread copy of a Zod 4 schema loses its prototype methods.
- **Records keyed by data** use `recordOf` (rejects `__proto__` keys) for parsing and `getOwn` for reading. A plain `record[key]` read finds inherited properties such as `constructor`.
- **Strict TypeScript.** `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on, so an optional field that you pass through is typed `T | undefined` and an indexed read must be narrowed. Build option objects with conditional spreads, as `solver-worker.ts` does.
- **File suffixes decide the runner.** `*.unit.test.ts` and `*.integration.test.ts` run in Vitest. `*.browser.ts` under `site/e2e/` runs in Playwright only. Unit tests sit next to the source they test.
- **Lint comes from `@exadev/eslint-config`.** Overrides live in `eslint.config.ts` with a reason for each. Add a files-scoped override there with a reason, not an inline `eslint-disable`. The magic-number rule is off for numerical code (`physics`, `dsp`, `solver`, tests, `site`, `cli`) and on elsewhere.
- **Code comments** state the invariant or the reason. Public functions carry a doc comment with `@param` and `@returns`.
- **Git hooks** are in `.husky/` and are installed by `pnpm install` (the `prepare` script). `pre-commit` lints staged `.ts` and `.tsx` files with `--fix`. `commit-msg` runs commitlint. `pre-push` runs typecheck, lint, tests and build, which is CI without the browser tests. Never bypass them with `--no-verify`: fix the failure.
- **Commits** follow Conventional Commits. The allowed types and their release levels are the `commitTypes` list in `release.config.ts`, which `commitlint.config.ts` also reads. Every listed type releases at least a patch, `docs`, `test`, `chore` and `ci` included. `feat` releases a minor and a breaking change releases a major.
- Use British English in prose and comments.

## Non-obvious behaviour

- **External fixture audio is not in git.** `fixtures/*.wav`, `*.m4a` and `*.mp3` are gitignored (the full recording is about 300 MB). Tests against downloaded fixtures guard with `if (!existsSync(path)) { return; }`, while a built-in synthetic benchmark executes and verifies the complete inversion pipeline in CI and clean checkouts. Put recordings in `fixtures/` for full offline forensics verification.
- **`pnpm test:e2e` needs a free port 4174** and does not reuse a running server (`reuseExistingServer: false`). Chromium runs with fake audio devices so that the microphone permission prompt does not block.
- **The CLI bundle does not depend on `dist/`.** `tsdown.config.ts` marks `@mearman/doppler` and `@mearman/doppler/node` external for the CLI, but `cli/doppler.ts` imports `../src` directly, so the two builds are independent.
- **The CLI version is read from `package.json`** via `import.meta.url`, ensuring CLI output (`doppler -v`) stays synchronized with semantic-release without hardcoded literals.
- **`incremental-adsb.yml` builds a day's dataset but does not publish it.** It streams the `adsb.lol` `globe_history` release for the target day through `doppler ingest --input -` and writes `YYYY-MM-DD.dataset.json` on the runner. Where the file is stored is not configured yet.
- **Real ADS-B data enters through `doppler ingest`.** It accepts a raw `adsb.lol` or `tar1090` trace file, a directory of them, ready-made segments, or (`--input -`) the day's tar on standard input, with `--bbox` to keep one region. Without `--dataset`, `locate` and the PWA match against the three synthetic flyovers in `src/bundled.ts` only.
- **Workflows pin actions differently.** `pages.yml` pins actions by commit SHA. `ci.yml` and `incremental-adsb.yml` use version tags. Keep the pins in the style of the file you edit.

## References

- `release.config.ts`: release rules and the commit-type list.
- `eslint.config.ts`: lint overrides and the reason for each.
- `.github/workflows/`: CI, GitHub Pages deploy and the scheduled ADS-B pipeline.
