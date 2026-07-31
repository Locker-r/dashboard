# Team management server foundation

## Architecture plan

The backend uses one `team-management` Supabase Edge Function with an explicit `action` router. Centralizing the boundary avoids duplicated JWT verification, administrator authorization, CORS handling, request limits, and error mapping. The browser sends only its normal user access token; the service-role credential exists only as an Edge Function secret.

The function verifies the bearer token with Supabase Auth, loads the caller's profile by the verified user ID, and requires an active `admin`. It never accepts an actor ID or actor role from the request. Reads and Auth Admin API calls happen only after that check. Mutations call service-role-only database RPCs. Those RPCs re-check the actor profile and perform locks, validation, mutation, and audit insertion in one transaction.

No Team-page UI is part of this change. Production and remote Supabase are not modified by repository checks.

## API

`POST /functions/v1/team-management` accepts JSON with an `action` and action-specific fields. The access token is supplied as `Authorization: Bearer <user JWT>`. Mutations require a client-generated UUID `requestId`; the audit table makes retries idempotent.

| Action | Input | Result |
| --- | --- | --- |
| `list-members` | none | Safe member records and assigned-player counts |
| `invite-member` | `email`, `username`, `name`, `role`, `requestId` | Invited member record |
| `update-member-role` | `memberId`, `role`, `requestId` | Updated member record |
| `set-member-active` | `memberId`, `isActive`, optional `reassignTo`, `requestId` | Updated member and reassignment count |
| `reassign-players` | `fromAgentId`, `toAgentId`, optional `playerIds`, `requestId` | Reassignment count |

`resend-invitation` is intentionally not exposed. Supabase Auth does not provide an Admin API operation that safely proves an existing pending invitation and resends it without ambiguous account creation/link semantics. It can be added after a dedicated invitation-state model is approved.

Success responses are `{ "ok": true, "data": ... }`. Errors are `{ "ok": false, "error": { "code": "...", "message": "..." } }`; tokens, keys, passwords, provider payloads, and stack traces are never returned.

## Database and invariants

The migration adds `admin_audit_events`, immutable to browser roles, and narrowly scoped RPCs. Audit payloads contain IDs and state changes, not tokens or credentials. A unique `(request_id, action)` constraint makes retries safe.

Role and active-state RPCs acquire a transaction advisory lock before counting active administrators. Consequently, two concurrent attempts cannot demote/deactivate the last active admin. Agents cannot call the Edge Function, callers cannot promote themselves, inactive agents cannot receive players, and an agent with assigned players cannot be deactivated unless the same transaction safely reassigns those players. Users and work history are never deleted.

Profiles remain visible directly only to self or admin under the existing RLS policy. The Edge Function additionally denies `list-members` to agents. Administrative RPCs are executable only by `service_role`, not `anon` or `authenticated`.

## Secrets and local operation

Required Edge Function environment variables are `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `TEAM_ALLOWED_ORIGIN`. `TEAM_ALLOWED_ORIGIN` is the exact staging Dashboard origin, including scheme and optional non-default port, with no path and no wildcard. Keep credentials in local Supabase secrets or staging secrets only. Never place them in client configuration, tracked `.env` files, command output, screenshots, or logs.

Local checks:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-team-management.ps1
```

Full local Auth, Edge Function, RPC, RLS, audit, role, deactivation, and reassignment smoke test (requires Docker and the same three password environment variables as the base runtime harness):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Invoke-LocalTeamManagementSmokeTest.ps1
```

The structural check needs no credentials and contacts no remote service. For a local runtime run, start/reset the local Supabase stack and invoke the dedicated runtime command documented by the script. Local fixture provisioning may use the local loopback service-role key; the command rejects non-loopback URLs.

## Staging deployment

After reviewing the migration, apply it only to a dedicated staging project, set the function secrets in that project, and deploy `team-management` with JWT verification enabled. Configure the non-secret origin separately with an exact value:

```powershell
$env:TEAM_ALLOWED_ORIGIN = 'https://staging-dashboard.example.com'
npx.cmd supabase secrets set "TEAM_ALLOWED_ORIGIN=$env:TEAM_ALLOWED_ORIGIN" --project-ref <staging-project-ref>
```

Do not use `*`, a production origin, or a URL prefix. Production deployment requires a separate approval, backup, migration review, staging runtime results, and a rollback plan.

## Threats and controls

- Forged actor/role: identity comes only from a verified JWT and database profile.
- Leaked elevated credential: service-role is read only inside the function and never serialized or logged.
- Agent enumeration: both the Edge Function and direct RLS deny the team list.
- Last-admin race: serialized database transaction and row locks.
- Orphaned assignments: deactivation requires atomic reassignment.
- Retry duplication: UUID request IDs and unique audit keys.
- Broad reassignment: validated source/target agents and optional explicit player IDs under row locks.
- Destructive account handling: no delete-user endpoint or cascade is provided.

## Manual work still required

Before staging runtime testing, an operator must apply the migration to a dedicated staging project, configure function secrets without printing them, deploy the function, and create isolated `SMOKE_TEST` admin/agent accounts. None of those remote actions are performed by this repository change.
