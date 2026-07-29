# Supabase atomic writes

`supabase/atomic-writes.sql` adds five transaction-scoped RPCs for player creation, assignment, status transitions with audit history, comments, and follow-up changes. Broad browser writes remain unavailable: the data service calls only these RPCs, and table `insert`, `update`, and `delete` privileges remain revoked.

Each RPC requires an authenticated active profile. Import and assignment require an administrator; other player mutations require either an administrator or the assigned active agent. Final-status reopen/reassignment needs an explicit confirmation flag. Functions use `security definer` with a fixed `search_path` and are executable by `authenticated`, never `anon`.

## Validate locally

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-atomic-writes.ps1
npm test
```

These checks do not connect to Supabase. `atomic-writes.sql` must not be applied automatically.

## Manual deployment

1. Back up the target project and review `supabase/atomic-writes.sql`.
2. Copy it with `scripts/copy-atomic-writes.ps1`, then apply it once in Supabase SQL Editor.
3. Run `supabase/verify-atomic-writes.sql`; all five rows must report `ok = true`.
4. Enable `supabase` mode only after verification. Keep the publishable key in the ignored local config and never place a service-role key in the browser.
