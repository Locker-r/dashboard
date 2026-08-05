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

The artifact contains exactly 19 regular files:

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
│   ├── lead-proof.js
│   ├── migration-preflight.js
│   ├── supabase-auth-service.js
│   ├── team-admin.js
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
holds an exclusive sibling build lock whose token and filesystem identity are
checked again before cleanup. It validates staging before touching an existing
output. An existing directory is replaceable only when its exact tree,
canonical generated config, application ownership marker, minimal manifest,
and internal hashes prove that it is a prior builder-owned artifact. Ownership
is revalidated immediately before the directory is moved to a random sibling
`pages-site.backup-*` path. An unowned, structurally invalid, or internally
inconsistent directory is rejected untouched.

Node.js exposes no portable atomic operation that renames a nonempty directory
only when the destination does not exist. In particular, a POSIX directory
rename can replace an existing empty directory. The builder therefore never
renames staging onto the final pathname. After the prior output is backed up,
it claims `pages-site` with one non-recursive `mkdir`: creation succeeds only
when no filesystem entry already has that name. It then materializes the
already validated staging tree using non-recursive directory creation and
exclusive `wx` file creation. It performs no overwrite or recursive copy into
the final path and retains staging until the new tree has passed promoted and
final pre-cleanup validation.

Immediately before recursive cleanup, the builder rechecks the output,
staging, backup, and lock identities; revalidates the exact output and staging
artifacts; and revalidates ownership of the prior-output backup. Only paths
that retain both their transaction identity and exact expected contents are
eligible for removal. A known cleanup I/O failure after commit is reported as
an explicit warning. If cleanup also fails while another error is pending, the
original error remains primary, the cleanup failure is attached as diagnostic
information, and staging plus the lock are retained.

Any controlled failure after backup or final-path claim is fail closed. The
builder does not attempt automatic rollback, because restoring a directory by
ordinary rename has the same no-replace race. It does not move, remove, or
accept an entry recreated at `pages-site`. Instead it retains every recovery
path that still exists, including the foreign output, staging, prior-output
backup, and build lock, and reports their exact applicable paths for operator
inspection. The prior valid artifact may therefore be absent from the final
pathname during a failed transaction, but it is never silently abandoned: its
reported backup remains intact.

The final directory can be absent briefly and can contain a partial candidate
until the command succeeds. A future publisher must consume it only after a
successful command; publication is not implemented by D2-A.

These guarantees use the sibling build lock as a cooperative trust boundary
and require the output parent to be writable only by trusted processes that
honor that lock. Portable path-based Node.js APIs do not provide `renameat2`
no-replace/exchange flags, directory-handle-relative creation, or
identity-conditional recursive deletion. A same-privilege process that ignores
the lock can still mutate a pathname in the final instant between an identity
check and a rename, create, write, or removal operation. The builder detects
deterministic substitutions at every exposed transaction phase and fails
closed, but it does not claim absolute protection against arbitrary hostile
namespace mutation outside the cooperative lock protocol.

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
