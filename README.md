# Reactivation Desk Dashboard

Use one canonical development address:

```text
http://localhost:3000
```

`http://127.0.0.1:3000`, any other port, and a published domain are different origins and therefore have separate `localStorage` data. Starting and stopping the HTTP server at the canonical address does not clear browser users.

## Supabase Auth configuration

The dashboard is a static application, so it reads Supabase settings from a local runtime configuration file rather than `.env`.

1. Copy `config/supabase-config.example.js` to `config/supabase-config.local.js`.
2. Set `projectUrl` to the Supabase Project URL.
3. Set `publishableKey` to the Supabase Publishable key. Never use a secret or `service_role` key.
4. Run `npm install` and `npm run build:vendor` after cloning or updating dependencies.

`config/supabase-config.local.js` and `node_modules` are ignored by Git. The generated `vendor/supabase.js` bundle is served locally, so the dashboard does not depend on a CDN.

## Pages artifact construction

`npm run build:pages` constructs and validates a deterministic, fixed-allowlist
static directory at `artifacts/pages-site`. It takes explicit browser-public
Supabase configuration from the current process environment, generates
`config/runtime-config.js`, and transforms only the artifact copy of
`index.html`. The ignored local configuration files are never read or copied.

This command builds a local directory only. It does not publish an artifact,
create a Release, configure GitHub Pages, or deploy anything. Its inputs,
output contract, validation, and safe replacement behavior are documented in
[`docs/pages-artifact.md`](docs/pages-artifact.md).

Supabase storage setup is documented in `docs/supabase-storage-foundation.md`. The optional atomic write RPC migration and its manual verification workflow are documented in `docs/supabase-atomic-writes.md`; repository scripts never apply SQL to a remote project.

The isolated local/staging Auth, RPC, and RLS smoke-test harness is documented in `docs/runtime-smoke-tests.md`. It is intentionally excluded from credential-free CI runtime execution.

Safe local preflight, runtime smoke orchestration, branch review, and dry-run-first PR automation are documented in [`docs/developer-toolchain.md`](docs/developer-toolchain.md).

The branching model, review flow, merge policy, versioning, changelog process, and rollback expectations are documented in [`docs/release-governance.md`](docs/release-governance.md). Read it before your first pull request. The one-time repository settings an administrator must apply are listed in [`docs/github-settings.md`](docs/github-settings.md).
