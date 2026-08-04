# Closed test environment smoke test

Run this after [`docs/test-environment-runbook.md`](test-environment-runbook.md)
sections 4–8 are complete. Expected duration: 25–35 minutes.

Prerequisites: a test frontend URL, one admin account, two agent accounts
(Agent A, Agent B), and the two CSV fixtures in `docs/test-environment/`.

**Record for every failure:** step number, browser and version, the exact on-screen
message, the browser console output, the failing network request (method, URL
path, HTTP status, response body with contact values redacted), the affected lead
identifier, and the signed-in account.

Steps marked **[BLOCKED]** cannot pass on the current baseline. They are listed so
the gap is checked and recorded, not skipped silently.

---

## A. Admin

| # | Action | Expected result | Treat as a failure if |
| --- | --- | --- | --- |
| A1 | Open the test URL | Login screen renders. No registration tab or "create account" link is present. | A registration path is offered, or the page errors out. |
| A2 | Sign in as admin | The dashboard opens. Header shows the admin name and role `ADMIN`. | Sign-in fails, or the app opens without a session. |
| A3 | Inspect the navigation | Dashboard, Analytics, Player list, Distribution, Import, Access are all present. | Any admin section is missing. |
| A4 | Open Access | Both agent accounts are listed with role `Agent`. | An account is missing or has the wrong role. |
| A5 | Open Import, choose `synthetic-leads.csv` | Preview reports **Rows found 12, Valid 10, Invalid 1, Possible duplicates 1**, and lists row 13 as an invalid email. | Any of the four counts differs. |
| A6 | Confirm the import | Report shows **Total processed 12, Added 10, Possible duplicates 1, Invalid 1**. | Counts differ, or the import errors. |
| A7 | Import `synthetic-leads-duplicates.csv` | The semicolon file is parsed; the row repeating `+59171000101` is counted as a duplicate and not added. | The duplicate is imported a second time, or the file is rejected as unrecognised. |
| A8 | Open Dashboard | Total players 14, Unassigned 14. | Totals disagree with the import reports. |
| A9 | Open Distribution, tick Agent A and Agent B, click "Distribute among selected" | Toast "Distributed among 2". "Unassigned right now" becomes 0. Leads are split evenly. | Distribution errors, or leads remain unassigned. |
| A10 | Open Player list, expand any lead | Contacts are masked (`🔒*******0101`, `a***@example.com`, `@a***`). The assigned agent is shown. | Any full phone, email, or messenger value is visible to the admin. |
| A11 | Note the identifiers of two leads assigned to Agent A and one assigned to Agent B | — | — |
| A12 | Log out | Login screen returns. | The session persists. |

---

## B. Agent A

| # | Action | Expected result | Treat as a failure if |
| --- | --- | --- | --- |
| B1 | Sign in as Agent A | Dashboard opens, role badge `AGENT`. | Sign-in fails. |
| B2 | Inspect the navigation | **Only** Dashboard and Player list are present. Analytics, Distribution, Import and Access are absent. | Any admin section is reachable. |
| B3 | Open Player list | Exactly Agent A's leads are listed, and no lead belonging to Agent B. | Any Agent B lead appears. |
| B4 | Inspect a new lead | Phone, email and messenger are masked and carry the 🔒 marker. Action offered is "Take in progress". | Any full contact value is shown before `in_work`. |
| B5 | Open the browser devtools Network tab, reload, and inspect the `players_secure` response | The JSON payload contains only `*_display` masked values. No `phone`, `email` or `messenger` key with a full value is present. | A full contact value is present in any response body. |
| B6 | Click "Take in progress" on one lead | Toast "Status updated: In progress". Status becomes `In progress`. Status history records `Assigned → In progress` with the agent name and timestamp. | The transition fails, or no history entry appears. |
| B7 | Observe the same lead immediately after B6 | Contacts are **still masked**. A "Show contacts" action appears; the 🔒 marker is gone. | Contacts are disclosed without an explicit reveal. |
| B8 | Click "Show contacts" | Full phone, email and messenger are displayed. Toast states the access is recorded in the audit log. A countdown shows the reveal expiring in about 5 minutes. | The reveal fails, or no audit notice is shown. |
| B9 | Wait for the countdown to expire, or click "Hide revealed" | Contacts return to masked form. | Full contacts persist after expiry. |
| B10 | Reveal again, then set the lead to `No answer` | Contacts re-mask on the status change. | Contacts remain visible after leaving `in_work`. |
| B11 | Take a second lead in progress; attempt to close it as `Success` **without any attachment** | **[BLOCKED]** Expected behaviour is that closing is refused until a proof file is attached. On the current baseline the lead closes immediately and no proof control exists anywhere in the interface. | Record the actual behaviour. This step is expected to fail — see blocker B1. |
| B12 | Look for any proof or attachment upload control on the lead | **[BLOCKED]** No such control exists on the current baseline. | Record the result. |
| B13 | Add a comment to a lead, then set a next-contact date | Both persist and survive a page reload. | Either value is lost. |
| B14 | Export CSV from the Player list while a reveal is live | The exported file contains only masked contact values. | Any full contact value appears in the export. |
| B15 | Log out | Login screen returns; no revealed contact survives the logout. | Any revealed value persists. |

---

## C. Agent B — isolation

| # | Action | Expected result | Treat as a failure if |
| --- | --- | --- | --- |
| C1 | Sign in as Agent B | Dashboard opens, role badge `AGENT`. | Sign-in fails. |
| C2 | Open Player list | Only Agent B's leads. None of the leads noted in A11 as Agent A's are present, including the one Agent A closed. | Any Agent A lead is visible. |
| C3 | Attempt to reach an Agent A lead by URL | The application is a single page with no per-lead routes, so there is no lead URL to open. Confirm that appending any path or query to the test URL still loads the ordinary application with only Agent B's data. | Another agent's data is rendered. |
| C4 | In the devtools console, request another agent's lead directly through the API | The request returns zero rows or is denied. See the ready-made probe below. | Any Agent A row or contact value is returned. |
| C5 | Attempt to reassign a lead to yourself through the API | Denied. | The update succeeds. |
| C6 | Attempt to promote yourself to admin through the API | Denied. | The update succeeds. |
| C7 | **[BLOCKED]** Attempt to open Agent A's proof file | No proof storage exists on the current baseline; there is nothing to request. Record this. | — |
| C8 | Log out | Login screen returns. | The session persists. |

### Probe for C4–C6

Paste into the devtools console while signed in as Agent B. It uses the page's own
Supabase client configuration and performs read-only checks plus two writes that
must be refused.

```js
(async () => {
  const cfg = window.REACTIVATION_SUPABASE_CONFIG;
  const c = window.supabase.createClient(cfg.projectUrl, cfg.publishableKey,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const si = await c.auth.signInWithPassword({ email: 'AGENT_B_EMAIL', password: 'AGENT_B_PASSWORD' });
  const u = si.data.user, out = {};
  let r = await c.from('players').select('id,phone,email,messenger').limit(5);
  out.rawContacts = r.error ? 'DENIED ' + r.error.code : 'LEAK ' + JSON.stringify(r.data);
  r = await c.from('players_secure').select('id,agent_id,status');
  out.visibleLeads = r.error ? 'ERR' : r.data.length;
  r = await c.from('players').update({ agent_id: u.id }).not('agent_id','is',null).select();
  out.stealLead = r.error ? 'DENIED ' + r.error.code : 'LEAK rows=' + (r.data||[]).length;
  r = await c.rpc('assign_players_atomic', { p_player_ids:['x'], p_agent_ids:[u.id], p_confirm_final:false });
  out.assignAsAgent = r.error ? 'DENIED ' + r.error.message : 'LEAK';
  r = await c.from('profiles').update({ role:'admin' }).eq('id', u.id).select();
  out.selfPromote = r.error ? 'DENIED ' + r.error.code : 'LEAK rows=' + (r.data||[]).length;
  await c.auth.signOut({ scope:'local' });
  return out;
})()
```

Required output — anything else is a **P0** finding, stop the smoke test and report it:

```text
rawContacts   : DENIED 42501
visibleLeads  : only Agent B's own count
stealLead     : DENIED 42501
assignAsAgent : DENIED ADMIN_REQUIRED
selfPromote   : DENIED 42501
```

---

## D. Anonymous

| # | Action | Expected result | Treat as a failure if |
| --- | --- | --- | --- |
| D1 | Open the test URL in a private window | Login screen only. No lead data renders. | Any lead data is visible. |
| D2 | Run the probe below in the console without signing in | Every call is denied. | Any call returns data. |

```js
(async () => {
  const cfg = window.REACTIVATION_SUPABASE_CONFIG;
  const c = window.supabase.createClient(cfg.projectUrl, cfg.publishableKey,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const out = {};
  for (const t of ['players','players_secure','profiles']) {
    const r = await c.from(t).select('id').limit(1);
    out[t] = r.error ? 'DENIED ' + r.error.code : 'LEAK ' + r.data.length;
  }
  const r = await c.rpc('reveal_player_contacts', { p_player_id:'x', p_request_id: crypto.randomUUID() });
  out.reveal = r.error ? 'DENIED' : 'LEAK';
  return out;
})()
```

Required output: `DENIED` for all four. Anything else is **P0**.

---

## E. Inactive account

| # | Action | Expected result | Treat as a failure if |
| --- | --- | --- | --- |
| E1 | As admin, deactivate Agent B (reassign their leads to Agent A when prompted) | Deactivation succeeds and is audited. | Deactivation is silently ignored. |
| E2 | Attempt to sign in as Agent B | Sign-in is refused with "Employee profile is disabled." The application shell never opens. | Agent B reaches the dashboard. |
| E3 | Run the D2 probe while holding an Agent B auth token | Zero rows from `players_secure`; RPCs return `ACTIVE_PROFILE_REQUIRED`. | Any data or successful write is returned. |
| E4 | Reactivate Agent B and reassign the leads back | Both operations succeed. | Either fails. |

---

## F. Admin, after closure

| # | Action | Expected result | Treat as a failure if |
| --- | --- | --- | --- |
| F1 | Sign in as admin, open Player list | The lead Agent A closed shows status `Success` with Agent A as the assigned agent. | Status or agent is wrong. |
| F2 | Expand that lead | Status history shows `Assigned → In progress` and `In progress → Success`, each with the acting user and timestamp. | Any transition is missing from the history. |
| F3 | **[BLOCKED]** Open the proof attached to the closed lead | No proof exists on the current baseline. Record this. | — |
| F4 | Open Analytics | Counts match the imported and processed leads. | Figures contradict the Player list. |
| F5 | Confirm contacts stay masked for the admin | All contact values remain masked. | Any full contact value is shown. |

---

## Exit criteria

The environment passes when every step in A, C, D, E and F meets its expected
result, and B passes except B11 and B12.

B11, B12, C7 and F3 cannot pass until blocker B1 (proof upload) is implemented.
Record their actual behaviour and hand the result to the Product Owner; do not
mark the stage complete on their basis.
