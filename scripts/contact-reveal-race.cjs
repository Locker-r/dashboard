'use strict';
// Deterministic proof for the concurrent cross-actor request_id race in reveal_player_contacts.
//
// The race cannot be forced through PostgREST, because each RPC call is its own committed transaction and
// the interleaving would depend on network timing. This driver uses two direct psql sessions instead and
// synchronizes them with the partial unique index itself, not with sleeps:
//
//   session A : begin -> reveal(request_id) -> canonical row inserted, NOT yet committed
//   session B : begin -> reveal(same request_id) -> canonical lookup sees nothing (A uncommitted),
//                        proceeds, and its own canonical insert BLOCKS on the unique index
//   session A : commit -> B unblocks, gets unique_violation, handler appends request_id_conflict
//
// B's block is enforced by PostgreSQL, so the ordering is guaranteed regardless of how fast either side is.
// auth.uid() reads request.jwt.claims, so each session can act as a specific actor.
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');

const CONTAINER = process.env.REVEAL_RACE_DB_CONTAINER || 'supabase_db_dashboard-runtime-smoke';
const psql = args => execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' });
const q = sql => psql(['-t', '-A', '-c', sql]).trim();

const failures = [];
const check = (name, ok, detail) => {
  if (ok) { console.log(`  PASS  ${name}`); return true; }
  failures.push(`${name}${detail ? ` :: ${detail}` : ''}`); console.log(`  FAIL  ${name} :: ${detail || ''}`); return false;
};

function session(script) {
  const child = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  child.stdin.write(script); child.stdin.end();
  return new Promise(resolve => child.on('close', code => resolve({ code, out, err })));
}

async function main() {
  const runId = 'race' + crypto.randomBytes(5).toString('hex');
  const playerId = `RACE_${runId}`;
  const requestId = crypto.randomUUID();

  const agentA = q("select id from public.profiles where username = 'SMOKE_TEST_agent_a'");
  const agentB = q("select id from public.profiles where username = 'SMOKE_TEST_agent_b'");
  if (!agentA || !agentB) throw new Error('SMOKE_TEST agent fixtures are required; run the smoke harness first');

  q(`insert into public.players(id, phone, email, messenger, status, agent_id, imported_at)
     values ('${playerId}', '+59170009999', '${runId}@example.invalid', 'RACE:${runId}', 'in_work', '${agentA}', now())`);

  // Quota left by an earlier suite run would throttle these sessions and mask the race being tested.
  // Raise the ceiling for the duration and restore the shipped defaults in the finally block.
  const priorLimits = q('select per_minute || \',\' || per_hour from public.contact_reveal_limits').split(',');
  q('update public.contact_reveal_limits set per_minute = 10000, per_hour = 100000 where id = true');

  try {
    // A opens a transaction, reveals, and holds the canonical row uncommitted while B is launched.
    const a = session(`
begin;
set local request.jwt.claims = '{"sub":"${agentA}"}';
select outcome from public.reveal_player_contacts('${playerId}', '${requestId}');
select pg_sleep(6);
commit;
`);
    await new Promise(r => setTimeout(r, 1500));
    // B blocks inside its canonical insert until A commits. The block is enforced by the unique index.
    const b = await Promise.race([
      session(`
begin;
set local request.jwt.claims = '{"sub":"${agentB}"}';
select outcome from public.reveal_player_contacts('${playerId}', '${requestId}');
commit;
`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('session B never completed')), 60000))
    ]);
    const aResult = await a;

    const aOut = `${aResult.out}\n${aResult.err}`;
    const bOut = `${b.out}\n${b.err}`;
    check('session A revealed', /revealed/.test(aOut), aOut.slice(0, 200));
    check('session B returned request_id_conflict', /request_id_conflict/.test(bOut), bOut.slice(0, 200));
    check('no raw 23505 escaped to either caller', !/23505|duplicate key value/i.test(aOut + bOut), (aOut + bOut).slice(0, 200));
    check('session B exited cleanly', b.code === 0, `exit ${b.code}`);

    const canonical = q(`select count(*) from public.contact_reveal_events where request_id='${requestId}' and event_type in ('reveal_succeeded','reveal_denied')`);
    const conflicts = q(`select count(*) from public.contact_reveal_events where request_id='${requestId}' and event_type='request_id_conflict'`);
    const total = q(`select count(*) from public.contact_reveal_events where request_id='${requestId}'`);
    check('exactly one canonical row', canonical === '1', `got ${canonical}`);
    check('exactly one request_id_conflict event', conflicts === '1', `got ${conflicts}`);
    check('both attempts audited', total === '2', `got ${total}`);

    const actors = q(`select count(distinct actor_id) from public.contact_reveal_events where request_id='${requestId}'`);
    check('both actors attributed', actors === '2', `got ${actors}`);
  } finally {
    q(`update public.contact_reveal_limits set per_minute = ${Number(priorLimits[0])}, per_hour = ${Number(priorLimits[1])} where id = true`);
    q(`delete from public.players where id = '${playerId}'`);
  }

  if (failures.length) { console.error(`\nRace verification FAILED (${failures.length}):\n- ${failures.join('\n- ')}`); process.exitCode = 1; }
  else console.log('\nDeterministic cross-actor request_id race verification passed.');
}

if (require.main === module) main().catch(e => { console.error(`Race verification failed: ${e.message}`); process.exitCode = 1; });
