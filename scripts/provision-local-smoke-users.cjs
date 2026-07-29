'use strict';

const { createClient } = require('@supabase/supabase-js');
const { normalizeUrl, isLoopback } = require('./runtime-smoke.cjs');

async function main() {
  const projectUrl = normalizeUrl(process.env.SMOKE_TEST_PROJECT_URL);
  if (!isLoopback(projectUrl)) throw new Error('LOCAL_PROVISIONING_REQUIRES_LOOPBACK_URL');
  const serviceKey = String(process.env.SMOKE_TEST_LOCAL_SERVICE_KEY || '');
  if (!serviceKey) throw new Error('MISSING_SMOKE_TEST_LOCAL_SERVICE_KEY');
  const fixtures = [
    { email: process.env.SMOKE_TEST_ADMIN_EMAIL, password: process.env.SMOKE_TEST_ADMIN_PASSWORD, role: 'admin', username: 'SMOKE_TEST_admin' },
    { email: process.env.SMOKE_TEST_AGENT_A_EMAIL, password: process.env.SMOKE_TEST_AGENT_A_PASSWORD, role: 'agent', username: 'SMOKE_TEST_agent_a' },
    { email: process.env.SMOKE_TEST_AGENT_B_EMAIL, password: process.env.SMOKE_TEST_AGENT_B_PASSWORD, role: 'agent', username: 'SMOKE_TEST_agent_b' }
  ];
  for (const fixture of fixtures) {
    if (!String(fixture.email || '').toLowerCase().startsWith('smoke_test') || !fixture.password) throw new Error('INVALID_LOCAL_SMOKE_FIXTURE');
  }
  const client = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const listed = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listed.error) throw listed.error;
  for (const fixture of fixtures) {
    let user = listed.data.users.find(item => String(item.email).toLowerCase() === String(fixture.email).toLowerCase());
    if (!user) {
      const created = await client.auth.admin.createUser({ email: fixture.email, password: fixture.password, email_confirm: true });
      if (created.error) throw created.error;
      user = created.data.user;
    } else {
      const updated = await client.auth.admin.updateUserById(user.id, { password: fixture.password, email_confirm: true });
      if (updated.error) throw updated.error;
    }
    const profile = await client.rpc('provision_local_smoke_test_profile', {
      p_id: user.id, p_username: fixture.username, p_role: fixture.role
    });
    if (profile.error) throw profile.error;
  }
  console.log('Local SMOKE_TEST account fixtures are ready (3 accounts).');
}

if (require.main === module) main().catch(error => {
  console.error(`Local smoke provisioning failed: ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
