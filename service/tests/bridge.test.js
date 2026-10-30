'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createBackend,createStore,isLocalIP,BRIDGE_ID}=require('../com.samuel.huetv.service/bridge');
const ids={room:'11111111-1111-1111-1111-111111111111',group:'22222222-2222-2222-2222-222222222222',light:'33333333-3333-3333-3333-333333333333',device:'44444444-4444-4444-4444-444444444444',scene:'55555555-5555-5555-5555-555555555555'};
const testKey='test-pairing-key-not-real';
function fixture(){
 let saved=null; let last=null;
 const store={read:async()=>saved,save:async x=>{saved=x},prepare:async()=>{}};
 const resources={light:[{id:ids.light,owner:{rid:ids.device},on:{on:true},dimming:{brightness:30}}], room:[{id:ids.room,metadata:{name:'Salon'},children:[{rid:ids.device,rtype:'device'}],services:[{rid:ids.group,rtype:'grouped_light'}]}], device:[{id:ids.device,metadata:{name:'TV'}}],grouped_light:[{id:ids.group,on:{on:true},dimming:{brightness:30}}],zigbee_connectivity:[{owner:{rid:ids.device},status:'connected'}],scene:[{id:ids.scene,metadata:{name:'Détente'},group:{rtype:'room',rid:ids.room}}]};
 async function request(ip,url,o={}) { last={ip,url,o}; if(url==='/api/config') return {bridgeid:BRIDGE_ID}; if(url==='/api') return [{success:{username:testKey}}]; if(o.method==='PUT') {const parts=url.split('/');return {errors:[],data:[{rid:parts.at(-1),rtype:parts.at(-2)}]};} if(o.method==='POST' && url==='/clip/v2/resource/scene') return {errors:[],data:[{rid:ids.scene,rtype:'scene'}]}; if(url==='/clip/v2/resource/light/'+ids.light) return {errors:[],data:resources.light}; const t=url.split('/').at(-1); return {errors:[],data:resources[t]}; }
 return {backend:createBackend({request,store}),last:()=>last,getSaved:()=>saved,resources};
}
test('local address excludes public, hostnames and loopback',()=>{assert.equal(isLocalIP('192.168.1.100'),true);assert.equal(isLocalIP('10.0.0.1'),true);assert.equal(isLocalIP('127.0.0.1'),false);assert.equal(isLocalIP('8.8.8.8'),false);assert.equal(isLocalIP('some.local'),false);});
test('association keeps secret internal and snapshot maps devices and scene to room',async()=>{const f=fixture();const result=await f.backend.pair({ip:'192.168.1.100'});assert.equal(result.paired,true);assert.equal(JSON.stringify(result).includes(testKey),false);const s=await f.backend.snapshot();assert.equal(s.lights[0].name,'TV');assert.equal(s.lights[0].reachable,true);assert.deepEqual(s.rooms[0].lights,[ids.light]);assert.equal(s.scenes[0].roomId,ids.room);assert.equal(JSON.stringify(s).includes(testKey),false);});
test('room control resolves a room to its grouped light',async()=>{const f=fixture();await f.backend.pair();await f.backend.setRoom({id:ids.room,on:false,brightness:60});assert.equal(f.last().url,'/clip/v2/resource/grouped_light/'+ids.group);assert.deepEqual(f.last().o.body,{on:{on:false},dimming:{brightness:60}});});
test('invalid commands and endpoint injection rejected',async()=>{const f=fixture();await f.backend.pair();await assert.rejects(f.backend.setLight({id:'../../api',on:true}));await assert.rejects(f.backend.setLight({id:ids.light,on:'true'}));await assert.rejects(f.backend.setLight({id:ids.light,brightness:101}));await assert.rejects(f.backend.setLight({id:ids.light}));});
test('scene recall uses active and does not modify scene definition',async()=>{const f=fixture();await f.backend.pair();await f.backend.activateScene({id:ids.scene});assert.equal(f.last().url,'/clip/v2/resource/scene/'+ids.scene);assert.deepEqual(f.last().o.body,{recall:{action:'active'}});});
test('credential store is private, prevents symlink directory and round-trips',async()=>{const t=await fs.mkdtemp(path.join(os.tmpdir(),'hue-store-test-'));try{const d=path.join(t,'private');const s=createStore(d);assert.equal(await s.read(),null);await s.save({ip:'192.168.1.100',key:testKey});assert.equal((await fs.stat(d)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(d,'bridge.json'))).mode&0o777,0o600);assert.equal((await s.read()).key,testKey);const symlink=path.join(t,'link');await fs.symlink(d,symlink);await assert.rejects(createStore(symlink).read());}finally{await fs.rm(t,{recursive:true,force:true});}});
test('bridge refusal while pairing is translated without leaking response',async()=>{const b=createBackend({store:{read:async()=>null,save:async()=>{},prepare:async()=>{}},request:async(_ip,url)=>url==='/api/config'?{bridgeid:BRIDGE_ID}:[{error:{type:101,description:'secret'}}]});await assert.rejects(b.pair(),/bouton du pont/);});

test('storage failure prevents bridge from creating a key',async()=>{let pairingAttempted=false;const b=createBackend({store:{read:async()=>null,save:async()=>{},prepare:async()=>{throw new Error('disk')}},request:async(_ip,url)=>{if(url==='/api'){pairingAttempted=true;} return {bridgeid:BRIDGE_ID}}});await assert.rejects(b.pair(),/Stockage local privé/);assert.equal(pairingAttempted,false);});

test('snapshot describes actual lamp capabilities and current color',async()=>{
 const f=fixture(); await f.backend.pair();
 Object.assign(f.resources.light[0],{color:{xy:{x:0.31,y:0.32},gamut:{red:{x:0.68,y:0.30},green:{x:0.17,y:0.70},blue:{x:0.15,y:0.06}}},color_temperature:{mirek:300,mirek_valid:true,mirek_schema:{mirek_minimum:153,mirek_maximum:500}}});
 const light=(await f.backend.snapshot()).lights[0];
 assert.equal(light.supportsColor,true); assert.deepEqual(light.colorXy,{x:0.31,y:0.32});
 assert.equal(light.supportsColorTemperature,true); assert.equal(light.colorTemperature,300); assert.equal(light.mirekMin,153); assert.equal(light.mirekMax,500); assert.equal(light.supportsDimming,true);
});
test('color command validates xy and clamps values outside lamp gamut',async()=>{
 const f=fixture(); await f.backend.pair();
 f.resources.light[0].color={gamut:{red:{x:0.68,y:0.30},green:{x:0.17,y:0.70},blue:{x:0.15,y:0.06}}};
 await f.backend.setLight({id:ids.light,on:true,color:{x:0.75,y:0.2}});
 assert.equal(f.last().url,'/clip/v2/resource/light/'+ids.light);
 assert.equal(f.last().o.body.on.on,true);
 const xy=f.last().o.body.color.xy; assert.ok(xy.x<0.75); assert.ok(xy.y>0.2);
 for(const color of [{x:-0.1,y:0.2},{x:1,y:1},{x:NaN,y:0.2},{x:0.5,y:0},{x:0.3,y:0.3,extra:'x'}]) await assert.rejects(f.backend.setLight({id:ids.light,color}));
 await assert.rejects(f.backend.setLight({id:ids.light,color:{x:0.3,y:0.3},temperature:300}));
});
test('unsupported and out-of-range temperatures fail before mutation',async()=>{
 const f=fixture(); await f.backend.pair();
 await assert.rejects(f.backend.setLight({id:ids.light,color:{x:0.3,y:0.3}}),/ne prend pas en charge/);
 assert.equal(f.last().o.method,'GET');
 await assert.rejects(f.backend.setLight({id:ids.light,temperature:300}),/ne prend pas en charge/);
 f.resources.light[0].color_temperature={mirek_schema:{mirek_minimum:200,mirek_maximum:450}};
 await assert.rejects(f.backend.setLight({id:ids.light,temperature:153}),/hors plage/);
 assert.equal(f.last().o.method,'GET');
 await f.backend.setLight({id:ids.light,on:true,temperature:300});
 assert.deepEqual(f.last().o.body,{on:{on:true},color_temperature:{mirek:300}});
 await assert.rejects(f.backend.setRoom({id:ids.room,color:{x:0.3,y:0.3}}),/lampe par lampe/);
});
test('automations list excludes accessory controls and never sends configuration',async()=>{
 const f=fixture(); await f.backend.pair();
 const script='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', accessoryScript='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 const auto='cccccccc-cccc-cccc-cccc-cccccccccccc', accessory='dddddddd-dddd-dddd-dddd-dddddddddddd';
 f.resources.behavior_script=[{id:script,metadata:{category:'automation'}},{id:accessoryScript,metadata:{category:'accessory'}}];
 f.resources.behavior_instance=[{id:auto,script_id:script,metadata:{name:'Soir'},enabled:true,status:'active',configuration:{secret:'never returned'}},{id:accessory,script_id:accessoryScript,enabled:true}];
 const result=await f.backend.automations();
 assert.deepEqual(result.automations,[{id:auto,name:'Soir',enabled:true,status:'active'}]);
 await f.backend.setAutomation({id:auto,enabled:false});
 assert.equal(f.last().url,'/clip/v2/resource/behavior_instance/'+auto);
 assert.deepEqual(f.last().o.body,{enabled:false});
 await assert.rejects(f.backend.setAutomation({id:accessory,enabled:false}),/introuvable/);
 await assert.rejects(f.backend.setAutomation({id:auto,enabled:'false'}),/État invalide/);
 assert.equal(f.last().o.method,'GET');
});
test('unknown categories and missing enabled fields fail closed',async()=>{
 const f=fixture(); await f.backend.pair();
 const script='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', auto='cccccccc-cccc-cccc-cccc-cccccccccccc';
 f.resources.behavior_script=[{id:script,metadata:{category:'other'}}];
 f.resources.behavior_instance=[{id:auto,script_id:script,enabled:true}];
 assert.deepEqual((await f.backend.automations()).automations,[]);
 await assert.rejects(f.backend.setAutomation({id:auto,enabled:false}),/introuvable/);
 f.resources.behavior_script[0].metadata.category='automation'; delete f.resources.behavior_instance[0].enabled;
 assert.deepEqual((await f.backend.automations()).automations,[]);
});
test('saving a new static scene uses known current lamp state and never overwrites another',async()=>{
 const f=fixture(); await f.backend.pair();
 f.resources.device[0].services=[{rtype:'light',rid:ids.light}];
 Object.assign(f.resources.light[0],{color:{xy:{x:0.31,y:0.32}},color_temperature:{mirek:280,mirek_valid:true},effects:{status:'no_effect'},dynamics:{status:'none'}});
 const saved=await f.backend.saveScene({roomId:ids.room,name:'  Détente  '});
 assert.deepEqual(saved,{returnValue:true,sceneId:ids.scene});
 assert.equal(f.last().url,'/clip/v2/resource/scene'); assert.equal(f.last().o.method,'POST');
 assert.deepEqual(f.last().o.body,{metadata:{name:'Détente'},group:{rid:ids.room,rtype:'room'},actions:[{target:{rid:ids.light,rtype:'light'},action:{on:{on:true},dimming:{brightness:30},color_temperature:{mirek:280}}}]});
 f.resources.light[0].color_temperature.mirek_valid=false;
 await f.backend.saveScene({roomId:ids.room,name:'Bleu'});
 assert.deepEqual(f.last().o.body.actions[0].action.color,{xy:{x:0.31,y:0.32}});
 assert.equal('color_temperature' in f.last().o.body.actions[0].action,false);
 f.resources.light[0].on.on=false;
 await f.backend.saveScene({roomId:ids.room,name:'Éteint'});
 assert.deepEqual(f.last().o.body.actions[0].action,{on:{on:false}});
});
test('saving refuses offline/unknown/dynamic lamps and invalid name before POST',async()=>{
 const f=fixture(); await f.backend.pair(); f.resources.device[0].services=[{rtype:'light',rid:ids.light}];
 for(const name of ['', ' '.repeat(2), 'x'.repeat(33),'bad\nname']) await assert.rejects(f.backend.saveScene({roomId:ids.room,name}));
 f.resources.zigbee_connectivity[0].status='disconnected';
 await assert.rejects(f.backend.saveScene({roomId:ids.room,name:'Soir'}),/injoignable/); assert.equal(f.last().o.method,'GET');
 f.resources.zigbee_connectivity[0].status='connected'; delete f.resources.light[0].on;
 await assert.rejects(f.backend.saveScene({roomId:ids.room,name:'Soir'}),/état complet/);
 f.resources.light[0].on={on:true}; f.resources.light[0].effects={status:'candle'};
 await assert.rejects(f.backend.saveScene({roomId:ids.room,name:'Soir'}),/effet animé/);
 f.resources.light[0].effects={status:'no_effect'}; f.resources.light[0].color_temperature={mirek:null,mirek_valid:false};
 await assert.rejects(f.backend.saveScene({roomId:ids.room,name:'Soir'}),/couleurs est indisponible/);
});
test('unconfirmed bridge update is not reported as success or retried',async()=>{
 let writes=0;
 const b=createBackend({store:{read:async()=>({ip:'192.168.1.100',key:testKey})},request:async(_ip,_url,o)=>{if(o.method==='PUT'){writes++;return {errors:[],data:[]};}return {errors:[],data:[]};}});
 await assert.rejects(b.setLight({id:ids.light,on:false}),/résultat non confirmé/);
 assert.equal(writes,1);
});

function liveFixture({off=false,ignoreOffColor=false,temperature=false}={}) {
 const light={id:ids.light,owner:{rid:ids.device},on:{on:!off},dimming:{brightness:37},color:{xy:{x:0.31,y:0.32}},color_temperature:{mirek:280,mirek_valid:temperature,mirek_schema:{mirek_minimum:153,mirek_maximum:500}},effects:{status:'no_effect'},dynamics:{status:'none'}};
 const calls=[]; let failNext=false;
 const store={read:async()=>({ip:'192.168.1.100',key:testKey})};
 async function request(_ip,url,o) {
  if(url==='/clip/v2/resource/zigbee_connectivity') return {errors:[],data:[{owner:{rid:ids.device},status:'connected'}]};
  assert.equal(url,'/clip/v2/resource/light/'+ids.light);
  if(o.method==='PUT') {
   calls.push(JSON.parse(JSON.stringify(o.body)));
   if(failNext){failNext=false;throw new Error('network timeout');}
   const body=o.body;
   if(body.on) light.on.on=body.on.on;
   if(body.dimming) light.dimming.brightness=body.dimming.brightness;
   if(!(ignoreOffColor && body.on && body.on.on===false)) {
    if(body.color){light.color.xy={...body.color.xy}; light.color_temperature.mirek_valid=false;}
    if(body.color_temperature){light.color_temperature.mirek=body.color_temperature.mirek;light.color_temperature.mirek_valid=true;}
   }
   return {errors:[],data:[{rid:ids.light,rtype:'light'}]};
  }
  return {errors:[],data:[JSON.parse(JSON.stringify(light))]};
 }
 return {light,calls,backend:createBackend({request,store}),restart:()=>createBackend({request,store}),fail:()=>{failNext=true;}};
}
test('preview captures full original state and survives service restart',async()=>{
 const f=liveFixture({off:true});
 const {original}=await f.backend.beginPreview({id:ids.light});
 assert.deepEqual(original,{on:false,brightness:37,color:{x:0.31,y:0.32}});
 assert.equal(JSON.stringify(original).includes(testKey),false);
 await f.backend.setLight({id:ids.light,on:true,color:{x:0.22,y:0.4}});
 await f.restart().cancelPreview({id:ids.light,original});
 assert.deepEqual(f.calls.at(-1),{on:{on:false},dimming:{brightness:37},color:{xy:{x:0.31,y:0.32}}});
 assert.equal(f.light.on.on,false); assert.deepEqual(f.light.color.xy,{x:0.31,y:0.32});
});
test('preview restores temperature mode and brightness',async()=>{
 const f=liveFixture({temperature:true});
 const {original}=await f.backend.beginPreview({id:ids.light});
 assert.deepEqual(original,{on:true,brightness:37,temperature:280});
 await f.backend.setLight({id:ids.light,on:true,color:{x:0.22,y:0.4}});
 f.light.dimming.brightness=65;
 await f.backend.cancelPreview({id:ids.light,original});
 assert.equal(f.light.on.on,true);assert.equal(f.light.dimming.brightness,37);assert.equal(f.light.color_temperature.mirek,280);assert.equal(f.light.color_temperature.mirek_valid,true);
});
test('preview refuses animated effects, gradients and unknown original colour',async()=>{
 const f=liveFixture();
 f.light.effects.status='candle'; await assert.rejects(f.backend.beginPreview({id:ids.light}),/effet animé/);
 f.light.effects.status='no_effect'; f.light.gradient={points:[{color:{xy:{x:0.3,y:0.3}}}]}; await assert.rejects(f.backend.beginPreview({id:ids.light}),/dégradé/);
 delete f.light.gradient; f.light.dynamics.status='dynamic_palette'; await assert.rejects(f.backend.beginPreview({id:ids.light}),/effet animé/);
 f.light.dynamics.status='none'; delete f.light.color.xy; await assert.rejects(f.backend.beginPreview({id:ids.light}),/couleur indisponible/);
 f.light.color.xy={x:0.31,y:0.32}; delete f.light.color_temperature.mirek_valid;
 await assert.rejects(f.backend.beginPreview({id:ids.light}),/couleur indisponible/);
 assert.equal(f.calls.length,0);
});
test('acknowledged restore which ignores off-state colour remains unconfirmed',async()=>{
 const f=liveFixture({off:true,ignoreOffColor:true});
 const {original}=await f.backend.beginPreview({id:ids.light});
 await f.backend.setLight({id:ids.light,on:true,color:{x:0.22,y:0.4}});
 await assert.rejects(f.backend.cancelPreview({id:ids.light,original}),/Restauration non confirmée/);
 assert.deepEqual(f.calls.at(-1),{on:{on:false},dimming:{brightness:37},color:{xy:{x:0.31,y:0.32}}});
 assert.equal(f.light.on.on,false);
});
test('network error during cancel leaves the baseline usable for retry',async()=>{
 const f=liveFixture(); const {original}=await f.backend.beginPreview({id:ids.light});
 await f.backend.setLight({id:ids.light,on:true,color:{x:0.22,y:0.4}});
 f.fail(); await assert.rejects(f.backend.cancelPreview({id:ids.light,original}),/network timeout/);
 await f.backend.cancelPreview({id:ids.light,original}); assert.deepEqual(f.light.color.xy,original.color);
});

test('wall-clock deadline stops a slowly streaming GET before any preview PUT',async()=>{
 const https=require('node:https'); const {EventEmitter}=require('node:events');
 const realRequest=https.request; const methods=[]; let destroyed=false; let streamTimer;
 https.request=(options,callback)=>{
  methods.push(options.method);
  const req=new EventEmitter();
  req.write=()=>{};
  req.destroy=()=>{destroyed=true;clearInterval(streamTimer);};
  req.end=()=>{
   const res=new EventEmitter();res.statusCode=200;
   process.nextTick(()=>{callback(res);streamTimer=setInterval(()=>res.emit('data',Buffer.from(' ')),20);});
  };
  return req;
 };
 try {
  const b=createBackend({store:{read:async()=>({ip:'192.168.1.100',key:testKey})}});
  const start=Date.now();
  await assert.rejects(b.setLight({id:ids.light,on:true,color:{x:0.22,y:0.4}}),/ne répond pas/);
  assert.ok(Date.now()-start<5500);
  assert.equal(destroyed,true); assert.deepEqual(methods,['GET']);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.deepEqual(methods,['GET']);
 } finally {clearInterval(streamTimer);https.request=realRequest;}
});
