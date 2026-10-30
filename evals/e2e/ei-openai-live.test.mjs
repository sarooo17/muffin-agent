import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {reserveOnce,validateMuffinLiveConfig,runMuffinOpenAILab} from './ei-openai-live.mjs';

function controlled(dir){
  return {
    OPENAI_API_KEY:'fake-test-credential-do-not-use',
    EI_CONFIRM_MUFFIN_OPENAI_LIVE:'YES',
    EI_MUFFIN_RUN_VOLUME_CONFIRMED:'YES',
    EI_MUFFIN_RUN_ID:'offline-case-123',
    EI_MUFFIN_RUN_STATE_DIR:dir,
  };
}
test('live model runner denies unapproved API/key/volume and unsafe intent IDs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ei-muffin-live-'));
  try{
    const c=controlled(dir);
    assert.deepEqual(validateMuffinLiveConfig(c),{runId:c.EI_MUFFIN_RUN_ID,dir});
    for(const name of ['OPENAI_API_KEY','EI_CONFIRM_MUFFIN_OPENAI_LIVE',
      'EI_MUFFIN_RUN_VOLUME_CONFIRMED','EI_MUFFIN_RUN_ID',
      'EI_MUFFIN_RUN_STATE_DIR']){
      const broken={...c};
      delete broken[name];
      assert.throws(()=>validateMuffinLiveConfig(broken),/^Error: EI_MUFFIN_/);
    }
    assert.throws(()=>validateMuffinLiveConfig({...c,EI_MUFFIN_RUN_ID:'../escape'}),
      /EI_MUFFIN_RUN_ID_INVALID/);
    assert.throws(()=>validateMuffinLiveConfig({
      ...c,EI_MUFFIN_RUN_STATE_DIR:'/tmp/ei-no-such-volume',
    }),/EI_MUFFIN_PERSISTENT_DIR_REQUIRED/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('one-shot reservation is fsynced, private and cannot be spent twice after interrupted model call',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ei-muffin-ledger-'));
  try{
    const c=validateMuffinLiveConfig(controlled(dir));
    reserveOnce(c);
    const receipt=join(dir,'intent-'+c.runId+'.reserved.json');
    assert(existsSync(receipt));
    const row=JSON.parse(readFileSync(receipt,'utf8'));
    assert.equal(row.maxProviderRequests,2);
    assert.equal(row.providerBillingCertified,false);
    assert(!JSON.stringify(row).includes('fake-test-credential'));
    assert.throws(()=>reserveOnce(c),e=>e?.code==='EEXIST');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('CLI without explicit opt-in cannot invoke a provider or print credentials',()=>{
  const run=spawnSync(process.execPath,
    [new URL('./ei-openai-live.mjs',import.meta.url).pathname],{
      encoding:'utf8',timeout:6000,
      env:{EI_CONFIRM_MUFFIN_OPENAI_LIVE:'NO',
        OPENAI_API_KEY:'TOP_SECRET_MUST_NEVER_LOG',
        EI_MUFFIN_RUN_ID:'offline-case-123',
        EI_MUFFIN_RUN_STATE_DIR:'/no/run/dir'},
    });
  assert.equal(run.status,2);
  assert.equal(run.stdout,'');
  assert(!run.stderr.includes('TOP_SECRET_MUST_NEVER_LOG'));
  assert.equal(JSON.parse(run.stderr).code,'EI_MUFFIN_LIVE_DISABLED');
});

test('real compiled Muffin native EI tool + synthetic MCP poll + durable host receipt with NO paid provider call',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ei-muffin-host-'));
  let calls=0;
  class OfflineOpenAI{
    constructor(options){
      assert.equal(options.maxRetries,0);
      assert.equal(options.timeout,15000);
    }
    chat={completions:{create:async request=>{
      calls++;
      assert.equal(request.model,'gpt-4o-mini');
      assert.equal(request.store,false);
      assert.equal(request.parallel_tool_calls,false);
      if(calls===1){
        assert.equal(request.max_completion_tokens,96);
        assert.equal(request.tool_choice.function.name,'event_watch_create');
        assert.equal(request.parallel_tool_calls,false);
        return {choices:[{message:{tool_calls:[{
          type:'function',
          function:{name:'event_watch_create',
            arguments:JSON.stringify({trigger_id:'ei-openai-lab',
              instruction:'Acknowledge demo.ready'})},
        }]}}],usage:{prompt_tokens:22,completion_tokens:14,total_tokens:36}};
      }
      if(calls===2){
        assert.equal(request.max_completion_tokens,64);
        assert.equal(request.tools,undefined);
        assert.equal(request.parallel_tool_calls,undefined);
        return {choices:[{message:{content:'Synthetic wake queued.'}}],
          usage:{prompt_tokens:30,completion_tokens:4,total_tokens:34}};
      }
      throw new Error('offline model request cap violated');
    }}};
  }
  try{
    const outcome=await runMuffinOpenAILab(controlled(dir),{OpenAIClient:OfflineOpenAI});
    assert.equal(calls,2);
    assert.equal(outcome.modelRequests,2);
    assert.equal(outcome.liveOpenAIProvider,false);
    assert.equal(outcome.simulatedProvider,true);
    assert.equal(outcome.realMuffinAdapter,true);
    assert.equal(outcome.hostReceiptsPersisted,1);
    assert.equal(outcome.systemWakeTaintVerified,true);
    assert.equal(outcome.firstUsage.totalTokens,36);
    assert.equal(outcome.secondUsage.totalTokens,34);
    assert.equal(outcome.independentMcpProvider,false);
    assert.equal(outcome.providerInvoiceCertified,false);
    assert(existsSync(join(dir,'wake-'+controlled(dir).EI_MUFFIN_RUN_ID+'.json')));
    await assert.rejects(()=>runMuffinOpenAILab(controlled(dir),{OpenAIClient:OfflineOpenAI}),
      e=>e?.code==='EEXIST');
    assert.equal(calls,2,'durable preflight must prevent a third provider call on restart');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
