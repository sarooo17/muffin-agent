import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {reserveOnce,validateMuffinLiveConfig} from './ei-openai-live.mjs';

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
