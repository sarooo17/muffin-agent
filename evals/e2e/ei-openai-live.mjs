#!/usr/bin/env node
// One-shot owner-authorized Muffin native EI tools + OpenAI API experiment.
// This is NOT a full Muffin agent-loop or an independent external provider
// guarantee. It must never be used as a production worker.
import {openSync,closeSync,fsyncSync,existsSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';

const MAX_MODEL_CALLS=2;
const MODEL='gpt-4o-mini';
const safeId=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{8,96}$/.test(x);
const error=code=>Object.assign(new Error(code),{code});
export const validateMuffinLiveConfig=env=>{
  if(env.EI_CONFIRM_MUFFIN_OPENAI_LIVE!=='YES' ||
     env.EI_MUFFIN_RUN_VOLUME_CONFIRMED!=='YES')
    throw error('EI_MUFFIN_LIVE_DISABLED');
  if(!env.OPENAI_API_KEY||env.OPENAI_API_KEY.length<12)
    throw error('EI_MUFFIN_OPENAI_CREDENTIAL_MISSING');
  if(!safeId(env.EI_MUFFIN_RUN_ID))
    throw error('EI_MUFFIN_RUN_ID_INVALID');
  if(typeof env.EI_MUFFIN_RUN_STATE_DIR!=='string' ||
     !isAbsolute(env.EI_MUFFIN_RUN_STATE_DIR) ||
     !existsSync(env.EI_MUFFIN_RUN_STATE_DIR) ||
     !lstatSync(env.EI_MUFFIN_RUN_STATE_DIR).isDirectory())
    throw error('EI_MUFFIN_PERSISTENT_DIR_REQUIRED');
  return {runId:env.EI_MUFFIN_RUN_ID,dir:env.EI_MUFFIN_RUN_STATE_DIR};
};

export function reserveOnce({runId,dir}){
  const receipt=join(dir,'intent-'+runId+'.reserved.json');
  // The operator must mount a durable *private* Railway volume on this
  // path. A reservation survives process crash: never auto-retry after
  // any ambiguous remotely billed timeout.
  const fd=openSync(receipt,'wx',0o600);
  try{
    writeFileSync(fd,JSON.stringify({
      contract:'ei.muffin-openai-once.v1',runId,
      reservedAt:new Date().toISOString(),
      maxProviderRequests:MAX_MODEL_CALLS,model:MODEL,
      providerBillingCertified:false,
    })+'\n');
    fsyncSync(fd);
  }finally{closeSync(fd);}
}

function usageOf(response){
  const u=response?.usage;
  if(!u)return null;
  return {inputTokens:Number.isSafeInteger(u.prompt_tokens)?u.prompt_tokens:null,
    outputTokens:Number.isSafeInteger(u.completion_tokens)?u.completion_tokens:null,
    totalTokens:Number.isSafeInteger(u.total_tokens)?u.total_tokens:null};
}

export async function runMuffinOpenAILab(env=process.env,{
  OpenAIClient,
  createHost,
}={}){
  const {runId,dir}=validateMuffinLiveConfig(env);
  // In offline tests only, inject a deterministic no-network fake provider.
  // Production CLI does not accept injection or flags to change this route.
  const [{default:OpenAI},{createMuffinEventIntelligence}]=await Promise.all([
    OpenAIClient?Promise.resolve({default:OpenAIClient}):import('openai'),
    createHost?Promise.resolve({createMuffinEventIntelligence:createHost}):
      import('../../dist/agent/event-intelligence.js'),
  ]);
  reserveOnce({runId,dir});
  const home=join(dir,'muffin-'+runId);
  mkdirSync(home,{mode:0o700});
  const queued=[],receipts=new Set();
  const turnId='muffin-openai-host-turn';
  const source={id:turnId,tenant:'host',surface:'cli',
    sessionId:'muffin-openai-lab',replyTo:null,
    principal:{kind:'owner',connector:'cli',externalId:'railway-validation'}};
  const wakePort={
    source:id=>id===turnId?source:null,
    has:id=>receipts.has(id),
    openSession:id=>({id,file:join(home,'session.jsonl')}),
    enqueue(input,wake){
      const id=input?.id;
      if(typeof id!=='string'||!id||!wake?.wakeId)
        throw error('EI_MUFFIN_HOST_RECEIPT_INVALID');
      // Actual host-owned receipt is fsynced before delivery confirmation.
      // Single-process reference only, not a multiworker atomic outbox.
      const file=join(dir,'wake-'+runId+'.json');
      const fd=openSync(file,'wx',0o600);
      try{
        writeFileSync(fd,JSON.stringify({runtimeReceiptId:id,
          triggerId:wake.triggerId,wakeId:wake.wakeId,
          tenant:input.tenant,kind:'muffin-host-wake'})+'\n');
        fsyncSync(fd);
      }finally{closeSync(fd);}
      receipts.add(id);queued.push({id,taint:input.contentTaint,
        principalKind:input.principal?.kind});
      return id;
    },
  };
  let polled=false;
  const connection={
    connectionId:'muffin-openai-lab',serverId:'muffin-openai-lab',
    getCapabilities:()=>({extensions:{'io.modelcontextprotocol/events':{}}}),
    request:async method=>{
      if(method==='events/list')return {events:[{
        name:'demo.ready',description:'Synthetic ticket is ready',
        delivery:['poll'],inputSchema:{type:'object'},
        payloadSchema:{type:'object',
          properties:{value:{type:'number'}}},
      }],nextCursor:null};
      if(method==='events/poll'){
        if(polled)return {events:[],cursor:'done',
          hasMore:false,nextPollMs:60000};
        polled=true;
        return {events:[{eventId:'synthetic-once',name:'demo.ready',
          timestamp:new Date().toISOString(),data:{value:42}}],
          cursor:'done',hasMore:false,nextPollMs:60000};
      }
      throw error('EI_MUFFIN_UNEXPECTED_MCP_CALL');
    },
    pollIntervalMs:60000,
  };
  const host=await createMuffinEventIntelligence([connection],home,wakePort);
  const client=new OpenAI({apiKey:env.OPENAI_API_KEY,maxRetries:0,
    timeout:15000});
  let modelRequests=0;
  const tracked=async input=>{
    if(++modelRequests>MAX_MODEL_CALLS)
      throw error('EI_MUFFIN_MODEL_BUDGET_EXCEEDED');
    return client.chat.completions.create({
      model:MODEL,store:false,parallel_tool_calls:false,
      ...input,
    });
  };
  try{
    const create=host.toolCatalog.get('event_watch_create');
    if(!create)throw error('EI_MUFFIN_NATIVE_TOOL_MISSING');
    const first=await tracked({
      messages:[
        {role:'system',content:'Choose the specified synthetic event-watch tool. This is an isolated validation scenario.'},
        {role:'user',content:'Arm the demo event watch using the provided function.'},
      ],
      max_completion_tokens:96,
      tools:[{type:'function',function:{
        name:'event_watch_create',description:'Arm a synthetic event watch',
        parameters:{type:'object',additionalProperties:false,
          properties:{
            trigger_id:{type:'string',enum:['ei-openai-lab']},
            instruction:{type:'string',enum:['Acknowledge demo.ready']},
          },required:['trigger_id','instruction']},
      }}],
      tool_choice:{type:'function',function:{name:'event_watch_create'}},
    });
    const call=first.choices?.[0]?.message?.tool_calls;
    if(!Array.isArray(call)||call.length!==1 ||
       call[0].type!=='function' ||
       call[0].function?.name!=='event_watch_create')
      throw error('EI_MUFFIN_PROVIDER_TOOL_CALL_MISSING');
    let args;
    try{args=JSON.parse(call[0].function.arguments);}catch{
      throw error('EI_MUFFIN_PROVIDER_TOOL_ARGS_INVALID');}
    if(args?.trigger_id!=='ei-openai-lab' ||
       args?.instruction!=='Acknowledge demo.ready' ||
       Object.keys(args).length!==2)
      throw error('EI_MUFFIN_PROVIDER_TOOL_ARGS_DENIED');
    const runtimeContext={tenant:'host',principal:source.principal,
      turnId,sessionId:source.sessionId,
      taint:()=>0,intrinsicTaint:()=>0,
      suspend:()=>{throw error('EI_MUFFIN_UNEXPECTED_SUSPEND');}};
    const armed=await create.execute({
      trigger_id:args.trigger_id,
      events:[{event:'demo.ready',where:[{path:'value',op:'gt',value:10}]}],
      instruction:args.instruction,one_shot:true,
    },runtimeContext);
    if(armed?.ok!==true)
      throw error('EI_MUFFIN_WATCH_CREATE_REJECTED');
    await host.host.runtime.mcpEventsClient.pollAll();
    if(queued.length!==1 || queued[0]?.principalKind!=='system' ||
       queued[0]?.taint!==3 || receipts.size!==1)
      throw error('EI_MUFFIN_WAKE_RECEIPT_MISMATCH');
    const second=await tracked({
      messages:[
        {role:'system',content:'Respond with one short sentence about a synthetic event, no tools.'},
        {role:'user',content:'A test event demo.ready with value 42 matched; confirm that the wake was queued.'},
      ],
      max_completion_tokens:64,
    });
    if(!second.choices?.[0]?.message?.content?.trim())
      throw error('EI_MUFFIN_MODEL_CONTINUATION_MISSING');
    // No message content, tool arguments, API credentials or raw response IDs.
    const result={contract:'ei.muffin-openai-host-e2e.v1',
      runId,syntheticMcpSource:true,realMuffinAdapter:true,
      liveOpenAIProvider:!OpenAIClient,simulatedProvider:Boolean(OpenAIClient),
      model:MODEL,modelRequests,
      toolCallsAuthorized:1,hostReceiptsPersisted:receipts.size,
      systemWakeTaintVerified:true,
      firstUsage:usageOf(first),secondUsage:usageOf(second),
      perRequestCostVerified:false,providerInvoiceCertified:false,
      independentMcpProvider:false,independentHost:false,
      completeProviderEventTimeFrontierVerified:false,
      releaseSloCertified:false};
    process.stdout.write(JSON.stringify(result)+'\n');
    return result;
  }finally{await host.close();}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href)
  runMuffinOpenAILab().catch(e=>{
    // The OpenAI SDK can put request and credentials in error details;
    // never log message/stack. Failed ambiguous requests remain reserved.
    const known=new Set([
      'EI_MUFFIN_LIVE_DISABLED','EI_MUFFIN_OPENAI_CREDENTIAL_MISSING',
      'EI_MUFFIN_RUN_ID_INVALID','EI_MUFFIN_PERSISTENT_DIR_REQUIRED',
      'EI_MUFFIN_HOST_RECEIPT_INVALID','EI_MUFFIN_UNEXPECTED_MCP_CALL',
      'EI_MUFFIN_MODEL_BUDGET_EXCEEDED','EI_MUFFIN_NATIVE_TOOL_MISSING',
      'EI_MUFFIN_PROVIDER_TOOL_CALL_MISSING','EI_MUFFIN_PROVIDER_TOOL_ARGS_INVALID',
      'EI_MUFFIN_PROVIDER_TOOL_ARGS_DENIED','EI_MUFFIN_UNEXPECTED_SUSPEND',
      'EI_MUFFIN_WATCH_CREATE_REJECTED','EI_MUFFIN_WAKE_RECEIPT_MISMATCH',
      'EI_MUFFIN_MODEL_CONTINUATION_MISSING',
    ]);
    process.stderr.write(JSON.stringify({status:'blocked',
      code:known.has(e?.code)?e.code:'EI_MUFFIN_LIVE_PROVIDER_OR_HOST_ERROR',
      billingOutcome:'unknown-no-auto-retry'})+'\n');
    process.exitCode=2;
  });
