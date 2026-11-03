# Environment Snapshot

A dated record of the environment QATOOL was set up and checked in, for troubleshooting,
compatibility checks and quick recovery. Machine-readable twin:
[`ENVIRONMENT_SNAPSHOT.json`](ENVIRONMENT_SNAPSHOT.json).

> The lockfile (`package-lock.json`) is the source of truth for the full dependency tree. This file
> records what was observed, not what must be true. Nothing here is a recommendation to change a
> version.

## Contents

1. [Snapshot date and purpose](#1-snapshot-date-and-purpose)
2. [Operating system and hardware](#2-operating-system-and-hardware)
3. [Runtime and toolchain](#3-runtime-and-toolchain)
4. [Technology stack](#4-technology-stack)
5. [Dependency versions](#5-dependency-versions)
6. [Workspace and package manager](#6-workspace-and-package-manager)
7. [Clean installation](#7-clean-installation)
8. [Environment configuration](#8-environment-configuration)
9. [Ports and runtime configuration](#9-ports-and-runtime-configuration)
10. [Build, start, health and verification commands](#10-build-start-health-and-verification-commands)
11. [Compatibility and known issues](#11-compatibility-and-known-issues)
12. [Recovery procedure](#12-recovery-procedure)
13. [Apayee integration](#13-apayee-integration)
14. [Integrity: hashes and Git state](#14-integrity-hashes-and-git-state)
15. [Addendum: after the backend security hardening](#15-addendum-after-the-backend-security-hardening-2026-11-03)
16. [Addendum: public demo backend and frontend, test baseline, lockfile check](#16-addendum-public-demo-backend-and-frontend-test-baseline-lockfile-check-2026-11-03)

## 1. Snapshot date and purpose

- Captured: **2026-11-03 02:30 (UTC+7)**, on the PC where QATOOL was first set up after cloning.
- Purpose: give a future session a fixed reference point when a newer Node.js, npm or dependency
  causes a problem, so "what worked" can be compared with "what is installed now".
- Evidence rules: a version is called _verified_ only where the named check passed on it. The
  verification status of every check is in [section 11](#11-compatibility-and-known-issues).
- Nothing was installed, upgraded or removed to take this snapshot. No LLM provider was called, no
  document was processed, and `/api/extract`, `/api/generate` and `/api/validate` were not used.

## 2. Operating system and hardware

| Item         | Observed                                                    |
| ------------ | ----------------------------------------------------------- |
| OS           | Windows 11 Pro, 10.0.26300 (build 26300.9711), display 26H2 |
| Architecture | 64-bit (x64)                                                |
| CPU          | AMD Ryzen 5 7500F, 6 cores / 12 threads                     |
| Memory       | 15.6 GB                                                     |
| Shells       | PowerShell 5.1 (primary); Git Bash available                |
| Time zone    | SE Asia Standard Time                                       |

## 3. Runtime and toolchain

| Tool           | Observed                 | Notes                                                                                        |
| -------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| Node.js        | **22.15.0** (x64, win32) | V8 12.4.254.21; installed in `C:\Program Files\nodejs`                                       |
| npm            | **11.6.4**               | Registry `https://registry.npmjs.org/`; global prefix under `%APPDATA%\npm`                  |
| Git            | **2.48.1.windows.1**     | `C:\Program Files\Git\cmd` on PATH                                                           |
| Docker Desktop | installed                | Client and engine **29.9.2** (linux/amd64), context `desktop-linux`                          |
| Docker Compose | **v5.6.1**               |                                                                                              |
| WSL            | **2.6.3.0**              | Kernel 6.6.87.2-1, WSLg 1.0.71, default WSL version 2, default distribution `docker-desktop` |

Docker and WSL are recorded only because they exist on this PC. **QATOOL does not use them**: the
repository tracks no Dockerfile or compose file, and the app has no native dependencies. Whether the
Windows optional features (WSL, Virtual Machine Platform) are enabled was not recorded because that
query needs an elevated shell.

PATH and version-manager observations (names only, no user-specific values):

- The Node.js on PATH is the official installer build in `C:\Program Files\nodejs`.
- Other Node.js binaries exist on disk but are **not** on PATH ahead of it: a Laragon copy of
  **22.15.0** (`C:\laragon\bin\nodejs\node-v22.15.0-win-x64`), a Laragon `node-v22` directory, and
  **23.11.0** under `%USERPROFILE%\.config\herd\bin\nvm\v23.11.0`. A Herd `nvm` executable lists only 23.11.0.
- No `fnm` or `volta`. No `.nvmrc`, `.node-version` or `.npmrc` in the project.
- No Node-related environment variables (`NODE_*`, `NPM_*`) are set in the shell.
- npm does not enforce `engines` unless `engine-strict` is set, and it is not set.

## 4. Technology stack

From `CLAUDE.md` and `package.json`; versions are in the next section.

| Layer    | Choice                                                          |
| -------- | --------------------------------------------------------------- |
| Runtime  | Node.js (ESM only, `"type": "module"`), no native dependencies  |
| Backend  | Fastify 5, `@fastify/multipart`, `@fastify/static`, Zod 4       |
| Parsing  | `pdfjs-dist` (PDF), `fflate` (DOCX/XLSX read as zip/XML)        |
| Frontend | React 19, Vite 7, `@vitejs/plugin-react` (npm workspace `web/`) |
| LLM      | Gemini API, Apayee gateway (Claude), scripted `mock` provider   |
| Tests    | Node's built-in runner (`node --test`)                          |
| Style    | Prettier only; no ESLint                                        |

## 5. Dependency versions

Declared ranges are from the `package.json` files; **installed versions are from the lockfile**
(`npm ls --depth=0` agreed with it on this machine). The lockfile has `lockfileVersion` 3 and
221 package entries; it is the only complete inventory and is deliberately not duplicated here.

### Backend (root `package.json`)

| Package              | Declared   | Locked / installed |
| -------------------- | ---------- | ------------------ |
| `fastify`            | `^5.6.1`   | 5.12.5             |
| `@fastify/multipart` | `^10.1.1`  | 10.1.1             |
| `@fastify/static`    | `^8.2.0`   | 8.3.0              |
| `fflate`             | `^0.8.3`   | 0.8.3              |
| `pdfjs-dist`         | `^6.3.289` | 6.3.289            |
| `zod`                | `^4.1.12`  | 4.6.5              |
| `prettier` (dev)     | `^3.6.2`   | 3.9.8              |

### Frontend (`web/package.json`, workspace `web@1.0.0-m1`)

| Package                      | Declared  | Locked / installed |
| ---------------------------- | --------- | ------------------ |
| `react`                      | `^19.2.0` | 19.3.0             |
| `react-dom`                  | `^19.2.0` | 19.3.0             |
| `vite` (dev)                 | `^7.1.9`  | 7.3.6              |
| `@vitejs/plugin-react` (dev) | `^5.0.4`  | 5.2.0              |

### Node engine requirements found in the lockfile

| Source                       | Requires Node.js          |
| ---------------------------- | ------------------------- |
| Project (`engines`)          | `>=22.13.0`               |
| `pdfjs-dist` 6.3.289         | `>=22.13.0 \|\| >=24`     |
| `vite` 7.3.6                 | `^20.19.0 \|\| >=22.12.0` |
| `@vitejs/plugin-react` 5.2.0 | `^20.19.0 \|\| >=22.12.0` |

No engine range is declared for `fastify`, `zod`, `fflate` or the two `@fastify` packages. The
project's own `>=22.13.0` comes from `pdfjs-dist`, which is the binding constraint. One transitive
range in the lockfile (`^22.20 || ^24.12 || >=25`) is higher than the installed 22.15.0: it belongs
to `@napi-rs/lzma-linux-x64-gnu` 1.5.1, an optional, development-only, Linux-only package that is
not installed on Windows, so it does not apply here. It would matter on a Linux machine running a
Node.js older than 22.20. `pdfjs-dist` also lists optional `@napi-rs/canvas` packages; they are
optional and the project does not rely on them.

## 6. Workspace and package manager

- One npm workspace: `web` (declared in the root `workspaces`). There is **no** `web/package-lock.json`;
  the single root `package-lock.json` covers both.
- Root scripts: `dev`, `dev:server`, `dev:server:watch`, `dev:web`, `build`, `start`, `test`,
  `test:llm`, `test:apayee`, `llm:smoke`, `e2e:live`, `qa:eval`, `format`, `format:check`.
- Web scripts: `dev` (`vite`), `build` (`vite build`), `preview`.
- `dev:server` and `start` load `.env` through `node --env-file-if-exists=.env`; a variable already in
  the process environment wins over `.env`.
- `.gitattributes` forces LF (`* text=auto eol=lf`), so the lockfile hash below is the hash of an LF file.
- `.prettierignore` excludes `package-lock.json` and three historical blueprint files.

## 7. Clean installation

Requirements: Node.js `>=22.13.0` and npm. No database, no Docker.

```powershell
git clone <repo-url> QATOOL
cd QATOOL
node -v; npm -v                      # compare with section 3
npm ci                               # installs root and the web workspace from the lockfile
Copy-Item .env.example .env          # see the note below: this file is missing in the current checkout
```

Use `npm ci`, not `npm install`: it installs exactly what the lockfile records and fails if
`package.json` and the lockfile disagree. Do not run `npm update` or `npm audit fix` while
troubleshooting; either can change the lockfile and hide the cause.

## 8. Environment configuration

Variable names and status only. Status was read as "has a value" or "empty" without printing any value.
The list comes from `server/config.js`.

| Variable                | Status at capture | Purpose / note                                                |
| ----------------------- | ----------------- | ------------------------------------------------------------- |
| `PORT`                  | set               | API port (default 3001)                                       |
| `HOST`                  | set               | API bind address (default 127.0.0.1)                          |
| `NODE_ENV`              | set               | `production` makes the API also serve `web/dist`              |
| `LOG_LEVEL`             | set               | Fastify log level                                             |
| `SIT_TEMPLATE_PATH`     | set               | Relative to the project root; no machine-specific path        |
| `MAX_BODY_BYTES`        | set               | Request and upload ceiling (default 25 MB)                    |
| `LLM_PROVIDER`          | set               | Server default: `gemini`, `mock` or `apayee`                  |
| `GEMINI_API_KEY`        | **empty**         | Needed only for the Gemini option; never invented             |
| `GEMINI_MODEL`          | set               | Default `gemini-3.8-flash`                                    |
| `GEMINI_BASE_URL`       | set               | Gemini endpoint                                               |
| `LLM_TIMEOUT_MS`        | set               | Per-call budget                                               |
| `LLM_MAX_OUTPUT_TOKENS` | set               | Output cap                                                    |
| `LLM_TEMPERATURE`       | unset on purpose  | Leave unset for Gemini 3 models                               |
| `APAYEE_BASE_URL`       | set               | Local Apayee address (section 13)                             |
| `APAYEE_TOKEN`          | set               | Must equal Apayee's `APAYEE_AUTH_TOKEN`; value never recorded |
| `APAYEE_QUEUE_WAIT_MS`  | set               | Extra allowance for Apayee's queue                            |

- `.env` is Git-ignored (`.gitignore` rule `.env`, with `!.env.example` re-included).
- **`.env.example` was absent from this checkout when this snapshot was taken** (it exists now, at the root
  and in `web/`; see section 16). `.env` was therefore written from `server/config.js` and
  `docs/IMPLEMENTATION.md` section 17.
- No `VITE_*` variables existed at the time. Four exist now (section 16), all public by design. Keys and
  tokens are server-side only and must never be put in a Vite-exposed variable.

## 9. Ports and runtime configuration

| Service    | Address                 | Observed at capture                                               |
| ---------- | ----------------------- | ----------------------------------------------------------------- |
| QATOOL API | `http://127.0.0.1:3001` | Listening (process started outside this snapshot session)         |
| QATOOL UI  | `http://localhost:5173` | Listening on IPv6 loopback `::1` only                             |
| Apayee     | `http://127.0.0.1:4100` | Listening on IPv4 loopback (process started outside this session) |

- Vite proxies `/api` to `http://127.0.0.1:3001` (`web/vite.config.js`).
- The Vite server on this PC bound to `::1`, so open `http://localhost:5173`; `http://127.0.0.1:5173`
  may not answer. This is Vite's default `localhost` resolution on this machine, not a QATOOL setting.
- `npm run dev` refuses to start if something already answers `http://127.0.0.1:3001/api/health`.
- Under `npm run dev`, React StrictMode runs each UI phase twice, so each stage makes two model calls.
  A production build makes one.

## 10. Build, start, health and verification commands

```powershell
# Start (Apayee first if you want Claude)
npm run dev                          # API :3001, then UI :5173 once /api/health answers
npm run dev:server                   # API only
npm run dev:web                      # UI only
$env:NODE_ENV='production'; npm run build; npm start    # API serves web/dist

# Health (neither calls an LLM)
Invoke-RestMethod http://127.0.0.1:3001/api/health          # {"status":"ok","stateless":true,...}
Invoke-RestMethod http://127.0.0.1:3001/api/llm/providers   # availability of Gemini and Claude

# Verification (offline, no LLM)
npm run format:check
npm run build
npm test
```

Do **not** use `llm:smoke`, `e2e:live`, `qa:eval`, `test:llm` or `test:apayee` for environment checks:
they make real provider calls.

## 11. Compatibility and known issues

### Version classification

| Class                             | Versions                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Currently observed**            | Node.js 22.15.0, npm 11.6.4, Git 2.48.1.windows.1, Windows 11 build 26300                                                                                                          |
| **Previously verified (partial)** | Same Node.js, npm and Git as above: `format:check` and `build` passed; `npm test` did not exit cleanly (below)                                                                     |
| **Minimum required**              | Node.js `>=22.13.0` (project `engines`, bound by `pdfjs-dist`). npm has no declared minimum; the lockfile is version 3, which needs a modern npm (the exact floor was not tested)  |
| **Suspected issues**              | At snapshot time: Node.js 22.15.0 **and** 23.11.0 both showed the 11 cancelled tests in `server/llm/llm.test.js` (**resolved since, section 16**)                                  |
| **Not tested**                    | Node.js 24.x (including the 24.18 the README says it was developed on), Node.js 25, npm other than 11.6.4, Git other than 2.48.1, other operating systems, a production deployment |

At the time of this snapshot no version was fully verified: `npm test` exited 1 on every runtime tried. That has
changed: the cancellations were a test-only problem and are fixed (section 16).

### Historical observations (earlier setup session, same PC)

- Node.js 22.15.0, npm 11.6.4, Git 2.48.1.
- `npm ci` succeeded (159 packages added; 8 audit findings reported, left untouched).
- `npm run format:check` and `npm run build` passed.
- `npm test`: **1,422 passed, 11 cancelled, 0 failed**, but the command **exited with code 1**.
- The cancelled tests were in `server/llm/llm.test.js`. Node.js 22.15.0 was suspected, and the cause
  was not established at that time.

### Current observations compared with that history

| Check                  | Historical (22.15.0)                                            | Re-run at this snapshot (22.15.0) | Also tried: 23.11.0   |
| ---------------------- | --------------------------------------------------------------- | --------------------------------- | --------------------- |
| `npm ci`               | passed                                                          | not re-run (nothing to reinstall) | not run               |
| `npm run format:check` | passed                                                          | passed                            | not run               |
| `npm run build`        | passed                                                          | passed                            | not run               |
| `npm test` totals      | 1444 tests, 1422 pass, 0 fail, 11 cancelled, 1 skipped, 10 todo | identical                         | identical             |
| `npm test` exit code   | 1                                                               | 1                                 | 1                     |
| `llm.test.js` alone    | 23 pass, 11 cancelled                                           | 23 pass, 11 cancelled             | 23 pass, 11 cancelled |

The environment matches the historical record. The Node.js 23.11.0 run used the binary already on
disk, invoked directly with the same flags as `npm test`; nothing was installed and PATH was not changed.

### The cancelled-test issue

> **Resolved (section 16).** Everything in this subsection describes the state when the snapshot was taken. The
> cause was a test-only timer reference in `server/llm/llm.test.js`; there are now 0 cancelled tests and
> `npm test` exits 0. A cancelled test today is a regression.

- **What happens:** in `llm.test.js` the test "reports a timeout as a timeout" never settles; the
  runner reports `Promise resolution is still pending but the event loop has already resolved`, and
  the 10 tests after it in that file are cancelled by their parent. No test fails an assertion.
- **Affected scope:** only the Gemini adapter unit tests, which stub `fetch`; no network is involved.
  The other test files pass.
- **Mechanism (confirmed in isolation, not yet confirmed as the whole explanation):** `server/llm/gemini.js`
  bounds each call with `AbortSignal.timeout()`. A separate probe script showed that on Node.js 22.15.0
  **and** 23.11.0 a promise waiting only on an `AbortSignal.timeout` timer lets the process exit with
  the promise unsettled (exit code 13), because that timer does not keep the event loop alive. The
  test's stubbed `fetch` has nothing else keeping the loop alive.
- **What this changes:** the earlier suspicion that Node.js 22.15.0 specifically was at fault is
  **not supported**; 23.11.0 behaves the same.
- **Not established:** whether Node.js 24.x behaves differently. The README states the project was
  developed on 24.18, but this snapshot has no evidence of a passing run on any version, and 24.x was
  not available to test. Do not treat Node.js 24 as a confirmed fix.
- **Impact on use:** none observed on the application's own behaviour. Production code is unchanged;
  the issue is in how the test waits.

### Other limitations

- `npm audit` reports 8 findings (1 low, 3 moderate, 4 high). Not investigated or fixed.
- `.env.example` is missing from this checkout (section 8).
- Gemini is unusable until `GEMINI_API_KEY` is supplied; the free tier is 20 requests/day/model.
- `README.md` and `docs/IMPLEMENTATION.md` should be treated as authoritative for behaviour; this
  file does not restate them.

## 12. Recovery procedure

Work from the least to the most disruptive step, and change one thing at a time.

**1. Compare before changing anything.**

```powershell
node -v; npm -v; git --version
Get-FileHash package-lock.json -Algorithm SHA256     # compare with section 14
git status --short; git rev-parse HEAD
```

If the lockfile hash differs from section 14, find out why (`git diff package-lock.json`) before
reinstalling.

**2. Reinstall dependencies from the lockfile** (no Node.js change):

```powershell
Remove-Item -Recurse -Force node_modules, web\node_modules -ErrorAction SilentlyContinue
npm ci
npm ls --depth=0 --workspaces --include-workspace-root     # compare with section 5
```

**3. Return to the recorded Node.js (22.15.0).** Only if a newer Node.js is implicated. These commands
were **not executed** during the snapshot; check each against your tooling first.

```powershell
# Option A: a Laragon copy of exactly 22.15.0 already exists on this PC. Use it for one session only:
$env:PATH = "C:\laragon\bin\nodejs\node-v22.15.0-win-x64\node-v22.15.0-win-x64;$env:PATH"
node -v                                              # expect v22.15.0

# Option B: install 22.15.0 system-wide with the official installer, or with winget:
winget install --id OpenJS.NodeJS --version 22.15.0 --exact
```

The npm bundled with Node.js 22.15.0 is normally older than 11.6.4. To match the recorded npm:

```powershell
npm install --global npm@11.6.4
npm -v                                               # expect 11.6.4
```

Then repeat step 2.

**4. Re-verify** with the offline checks only:

```powershell
npm run format:check; npm run build; npm test
```

On the recorded versions the expected result is now **1,978 tests: 1,967 passed, 0 failed, 0 cancelled,
1 skipped, 10 todo, exit code 0** (section 16). The earlier baseline (1422 passed, 11 cancelled, exit code 1,
section 11) is historical. A different result means the environment has drifted from this snapshot, and any
cancelled test is a regression.

**5. If the dependency tree is the suspect:** `package-lock.json` plus `npm ci` is the recovery. If the
lockfile itself was changed, restore it with `git checkout -- package-lock.json` (this discards local
lockfile edits, so look at `git diff` first), then repeat step 2.

**6. Testing a newer Node.js safely.** Install it beside the current one, switch only the PATH of one
shell, and run the offline checks from step 4. Record the result in a new snapshot rather than
editing this one. Do not call a version "fixed" until the whole `npm test` exits 0.

## 13. Apayee integration

Apayee is a separate private AI gateway in its own repository, expected beside this one at
`..\Apayee`. QATOOL only reads from it: do not edit it from here.

| Item                             | Value                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL                         | `http://127.0.0.1:4100` (`APAYEE_BASE_URL`; the code default)                                                                                                                         |
| Why `127.0.0.1`, not `localhost` | Apayee binds IPv4; `localhost` can resolve to `::1` first on Windows                                                                                                                  |
| QATOOL token variable            | `APAYEE_TOKEN`                                                                                                                                                                        |
| Apayee token variable            | `APAYEE_AUTH_TOKEN`                                                                                                                                                                   |
| Rule                             | The two values must be identical; restart both after changing either. Never record the value                                                                                          |
| Request                          | `Authorization: Bearer <token>` header; the token appears nowhere else                                                                                                                |
| Endpoints used                   | `GET /v1/health` (availability) and `POST /v1/generate` (the three LLM calls)                                                                                                         |
| Apayee settings for Claude       | `APAYEE_PROVIDER=claude`, `APAYEE_CLAUDE_EXPERIMENTAL=true`, `APAYEE_AUTH_TOKEN` of at least 32 characters, and a loopback host (per Apayee's README)                                 |
| Availability rule                | "Claude via Apayee" is usable only when `/v1/health` reports provider exactly `claude`. An Apayee on its `mock` provider is reported as unavailable. No fallback to another provider. |
| Node.js requirement              | Apayee also declares `>=22.13.0`                                                                                                                                                      |

**Observed at capture:** QATOOL's `/api/llm/providers` (a health probe only) reported
`claude: available`, with the configured token accepted by Apayee's health check, and
`gemini: not_configured` (empty key). Apayee's checkout was at its own commit `4cf4035` with one
untracked file (`.env.example`). Its `.env` was not read.

**Startup order and commands**

```powershell
# terminal 1: Apayee (its own directory)
npm start                            # http://127.0.0.1:4100

# terminal 2: QATOOL
npm run dev                          # API :3001, UI :5173
```

**Networking assumptions**

- Everything is single-user and loopback-only over plain HTTP. QATOOL refuses a non-loopback
  `APAYEE_BASE_URL` without a token.
- QATOOL has no Claude credentials; Apayee holds the Claude CLI sign-in on this PC.
- Tests never contact Apayee (`npm test` blocks non-localhost traffic and uses a fake gateway).
- Availability is checked before each stage and cached for 5 seconds; restart Apayee, then reload the
  model picker, after changing its provider.

## 14. Integrity: hashes and Git state

SHA-256, computed on the working-tree files at capture time:

| File                | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `package-lock.json` | `acf4d62f5ddd7f367e823159351b3d4769d77edab4163149ba71468a34886763` |
| `package.json`      | `6bf59237604fbb790401b4b3a250dbb6d523efb4f1127e94e9b8a88776d3671a` |
| `web/package.json`  | `da4edd75a8b7df256c2d1fb3ca35908a4e7917ddbf3dd9cd566991d85b6d1007` |

There is no `web/package-lock.json`. `package-lock.json`: `lockfileVersion` 3, 221 package entries.

Git state at capture: branch `main`, commit `49f19f80e62d061f4e4b192d9867f8019ee510a2`
("chore: initial project setup"), **working tree clean** before this snapshot's own files were added.
The Git state therefore describes the code the snapshot was taken against; the snapshot files, and the
short links added to `README.md` and `CLAUDE.md`, are the only later changes.

## 15. Addendum: after the backend security hardening (2026-11-03)

Sections 5, 11 and 14 describe the baseline captured at 02:30 and stay as recorded. Since then the
backend hardening (`docs/PUBLIC_DEMO_SECURITY.md`) changed dependencies and tests, so for those the
figures below supersede the baseline. Node.js (22.15.0), npm (11.6.4) and Git are unchanged.

| Item                                    | Baseline                                    | After hardening                                                                  |
| --------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| New direct dependencies                 | none                                        | `jose` `^6.2.15` (locked 6.2.15), `@fastify/cors` `^11.4.0` (locked 11.4.0)      |
| Transitive additions                    | none                                        | `fastify-plugin` 6.0.1, nested under `@fastify/cors`                             |
| Existing versions changed               | n/a                                         | **none** (compared package by package against the committed lockfile)            |
| `package-lock.json` entries             | 221                                         | 224                                                                              |
| `package-lock.json` SHA-256             | `acf4d62f...86763`                          | `65f0f5a046c71b04736bb2da1c97992b58b191d8b948bb3badc0193113a21853`               |
| `package.json` SHA-256                  | `6bf59237...3671a`                          | `8b83ab607337fe1955f5a2f4f2dc95e066b9ea3ff8e8bf705192e491b94a85f7`               |
| `web/package.json` SHA-256              | `da4edd75...91007`                          | unchanged                                                                        |
| `npm test`                              | 1444 tests, 1422 pass, 0 fail, 11 cancelled | **1588 tests, 1566 pass, 0 fail**, 11 cancelled, 1 skipped, 10 todo; exit code 1 |
| `npm run format:check`, `npm run build` | passed                                      | passed                                                                           |
| Docker images                           | built                                       | rebuilt; `npm ci --omit=dev` in the images accepted the new lockfile             |

- The 144 new tests are all offline (`server/security/`, `server/extract/zip.test.js`). The 11 cancelled
  tests and the exit code are the same pre-existing `server/llm/llm.test.js` group described in section 11;
  nothing about it changed.
- `jose` declares no Node.js engine range; `@fastify/cors` 11.4.0 depends only on `toad-cache` and
  `fastify-plugin`, and runs on the installed Fastify 5.12.5 (exercised by the test suite).
- To restore this state, use the same commands as section 12; `npm ci` installs both new packages from the
  lockfile. Compare `Get-FileHash package-lock.json` with the hash above instead of section 14's.

## 16. Addendum: public demo backend and frontend, test baseline, lockfile check (2026-11-03)

Supersedes sections 8 (the `VITE_*` and `.env.example` statements), 11 and 12 step 4 (the cancelled tests) for
the items below. Node.js (22.15.0), npm (11.6.4) and Git are unchanged. **Nothing is deployed.**

| Item                   | Value                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`             | **1,978 tests: 1,967 pass, 0 fail, 0 cancelled, 1 skipped, 10 todo; exit code 0** (the skipped and todo tests are the same ones as before)                            |
| `npm run format:check` | passed                                                                                                                                                                |
| `npm run build`        | passed                                                                                                                                                                |
| `git diff --check`     | clean                                                                                                                                                                 |
| New dependencies       | none since section 15 (the async job backend and the public demo frontend add code only). `package.json` and `package-lock.json` hashes are unchanged from section 15 |
| `.env.example`         | now present: root (backend settings) and `web/.env.example` (the four `VITE_` settings below)                                                                         |
| `VITE_*` variables     | four exist, all public by design and none secret: `VITE_PUBLIC_DEMO`, `VITE_API_BASE_URL`, `VITE_TURNSTILE_SITE_KEY`, `VITE_TURNSTILE_ACTION`                         |
| Deployment             | none: no Vercel project, Cloudflare tunnel or Turnstile key; no real model run measured                                                                               |

**The 11 cancelled tests are resolved.** The cause was in the test, not the application: the "reports a timeout as a
timeout" test waited only on an unreferenced `AbortSignal.timeout` timer, so the process drained its event loop and the
runner cancelled the rest of the file. A reference to the timer inside `server/llm/llm.test.js` (test-only; no production
code, assertion or skip changed) fixed it, and all 34 tests in that file now run. Sections 5, 11 and 14 stay as the baseline
they recorded; where they say `npm test` exits 1 with 11 cancelled tests, that was true then and is not true now. **A
cancelled test is now a regression.** The expected result on the recorded versions is the one in the table above.

### Lockfile check: 19 `libc` markers

The working-tree `package-lock.json` has lost all 19 `"libc"` fields that the committed one had, on the native optional
packages `@rollup/rollup-linux-*` and `@napi-rs/canvas-linux-*` / `@napi-rs/lzma-linux-x64-gnu` (Windows npm does not write
them). No version, `resolved` URL or `integrity` value differs, and the only additions are the three packages in section 15.
Checked in a throwaway Linux container (Node.js 22.15.0, npm 10.9.2, Debian bookworm glibc), using copies of the package
files only:

| Lockfile                                             | `npm ci` on Linux                                  | Native packages installed                |
| ---------------------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| Committed (HEAD), without the new dependencies       | 158 packages                                       | glibc variants only                      |
| Working tree, `libc` markers missing                 | 163 packages, succeeds, lockfile left unchanged    | glibc **and musl** variants (5 unneeded) |
| Working tree with only the 19 `libc` fields restored | 161 packages, succeeds, `--omit=dev` also succeeds | glibc variants only                      |

**A lockfile change is not necessary:** installs work, versions are identical, and the Docker images build from it. The
cost of leaving it is a few unused musl binaries on Linux and a lockfile that differs from the committed one in 76 lines of
noise. Restoring the 19 fields (and nothing else) is safe and optional; it is not applied here, because it changes the lockfile
hash recorded in section 15. If it is applied, regenerate nothing: copy the `libc` values from `git show HEAD:package-lock.json`.
