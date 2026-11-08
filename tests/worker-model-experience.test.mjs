/* Real workerd and isolated D1; no live credentials or model calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const directory = fileURLToPath(new URL("../cloudflare/", import.meta.url));
const req = createRequire(path.join(directory, "package.json"));
const wr = createRequire(req.resolve("wrangler/package.json"));
const {Miniflare, convertV4MiniflareOptions} = wr("miniflare");
const admin = "fixture-admin-token-0123456789abcdef";
const keys = {openai:"sk-fixture-openai", deepseek:"fixture-deepseek", mimo:"fixture-mimo", custom2:"fixture-custom2"};
const calls = [];
let incomplete = false;
const sources = ["worker.js", ...fs.readdirSync(directory).filter(n => /^worker-.+\.js$/.test(n))];
const mf = new Miniflare(convertV4MiniflareOptions({
  modules:sources.map(n=>({type:"ESModule",path:path.join(directory,n)})), modulesRoot:directory, compatibilityDate:"2026-08-08",
  bindings:{ADMIN_TOKEN:admin,
    MODEL_OPENAI_SECRET:JSON.stringify({base_url:"https://api.openai.com/v1",api_key:keys.openai}),
    MODEL_DEEPSEEK_SECRET:JSON.stringify({base_url:"https://api.deepseek.com",api_key:keys.deepseek}),
    MODEL_MIMO_SECRET:JSON.stringify({base_url:"https://api.xiaomimimo.com/v1",api_key:keys.mimo}),
    MODEL_CUSTOM2_SECRET:JSON.stringify({base_url:"https://custom2.example/v1",api_key:keys.custom2})},
  kvNamespaces:["CONFIG"],d1Databases:["DB"],
  ratelimits:{ADMIN_FAILED_AUTH_LIMITER:{namespace_id:"1001",simple:{limit:5,period:60}},
    GPT_RATE_LIMITER:{namespace_id:"1004",simple:{limit:5,period:60}},TRACK_RATE_LIMITER:{namespace_id:"1003",simple:{limit:120,period:60}}},
  outboundService:async request=>{
    const url=new URL(request.url), body=await request.json();
    const provider=url.hostname==='api.openai.com'?'openai':url.hostname==='api.deepseek.com'?'deepseek':url.hostname==='custom2.example'?'custom2':'mimo';
    assert.equal(request.headers.get('authorization'),'Bearer '+keys[provider]);calls.push({provider,body});
    if(provider==='openai') return Response.json({status:incomplete?'incomplete':'completed',service_tier:'default',output:[{type:'message',content:[{type:'output_text',text:'ok'}]}],
      usage:{input_tokens:100,output_tokens:50,input_tokens_details:{cached_tokens:20,cache_write_tokens:10},output_tokens_details:{reasoning_tokens:30}}});
    return Response.json({choices:[{finish_reason:'stop',message:{content:'ok'}}],usage:{prompt_tokens:20,completion_tokens:10}});
  }
}));
const headers={Authorization:'Bearer '+admin,'Content-Type':'application/json'};
const post=(url,data)=>mf.dispatchFetch('https://api.flitfancy.com'+url,{method:'POST',headers,body:JSON.stringify(data)});
const get=url=>mf.dispatchFetch('https://api.flitfancy.com'+url,{headers});
try {
  for(const [provider,model,base_url] of [['deepseek','deepseek-flash','https://api.deepseek.com'],['mimo','mimo-v2.5','https://api.xiaomimimo.com/v1'],['custom2','compatible-model','https://custom2.example/v1'],['openai','gpt-6.1-sol','https://api.openai.com/v1']]){
    const response=await post('/admin/model/config',{provider,model,base_url,access:'admin',public_daily_limit:20});assert.equal(response.status,200);
  }
  assert.equal((await post('/admin/model/config',{provider:'custom2',model:'sk-fixture-key-not-a-model-123456789',base_url:'https://custom2.example/v1',access:'admin',public_daily_limit:20})).status,400,
    'credential-like text must not be persisted as model metadata');
  const db=await mf.getD1Database('DB');
  await db.prepare("UPDATE model_gateway_config SET data=json_remove(data,'$.profiles.openai.models') WHERE id=1").run();
  const existing=await (await get('/admin/model/catalog')).json();
  assert(existing.profiles.some(row=>row.model==='gpt-6-astra'),'existing saved keys gain selectable models without being re-entered');
  await db.prepare("UPDATE model_gateway_config SET data=json_set(data,'$.access','all') WHERE id=1").run();
  const oldPublic=await (await mf.dispatchFetch('https://api.flitfancy.com/gpt/status')).json();
  assert.deepEqual(oldPublic.profiles.map(row=>row.model),['gpt-6.1-sol'],'an upgrade must not expose newly suggested models to existing public access');
  const oldAlternate=existing.profiles.find(row=>row.model==='gpt-6-astra');
  const denied=await mf.dispatchFetch('https://api.flitfancy.com/gpt/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'openai',model:'gpt-6-astra',profile_id:oldAlternate.profile_id,messages:[{role:'user',content:'hi'}]})});
  assert.equal(denied.status,403);
  await db.prepare("UPDATE model_gateway_config SET data=json_set(data,'$.access','admin') WHERE id=1").run();
  assert.equal((await post('/admin/model/config',{provider:'openai',model:'gpt-6.1-sol',models:['gpt-6.1-sol','gpt-6-astra'],base_url:'https://api.openai.com/v1',access:'admin',public_daily_limit:20})).status,200);
  const all=await (await get('/admin/model/catalog')).json();
  assert.deepEqual(all.profiles.map(row=>row.provider),['openai','openai','deepseek','mimo','custom2']);
  assert(!JSON.stringify(all).includes('fixture-'));
  const byName=Object.fromEntries(all.profiles.filter(row=>row.model!=='gpt-6-astra').map(row=>[row.provider,row]));
  for(const [provider,effort] of [['openai','high'],['deepseek','max'],['mimo','none'],['custom2','auto']]){
    const response=await post('/admin/model/chat',{provider,profile_id:byName[provider].profile_id,effort,messages:[{role:'user',content:'private fixture'}]});
    assert.equal(response.status,200);assert.equal((await response.json()).reply,'ok');
  }
  assert.equal(calls[0].body.reasoning.effort,'high');assert.equal(calls[1].body.reasoning_effort,'max');assert.equal(calls[2].body.thinking.type,'disabled');
  const alternate=all.profiles.find(row=>row.model==='gpt-6-astra');
  assert.equal(alternate.connection_id,byName.openai.connection_id);
  assert.notEqual(alternate.connection_id,byName.deepseek.connection_id);
  assert.equal((await post('/admin/model/chat',{provider:'openai',model:'gpt-6-astra',profile_id:alternate.profile_id,effort:'xhigh',messages:[{role:'user',content:'x'}]})).status,200);
  assert.equal(calls.at(-1).body.model,'gpt-6-astra');
  assert.equal((await post('/admin/model/chat',{provider:'openai',model:'unconfigured-model',profile_id:alternate.profile_id,messages:[{role:'user',content:'x'}]})).status,400);
  incomplete=true;
  const unfinished=await post('/admin/model/chat',{provider:'openai',profile_id:byName.openai.profile_id,effort:'high',messages:[{role:'user',content:'x'}]});
  assert.equal(unfinished.status,502);assert.equal((await unfinished.json()).code,'incomplete_response');incomplete=false;
  assert.equal((await post('/admin/model/config',{provider:'openai',model:'gpt-6.1-sol',base_url:'https://api.openai.com/v1',access:'admin',public_daily_limit:20,default_effort:'high'})).status,200);
  assert.equal((await post('/admin/model/chat',{purpose:'consult',profile_id:byName.openai.profile_id,messages:[{role:'user',content:'x'}]})).status,200);
  assert.equal(calls.at(-1).body.reasoning.effort,'high','Firefly consultation uses the saved default effort');
  assert.equal((await post('/admin/model/chat',{provider:'mimo',profile_id:byName.mimo.profile_id,effort:'max',messages:[{role:'user',content:'x'}]})).status,400);
  const savedOther=await post('/admin/model/config',{provider:'custom2',model:'compatible-model',base_url:'https://custom2.example/v1',access:'admin',public_daily_limit:20,set_default:false});assert.equal(savedOther.status,200);
  const status=await (await get('/admin/model/status')).json();assert.equal(status.selected_provider,'openai','per-turn selection and adding another service cannot change Firefly default');
  const anonymous=await mf.dispatchFetch('https://api.flitfancy.com/admin/model/usage');assert.equal(anonymous.status,401);
  const usage=await (await get('/admin/model/usage')).json();assert.equal(usage.today.requests,7);assert.equal(usage.today.input_tokens,460);
  assert.equal(usage.today.output_tokens,230);assert.equal(usage.today.unknown_cost,5);assert(Math.abs(usage.today.estimated_usd-0.001334)<1e-10);
  assert(usage.recent.some(row=>row.outcome==='error' && row.input_tokens===100),'incomplete replies can still incur tokens');
  assert(usage.breakdown.some(row=>row.purpose==='consult' && row.model==='gpt-6.1-sol'));
  assert(!JSON.stringify(usage).includes('private fixture'));assert(!JSON.stringify(usage).includes('fixture-openai'));
  const publicStatus=await (await mf.dispatchFetch('https://api.flitfancy.com/gpt/status')).json();assert.deepEqual(publicStatus.profiles,[]);
  assert.equal((await post('/admin/model/config',{provider:'openai',model:'gpt-6.1-sol',base_url:'https://api.openai.com/v1',access:'all',public_daily_limit:20})).status,200);
  let visitor=await (await mf.dispatchFetch('https://api.flitfancy.com/gpt/status')).json();
  assert.deepEqual(visitor.profiles.map(row=>row.provider),['openai','openai'], 'existing visitor permission does not expose other configured services');
  const publicPost=(body)=>mf.dispatchFetch('https://api.flitfancy.com/gpt/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await publicPost({provider:'deepseek',profile_id:byName.deepseek.profile_id,messages:[{role:'user',content:'hi'}]})).status,403);
  assert.equal((await post('/admin/model/config',{provider:'deepseek',model:'deepseek-flash',base_url:'https://api.deepseek.com',access:'all',public_daily_limit:20,set_default:false,public_enabled:true})).status,200);
  visitor=await (await mf.dispatchFetch('https://api.flitfancy.com/gpt/status')).json();
  assert.deepEqual(visitor.profiles.map(row=>row.provider),['openai','openai','deepseek']);
  assert.equal((await publicPost({provider:'deepseek',profile_id:byName.deepseek.profile_id,effort:'low',messages:[{role:'user',content:'hi'}]})).status,200);
} finally {await mf.dispose();}
console.log('workerd model catalog, provider effort mapping, privacy and usage accounting passed');
