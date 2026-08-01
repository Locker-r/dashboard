# Pages artifact construction

## D2-A scope

D2-A constructs and validates a deterministic static directory. It does not
publish an Actions artifact, create or modify a GitHub Release, deploy to
GitHub Pages, request environment approval, contact Supabase, or change the
meaning of a version tag. Workflow integration and deployment remain later D2
work.

The tracked application remains unchanged. Local development still loads the
two ignored configuration files referenced by tracked `index.html`; only the
artifact copy of `index.html` is transformed. The builder does not change
Auth, storage, data services, contact handling, or any business rule.

## Command and inputs

The builder uses only Node.js built-ins:

```powershell
npm.cmd run build:pages
```

Its default output is `artifacts/pages-site`. An alternative output may be
provided with `--output`, but its parent must already exist as a real,
non-linked directory and its final directory name must be `pages-site`:

```powershell
npm.cmd run build:pages -- --output C:\path\to\pages-site
```

The caller must set these environment variables before running the command:

- `DASHBOARD_SUPABASE_PROJECT_URL`
- `DASHBOARD_SUPABASE_PUBLISHABLE_KEY`

The project URL must be an HTTPS root URL at `<project-ref>.supabase.co`, with
no user information, port, path, query, fragment, whitespace, control
characters, or placeholder. A single trailing slash is accepted and removed.
The key must use the modern `sb_publishable_` class. Missing values,
placeholders, JWTs, secret keys, service-role values, control characters, and
other key classes fail validation. Data mode is not an input; the builder
always generates exact `supabase` mode.

These are browser-public configuration values, but the builder still never
prints them. D2-A tests use synthetic format-valid values and require no real
Supabase project or credential. The builder performs no network request.

Use the same inputs to validate an existing artifact independently:

```powershell
npm.cmd run build:pages -- --validate-only
```

## Exact artifact

The artifact contains exactly 17 regular files:

```text
pages-site/
├── .nojekyll
├── deployment-manifest.json
├── index.html
├── config/
│   └── runtime-config.js
├── src/
│   ├── analytics.js
│   ├── auth.js
│   ├── contact-reveal.js
│   ├── domain.js
│   ├── lead-import.js
│   ├── migration-preflight.js
│   ├── supabase-auth-service.js
│   ├── test-data-cleanup.js
│   └── data/
│       ├── data-service-factory.js
│       ├── data-service.js
│       ├── local-storage-data-service.js
│       └── supabase-data-service.js
└── vendor/
    └── supabase.js
```

File origins are fixed:

- `.nojekyll` is generated as an empty file.
- `config/runtime-config.js` is generated from the two validated inputs and
  fixed `supabase` mode.
- `index.html` is the canonicalized tracked source with exactly the adjacent
  `supabase-config.local.js` and `data-config.local.js` tags replaced by one
  `config/runtime-config.js` tag.
- The 12 approved `src` files and `vendor/supabase.js` are copied from an
  explicit source map after UTF-8/LF canonicalization.
- `deployment-manifest.json` is generated after every other file is final.

`package.json` is read only for the application name and version written to
the manifest; both must be non-empty, control-free strings of at most 128
characters. It is not copied. No directory walk, glob, HTML-derived source
discovery, repository archive, or recursive workspace copy determines the
artifact contents.

## Runtime configuration contract

The generated classic script uses the application's existing browser-IIFE
convention. It creates only:

- frozen `REACTIVATION_SUPABASE_CONFIG`, containing `projectUrl` and
  `publishableKey`;
- frozen `REACTIVATION_DATA_CONFIG`, containing exact mode `supabase`.

Serialization has stable property order, UTF-8/LF bytes, and one final
newline. Values are serialized as data rather than concatenated as JavaScript.
The generated script contains no timestamps, paths, Git data, runner data,
release state, deployment state, or caller-selected mode.

The existing two ignored local configuration files are never opened,
discovered, copied, validated, or used as fallback inputs.

## Determinism and manifest

Every approved text source is decoded as strict UTF-8, a leading UTF-8 BOM is
removed, and CRLF or bare CR line endings are converted to LF. Invalid UTF-8
fails. Generated files use canonical formatting. Identical approved source
content and identical explicit configuration therefore produce identical file
bytes on Windows, Linux, and macOS.

This guarantee covers the directory tree and file bytes. D2-A creates no tar,
zip, or Pages upload package and makes no promise about filesystem timestamps,
ownership, or archive metadata.

`deployment-manifest.json` contains only:

- integer `schemaVersion`;
- `application` and `version` from `package.json`;
- a lexically sorted `files` array.

Each file entry contains only root-relative POSIX `path`, byte `size`, and
lowercase SHA-256. The array describes the other 16 files. The manifest cannot
hash itself; SHA-256 of its canonical bytes is the artifact identity reported
by the CLI.

There is no commit, branch, tag, actor, runner, workflow, timestamp, Release,
environment, approval, deployment, URL, project ref, separate key
fingerprint, archive digest, or health metadata in the manifest.

## Independent validation

Construction success is not trusted. Before promotion, the validator reopens
the staged directory and independently proves:

- the exact 17-file and four-directory sets;
- regular files only, with no symlink, junction, hard link, or special file;
- every approved source ancestor is an ordinary canonical directory, with no
  symlink, junction, or redirected reparse traversal;
- every resolved entry remains inside the artifact root;
- all text is canonical UTF-8/LF;
- copied files exactly match canonicalized approved sources;
- `index.html` differs only by the approved configuration-tag replacement;
- local script references exist in the exact approved order;
- external links remain limited to the two existing Google Fonts URLs;
- URL-bearing attributes are unique, quoted, and limited to the approved
  script and font-link tags, with no redirecting resource tags or CSS URLs;
- every JavaScript file parses as a classic script;
- runtime configuration byte-matches independent canonical regeneration;
- isolated evaluation produces the two exact frozen globals;
- no elevated credential-shaped content is present;
- manifest fields, ordering, sizes, and hashes are exact.

The same validation runs again after promotion. A manifest with recomputed
hashes cannot authorize modified source, HTML, or runtime configuration,
because those bytes are compared independently with their approved inputs.

## Safe replacement

The builder constructs a random sibling `pages-site.tmp-*` directory and
holds an exclusive sibling build lock. It validates staging before touching an
existing output. An existing directory is replaceable only when its exact
tree, canonical generated config, application ownership marker, minimal
manifest, and internal hashes prove that it is a prior builder-owned artifact;
an unowned, structurally invalid, or internally inconsistent directory is
rejected untouched. The builder then transactionally renames the owned output
aside, promotes staging, validates the promoted output, and restores the old
output if promotion or final validation fails. Only builder-owned staging and
backup paths may be recursively removed.

Portable Node.js filesystems cannot replace an existing nonempty directory in
one rename on Windows or POSIX. Consequently, replacement uses two same-parent
renames: consumers can never observe a mixed or partially written tree, but
there can be a brief interval when the final pathname is absent. A future
publisher must consume the directory only after this command succeeds; it is
not implemented by D2-A.

If validation fails, the temporary directory is removed and the previous
output remains byte-for-byte unchanged. A cleanup warning after the validated
new output is committed does not invalidate that output. A stale build lock
is never guessed to be safe or deleted automatically. If filesystem errors
also prevent automatic restoration, or if another process recreates the final
output path after backup, the builder preserves every recovery path that still
exists (foreign output, staging, or prior-output backup) and the build lock.
It reports the exact applicable recovery paths including the lock and performs
no further deletion. The foreign output is never accepted as the build result,
and the prior valid artifact is never silently abandoned in its backup path.

## Exclusion proof and non-goals

Ignored local configuration, `artifacts/` reports, tests, documentation,
scripts, `.env`, `.git`, `.github`, `node_modules`, SQL, migrations, recovery
exports, snapshots, package locks, and arbitrary ignored or untracked files
cannot enter through copying: none is in the fixed source map. Exact-tree
validation rejects any unexpected output even if it is added after
construction. Regression fixtures place canaries in these locations and prove
they remain absent and untouched.

D2-A does not implement workflow permissions, artifact upload, GitHub Release
publication, Pages configuration, environment approval, deployment,
concurrency between workflow runs, production project selection, runtime
health verification, rollback automation, DNS, or a custom domain.
