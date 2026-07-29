# Proposed admin-only migration RPC contract

This document describes a future RPC. It is not implemented or applied in Supabase.

`migrate_local_dashboard_snapshot(payload jsonb)` accepts `players`, `comments`, and `statusHistory` arrays using the exact snake_case rows produced by `migration-preflight.js`. Every source string ID remains the destination primary key.

The function must be `SECURITY DEFINER`, owned by a non-login migration owner, have an empty public execute grant, set a fixed `search_path`, and grant execute only to `authenticated`. Its first statement must reject callers for whom `auth.uid()` is null or `public.is_admin()` is false.

Before writing it must validate all enum values, timestamps, contact requirements, comment lengths, player references, and every non-null profile UUID. Historical `author_id` and `user_id` must never be replaced with the caller ID. Missing mappings reject the affected row and therefore the transaction.

The whole payload runs in one transaction. Primary-key collisions are idempotent only when every stored field equals the proposed row; otherwise the RPC reports an ID conflict and rolls back. Contact matches with different player IDs are reported as unresolved business duplicates and also roll back. No `ON CONFLICT DO UPDATE` or silent skipping is allowed.

The function should return counts and machine-readable issue codes only, never contact values, comment text, tokens, keys, or session data. Existing table RLS remains enabled; the narrowly scoped function is the only intended bypass for historical authorship.
