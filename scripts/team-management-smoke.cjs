'use strict';
const { createClient } = require('@supabase/supabase-js');
const { SupabaseDataService } = require('../src/data/supabase-data-service.js');
const { normalizeUrl, isLoopback, buildPlan } = require('./runtime-smoke.cjs');
const randomId = () => require('node:crypto').randomUUID();
async function signIn(url,key,email,password){ const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}); const result=await client.auth.signInWithPassword({email,password}); if(result.error||!result.data.session) throw result.error||new Error('SIGN_IN_FAILED'); return {client,user:result.data.user,token:result.data.session.access_token}; }
async function call(url,token,body,expectedCode){ const result=await fetch(`${url}/functions/v1/team-management`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}); const payload=await result.json(); if(expectedCode){if(result.ok||payload?.error?.code!==expectedCode)throw new Error(`EXPECTED_${expectedCode}`);return payload;} if(!result.ok||!payload.ok)throw new Error(payload?.error?.code||'TEAM_API_FAILED');return payload.data; }
async function waitForFunction(url,token){let last='UNKNOWN';for(let attempt=0;attempt<30;attempt+=1){try{await call(url,token,{action:'list-members'});return;}catch(error){last=String(error?.message||'UNKNOWN').replace(/[^A-Z0-9_]/gi,'_').slice(0,80);await new Promise(resolve=>setTimeout(resolve,1000));}}throw new Error(`LOCAL_EDGE_FUNCTION_NOT_READY_${last}`);}
async function main(){
  const url=normalizeUrl(process.env.SMOKE_TEST_PROJECT_URL); const key=process.env.SMOKE_TEST_PUBLISHABLE_KEY; const runId=process.argv[2]; const plan=buildPlan(runId);
  if(!isLoopback(url)||!key)throw new Error('LOCAL_TEAM_SMOKE_CONFIG_REQUIRED');
  const accounts=['ADMIN','AGENT_A','AGENT_B'].map(name=>({email:process.env[`SMOKE_TEST_${name}_EMAIL`],password:process.env[`SMOKE_TEST_${name}_PASSWORD`]}));
  const sessions=[]; let admin; let agentA; let agentB; let stage='sign_in'; let failure=null;
  try{
    admin=await signIn(url,key,accounts[0].email,accounts[0].password);sessions.push(admin.client);agentA=await signIn(url,key,accounts[1].email,accounts[1].password);sessions.push(agentA.client);agentB=await signIn(url,key,accounts[2].email,accounts[2].password);sessions.push(agentB.client);
    await waitForFunction(url,admin.token);
    stage='admin_list';const members=await call(url,admin.token,{action:'list-members'});if(!Array.isArray(members)||![admin.user.id,agentA.user.id,agentB.user.id].every(memberId=>members.some(m=>m.id===memberId)))throw new Error('MEMBER_LIST_FAILED');
    stage='agent_denied';await call(url,agentA.token,{action:'list-members'},'ADMIN_REQUIRED');
    stage='last_admin';await call(url,admin.token,{action:'update-member-role',memberId:admin.user.id,role:'agent',requestId:randomId()},'LAST_ACTIVE_ADMIN');
    stage='role_change';const promote=randomId();await call(url,admin.token,{action:'update-member-role',memberId:agentB.user.id,role:'admin',requestId:promote});await call(url,admin.token,{action:'update-member-role',memberId:agentB.user.id,role:'admin',requestId:promote});await call(url,admin.token,{action:'update-member-role',memberId:agentB.user.id,role:'agent',requestId:randomId()});
    stage='create_assigned_player';const data=new SupabaseDataService(admin.client);await data.createPlayers([{id:plan.assignedPlayerId,email:`smoke_test_${runId}_team@example.invalid`,messenger:`${plan.markerPrefix}:team`}]);await data.assignPlayers([plan.assignedPlayerId],[agentA.user.id]);
    stage='require_reassignment';await call(url,admin.token,{action:'set-member-active',memberId:agentA.user.id,isActive:false,requestId:randomId()},'REASSIGNMENT_REQUIRED');
    stage='deactivate_and_reassign';await call(url,admin.token,{action:'set-member-active',memberId:agentA.user.id,isActive:false,reassignTo:agentB.user.id,requestId:randomId()});
    stage='inactive_destination';await call(url,admin.token,{action:'reassign-players',fromAgentId:agentB.user.id,toAgentId:agentA.user.id,requestId:randomId()},'INVALID_REASSIGNMENT_AGENT');
    stage='reactivate';await call(url,admin.token,{action:'set-member-active',memberId:agentA.user.id,isActive:true,requestId:randomId()});
    stage='reassign_back';await call(url,admin.token,{action:'reassign-players',fromAgentId:agentB.user.id,toAgentId:agentA.user.id,playerIds:[plan.assignedPlayerId],requestId:randomId()});
    stage='audit';const audit=await admin.client.from('admin_audit_events').select('request_id,action').in('target_user_id',[agentA.user.id,agentB.user.id]);if(audit.error||new Set(audit.data.map(row=>`${row.request_id}:${row.action}`)).size!==audit.data.length||audit.data.length<5)throw new Error('AUDIT_ASSERTION_FAILED');
    console.log(`Team management smoke test passed: run_id=${runId}`);
  }catch(error){failure=new Error(`stage=${stage} run_id=${runId} error=${String(error?.message||error)}`);}
  finally{if(admin){try{await admin.client.rpc('cleanup_smoke_test_run_atomic',{p_run_id:runId,p_confirmation:plan.cleanupConfirmation});if(agentA)await call(url,admin.token,{action:'set-member-active',memberId:agentA.user.id,isActive:true,requestId:randomId()});if(agentB)await call(url,admin.token,{action:'update-member-role',memberId:agentB.user.id,role:'agent',requestId:randomId()});}catch(error){if(!failure)failure=new Error(`stage=cleanup run_id=${runId} error=${String(error?.message||error)}`);}}await Promise.allSettled(sessions.map(client=>client.auth.signOut({scope:'local'})));}
  if(failure)throw failure;
}
if(require.main===module)main().catch(error=>{console.error(`Team management smoke test failed: ${String(error?.message||error)}`);process.exitCode=1;});
