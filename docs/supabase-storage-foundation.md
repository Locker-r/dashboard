# Supabase storage foundation

The repository now contains a read-only Supabase data adapter and a declarative schema. Local storage remains the default and no remote schema is applied automatically.

## Current scope

- `SupabaseDataService` reads profiles, players, comments, and status history and maps snake_case rows to the existing Dashboard model.
- Direct browser writes deliberately throw `READ_ONLY`.
- The data-service factory selects Supabase only when mode is exactly `supabase`; absent or invalid configuration selects local mode.
- RLS exposes a user's own profile, all data to active admins, and assigned players plus their activity to agents.
- Authenticated browser roles receive `SELECT` only. `anon` receives no table or helper-function access.

## Applying the schema manually

Review `supabase/schema.sql`, open the target project's SQL Editor, paste the reviewed SQL, and run it once in a controlled environment. This repository does not run it remotely. Do not place project URLs, browser keys, service-role keys, or JWTs in the SQL file or Git.

After applying, verify table columns and foreign keys, enum values, indexes, RLS enablement, grants, and policies. Test as an admin, an assigned agent, an unassigned agent, and anon. Confirm that SELECT follows the documented scope and that browser INSERT, UPDATE, and DELETE fail.

To opt into read-only data loading, copy `config/data-config.example.js` to the ignored `config/data-config.local.js` and change its mode to `supabase`. Without that file, or for every other value, the Dashboard continues to use local storage. Do not enable Supabase mode for workflows that need to save changes.

## Why writes come later

Player assignment, status changes, comments, and audit history span multiple rows. Enabling independent client writes would allow partial state and incomplete audit records. A later stage must expose narrowly scoped, admin/owner-checked RPC functions that perform each business operation atomically in one transaction. Service-role credentials must never be used in the browser.
