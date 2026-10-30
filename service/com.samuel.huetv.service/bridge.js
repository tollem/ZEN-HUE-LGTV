'use strict';
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const ROOT_CA = fs.readFileSync(path.join(__dirname, 'hue-ca.pem'));
const BRIDGE_ID = '0000000000000000';
const DEFAULT_IP = '192.168.1.100';
const STATE_DIR = '/media/internal/com.samuel.huetv';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9-]{8,128}$/;

function isLocalIP(ip) {
  if (typeof ip !== 'string' || net.isIP(ip) !== 4) return false;
  const [a,b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function safeId(id) { if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Identifiant invalide.'); return id; }
function patchFor(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Commande invalide.');
  const out = {};
  if (Object.prototype.hasOwnProperty.call(payload, 'on')) {
    if (typeof payload.on !== 'boolean') throw new Error('État invalide.');
    out.on = {on: payload.on};
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'brightness')) {
    if (typeof payload.brightness !== 'number' || !Number.isFinite(payload.brightness) || payload.brightness < 1 || payload.brightness > 100) throw new Error('Luminosité invalide.');
    out.dimming = {brightness: payload.brightness};
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'color')) {
    const color = payload.color;
    if (!color || typeof color !== 'object' || Array.isArray(color) ||
        typeof color.x !== 'number' || typeof color.y !== 'number' ||
        !Number.isFinite(color.x) || !Number.isFinite(color.y) ||
        color.x < 0 || color.y <= 0 || color.x > 1 || color.y > 1 || color.x + color.y > 1 ||
        Object.keys(color).some(k => k !== 'x' && k !== 'y')) throw new Error('Couleur invalide.');
    out.color = {xy:{x:color.x, y:color.y}};
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'temperature')) {
    if (!Number.isInteger(payload.temperature) || payload.temperature < 1 || payload.temperature > 1000) throw new Error('Température invalide.');
    out.color_temperature = {mirek:payload.temperature};
  }
  if (out.color && out.color_temperature) throw new Error('Choisis une couleur ou une température.');
  if (!Object.keys(out).length) throw new Error('Commande vide.');
  return out;
}
function validXY(value) {
  return value && typeof value.x === 'number' && typeof value.y === 'number' &&
    Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 0 && value.y > 0 &&
    value.x <= 1 && value.y <= 1 && value.x + value.y <= 1;
}
function normalizedGamut(value) {
  if (!value || !validXY(value.red) || !validXY(value.green) || !validXY(value.blue)) return null;
  const red={x:value.red.x,y:value.red.y}, green={x:value.green.x,y:value.green.y}, blue={x:value.blue.x,y:value.blue.y};
  const area=(green.x-red.x)*(blue.y-red.y)-(green.y-red.y)*(blue.x-red.x);
  return Math.abs(area)>1e-9 ? {red,green,blue} : null;
}
// Hue lamps have different gamuts. Clamp to the nearest triangle edge so a
// valid colour choice outside a lamp's range remains usable and predictable.
function clampToGamut(point, gamut) {
  if (!gamut) return point;
  const verts=[gamut.red,gamut.green,gamut.blue];
  const cross=(a,b,p)=>(b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
  const signs=verts.map((a,i)=>cross(a,verts[(i+1)%3],point));
  if (signs.every(v=>v>=-1e-9) || signs.every(v=>v<=1e-9)) return point;
  let nearest=null, distance=Infinity;
  for(let i=0;i<3;i++) {
    const a=verts[i],b=verts[(i+1)%3],dx=b.x-a.x,dy=b.y-a.y;
    const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/(dx*dx+dy*dy)));
    const candidate={x:a.x+t*dx,y:a.y+t*dy};
    const d=(point.x-candidate.x)**2+(point.y-candidate.y)**2;
    if(d<distance) { nearest=candidate; distance=d; }
  }
  return nearest;
}
function requestBridge(ip, endpoint, options = {}) {
  if (!isLocalIP(ip)) return Promise.reject(new Error('Adresse locale invalide.'));
  const method = options.method || 'GET';
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = {Accept:'application/json'};
  if (options.key) headers['hue-application-key'] = options.key;
  if (body) { headers['content-type']='application/json'; headers['content-length']=Buffer.byteLength(body); }
  return new Promise((resolve, reject) => {
    let settled=false, deadline;
    const finish=(err,value)=>{
      if(settled) return;
      settled=true;
      clearTimeout(deadline);
      if(err) reject(err); else resolve(value);
    };
    const req = https.request({hostname:ip, port:443, path:endpoint, method, headers,
      ca:ROOT_CA, rejectUnauthorized:true, servername:BRIDGE_ID,
      checkServerIdentity: (_host, cert) => tls.checkServerIdentity(BRIDGE_ID, cert)}, res => {
      let chunks=[], size=0;
      res.on('data', chunk => { size+=chunk.length; if(size>2*1024*1024) { finish(new Error('Réponse Hue invalide.')); req.destroy(); return; } chunks.push(chunk); });
      res.on('error', () => finish(new Error('Connexion sécurisée au pont Hue impossible.')));
      res.on('aborted', () => finish(new Error('Connexion sécurisée au pont Hue impossible.')));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return finish(new Error(res.statusCode===403 ? 'Association refusée par le pont.' : 'Le pont Hue ne répond pas correctement.'));
        try { finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new Error('Réponse Hue invalide.')); }
      });
    });
    // This is a wall-clock limit, not Node's socket inactivity timeout. A
    // bridge dribbling bytes must not keep an old preview alive indefinitely.
    deadline=setTimeout(()=>{ finish(new Error('Le pont Hue ne répond pas.')); req.destroy(); },4000);
    req.on('error', () => finish(new Error('Connexion sécurisée au pont Hue impossible.')));
    if (body) req.write(body); req.end();
  });
}
function createStore(dir=STATE_DIR) {
  const file=path.join(dir,'bridge.json');
  async function secureDirectory() {
    try { await fs.promises.mkdir(dir,{mode:0o700}); } catch(e) { if(e.code!=='EEXIST') throw e; }
    const st=await fs.promises.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid==='function' && st.uid!==process.getuid())) throw new Error('Stockage privé indisponible.');
    await fs.promises.chmod(dir,0o700);
  }
  async function read() {
    try {
      await secureDirectory();
      const fh=await fs.promises.open(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const st=await fh.stat();
        if(!st.isFile() || (typeof process.getuid==='function' && st.uid!==process.getuid()) || (st.mode & 0o077)!==0 || st.size>4096) throw new Error('Stockage privé invalide.');
        const value=JSON.parse(await fh.readFile('utf8'));
        if(!isLocalIP(value.ip) || typeof value.key!=='string' || !KEY.test(value.key)) throw new Error('Stockage privé invalide.');
        return value;
      } finally { await fh.close(); }
    } catch(e) { if(e.code==='ENOENT') return null; throw e; }
  }
  async function save(data) {
    if(!isLocalIP(data.ip) || !KEY.test(data.key)) throw new Error('Association invalide.');
    await secureDirectory();
    try { const st=await fs.promises.lstat(file); if(!st.isFile() || st.isSymbolicLink() || (typeof process.getuid==='function' && st.uid!==process.getuid())) throw new Error('Stockage privé invalide.'); } catch(e) { if(e.code!=='ENOENT') throw e; }
    const temp=path.join(dir,'.bridge-'+crypto.randomBytes(12).toString('hex'));
    try {
      const fh=await fs.promises.open(temp,fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),0o600);
      try {await fh.writeFile(JSON.stringify(data),'utf8'); await fh.chmod(0o600);} finally {await fh.close();}
      await fs.promises.rename(temp,file);
    } finally {try{await fs.promises.unlink(temp);}catch(e){if(e.code!=='ENOENT') throw e;}}
  }
  async function prepare() {
    await secureDirectory();
    const probe=path.join(dir,'.probe-'+crypto.randomBytes(12).toString('hex'));
    const next=probe+'-renamed';
    try {
      const fh=await fs.promises.open(probe,fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),0o600);
      try { await fh.writeFile('ok','utf8'); await fh.chmod(0o600); } finally { await fh.close(); }
      await fs.promises.rename(probe,next);
      const st=await fs.promises.lstat(next);
      if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)!==0) throw new Error('Stockage local privé indisponible.');
    } finally {
      for(const candidate of [probe,next]) { try {await fs.promises.unlink(candidate);} catch(e){if(e.code!=='ENOENT') throw e;} }
    }
  }
  return {read,save,prepare};
}
function createBackend({request=requestBridge,store=createStore()}={}) {
  async function credentials() { const c=await store.read(); if(!c) throw new Error('Pont non associé.'); return c; }
  async function api(c, endpoint, method='GET', body) {
    const result=await request(c.ip,endpoint,{key:c.key,method,body});
    if(Array.isArray(result.errors) && result.errors.length) throw new Error('Le pont Hue a refusé la demande.');
    return result;
  }
  async function list(c,type) {
    const d=await api(c,'/clip/v2/resource/'+type);
    if(!Array.isArray(d.data)) throw new Error('Réponse Hue invalide.');
    return d.data;
  }
  async function updateResource(c,type,id,body) {
    const result=await api(c,'/clip/v2/resource/'+type+'/'+id,'PUT',body);
    // An HTTP 200 alone does not prove the bridge accepted the operation.
    // Do not retry automatically: the bridge may have applied it already.
    if(!Array.isArray(result.data) || !result.data.some(x=>x && x.rid===id && x.rtype===type)) throw new Error('Commande envoyée, résultat non confirmé. Actualise avant de réessayer.');
  }
  async function status() {
    const c=await store.read(); const ip=c ? c.ip : DEFAULT_IP;
    try {
      const cfg=await request(ip,'/api/config');
      if(cfg.bridgeid!==BRIDGE_ID) throw new Error('Identité du pont différente.');
      if (c) {
        try { await api(c,'/clip/v2/resource/bridge'); }
        catch { return {returnValue:true,paired:false,bridgeReachable:true,ip}; }
      }
      return {returnValue:true,paired:!!c,bridgeReachable:true,ip};
    } catch { return {returnValue:true,paired:!!c,bridgeReachable:false,ip}; }
  }
  async function pair(payload={}) {
    const ip=payload.ip || DEFAULT_IP;
    if(!isLocalIP(ip)) throw new Error('Adresse locale invalide.');
    const cfg=await request(ip,'/api/config'); if(cfg.bridgeid!==BRIDGE_ID) throw new Error('Ce n’est pas le pont Hue attendu.');
    // Check that private persistence works before asking the bridge to create a key.
    try { await store.prepare(); } catch { throw new Error('Stockage local privé indisponible.'); }
    // Reuse an existing working key if the bridge was simply assigned a new IP.
    const existing=await store.read();
    if(existing) {
      const moved={ip,key:existing.key};
      let valid=false;
      try { await api(moved,'/clip/v2/resource/bridge'); valid=true; } catch {}
      if(valid) {
        if(ip!==existing.ip) {
          try { await store.save(moved); } catch { throw new Error('Stockage local privé indisponible.'); }
        }
        return {returnValue:true,paired:true,bridgeReachable:true,ip};
      }
    }
    const result=await request(ip,'/api',{method:'POST',body:{devicetype:'hue_tv#lg'}});
    if(!Array.isArray(result)) throw new Error('Réponse d’association invalide.');
    const failure=result.find(x=>x && x.error);
    if(failure) throw new Error(failure.error.type===101 ? 'Appuie sur le bouton du pont, puis réessaie.' : 'Association refusée par le pont.');
    const key=result[0] && result[0].success && result[0].success.username;
    if(typeof key!=='string' || !KEY.test(key)) throw new Error('Réponse d’association invalide.');
    try { await store.save({ip,key}); }
    catch {
      // Best-effort removal of the just-created account; never disclose its key.
      try {
        const removed=await request(ip,'/api/'+encodeURIComponent(key)+'/config/whitelist/'+encodeURIComponent(key),{method:'DELETE'});
        if(!Array.isArray(removed) || !removed.some(x=>x && x.success)) throw new Error('Révocation non confirmée');
      } catch { throw new Error('Association créée mais stockage et révocation non confirmés.'); }
      throw new Error('Stockage local privé indisponible.');
    }
    return {returnValue:true,paired:true,bridgeReachable:true,ip};
  }
  async function snapshot() {
    const c=await credentials();
    const [lights,rooms,devices,groups,connections,scenes]=await Promise.all(['light','room','device','grouped_light','zigbee_connectivity','scene'].map(x=>list(c,x)));
    const byDevice=new Map(devices.map(d=>[d.id,d]));
    const byGroup=new Map(groups.map(d=>[d.id,d]));
    const connectivity=new Map(connections.filter(x=>x.owner).map(x=>[x.owner.rid,x.status]));
    const normalizedLights=lights.map(l=>{
      const d=l.owner && byDevice.get(l.owner.rid);
      const reach=l.owner && connectivity.get(l.owner.rid);
      const ct=l.color_temperature, schema=ct && ct.mirek_schema;
      const mirekMin=schema && Number.isInteger(schema.mirek_minimum)?schema.mirek_minimum:null;
      const mirekMax=schema && Number.isInteger(schema.mirek_maximum)?schema.mirek_maximum:null;
      return {id:l.id,name:(l.metadata&&l.metadata.name)||(d&&d.metadata&&d.metadata.name)||'Lampe',on:!!(l.on&&l.on.on),brightness:l.dimming && Number.isFinite(l.dimming.brightness)?l.dimming.brightness:null,reachable:reach ? reach==='connected' : null,deviceId:l.owner&&l.owner.rid,
        supportsDimming:!!l.dimming,supportsColor:!!l.color,colorXy:l.color && validXY(l.color.xy)?{x:l.color.xy.x,y:l.color.xy.y}:null,colorGamut:l.color?normalizedGamut(l.color.gamut):null,
        supportsColorTemperature:!!ct,colorTemperature:ct && ct.mirek_valid!==false && Number.isInteger(ct.mirek)?ct.mirek:null,mirekMin,mirekMax};
    });
    const normalizedRooms=rooms.map(r=>{
      const service=(r.services||[]).find(x=>x.rtype==='grouped_light');
      const group=service && byGroup.get(service.rid);
      const members=new Set((r.children||[]).filter(x=>x.rtype==='device').map(x=>x.rid));
      return {id:r.id,name:(r.metadata&&r.metadata.name)||'Pièce',on:!!(group&&group.on&&group.on.on),brightness:group&&group.dimming&&Number.isFinite(group.dimming.brightness)?group.dimming.brightness:null,lights:normalizedLights.filter(l=>members.has(l.deviceId)).map(l=>l.id)};
    });
    return {returnValue:true,lights:normalizedLights.map(({deviceId,...x})=>x),rooms:normalizedRooms,scenes:scenes.filter(s=>s.group&&s.group.rtype==='room'&&normalizedRooms.some(r=>r.id===s.group.rid)).map(s=>({id:s.id,name:(s.metadata&&s.metadata.name)||'Scène',roomId:s.group.rid}))};
  }
  async function setLight(payload) {
    const id=safeId(payload&&payload.id), patch=patchFor(payload), c=await credentials();
    if(patch.color || patch.color_temperature) {
      const data=await api(c,'/clip/v2/resource/light/'+id);
      const light=Array.isArray(data.data) && data.data.find(l=>l.id===id);
      if(!light) throw new Error('Lampe introuvable.');
      if(patch.color) {
        if(!light.color) throw new Error('Cette lampe ne prend pas en charge les couleurs.');
        patch.color.xy=clampToGamut(patch.color.xy,normalizedGamut(light.color.gamut));
      }
      if(patch.color_temperature) {
        if(!light.color_temperature) throw new Error('Cette lampe ne prend pas en charge le blanc réglable.');
        const schema=light.color_temperature.mirek_schema;
        if(schema && Number.isInteger(schema.mirek_minimum) && Number.isInteger(schema.mirek_maximum) &&
          (patch.color_temperature.mirek<schema.mirek_minimum || patch.color_temperature.mirek>schema.mirek_maximum)) throw new Error('Température hors plage de cette lampe.');
      }
    }
    await updateResource(c,'light',id,patch); return {returnValue:true};
  }
  // The baseline is returned to the app, not kept in process memory. Downloadable
  // webOS JS services may be stopped between calls; it contains no Hue key.
  async function beginPreview(payload) {
    const id=safeId(payload && payload.id),c=await credentials();
    const [result,connections]=await Promise.all([api(c,'/clip/v2/resource/light/'+id),list(c,'zigbee_connectivity')]);
    const light=Array.isArray(result.data) && result.data.find(l=>l.id===id);
    if(!light || !light.owner || !light.on || typeof light.on.on!=='boolean') throw new Error('État initial de la lampe indisponible.');
    if(!connections.some(x=>x && x.owner && x.owner.rid===light.owner.rid && x.status==='connected')) throw new Error('Lampe injoignable ou état inconnu.');
    const effect=light.effects && light.effects.status;
    const effect2=light.effects_v2 && light.effects_v2.status && light.effects_v2.status.effect;
    if((effect && effect!=='no_effect') || (effect2 && effect2!=='no_effect') ||
       (light.dynamics && light.dynamics.status && light.dynamics.status!=='none') ||
       (light.gradient && Array.isArray(light.gradient.points) && light.gradient.points.length)) throw new Error('Aperçu indisponible pendant un effet animé ou un dégradé.');
    const original={on:light.on.on};
    if(light.dimming) {
      const b=light.dimming.brightness;
      if(typeof b!=='number' || !Number.isFinite(b) || b<1 || b>100) throw new Error('État initial de la lampe indisponible.');
      original.brightness=b;
    }
    const ct=light.color_temperature;
    if(ct && ct.mirek_valid===true && Number.isInteger(ct.mirek) && ct.mirek>0 && ct.mirek<=1000) original.temperature=ct.mirek;
    else if((!ct || ct.mirek_valid===false) && light.color && validXY(light.color.xy)) original.color={x:light.color.xy.x,y:light.color.xy.y};
    else if(light.color || ct) throw new Error('État initial de la couleur indisponible.');
    return {returnValue:true,original};
  }
  async function cancelPreview(payload) {
    const id=safeId(payload&&payload.id),original=payload && payload.original;
    if(!original || typeof original!=='object' || Array.isArray(original) || typeof original.on!=='boolean' ||
       Object.keys(original).some(k=>!['on','brightness','color','temperature'].includes(k))) throw new Error('État initial de la lampe indisponible.');
    // A single update keeps an originally-off lamp off; never wake it merely to
    // restore a cached colour. Some firmware may ignore colour while off, so
    // a subsequent readback is necessary and an unconfirmed restore is retryable.
    const c=await credentials(),patch=patchFor(original);
    await updateResource(c,'light',id,patch);
    for(let attempt=0;attempt<4;attempt++) {
      if(attempt) await new Promise(resolve=>setTimeout(resolve,200));
      const [result,connections]=await Promise.all([api(c,'/clip/v2/resource/light/'+id),list(c,'zigbee_connectivity')]);
      const light=Array.isArray(result.data) && result.data.find(l=>l.id===id);
      if(!light || !light.owner || !connections.some(x=>x && x.owner && x.owner.rid===light.owner.rid && x.status==='connected') || !light.on || light.on.on!==original.on) continue;
      if(original.brightness!==undefined && (!light.dimming || !Number.isFinite(light.dimming.brightness) || Math.abs(light.dimming.brightness-original.brightness)>1)) continue;
      if(original.temperature!==undefined && (!light.color_temperature || light.color_temperature.mirek_valid!==true || !Number.isFinite(light.color_temperature.mirek) || Math.abs(light.color_temperature.mirek-original.temperature)>1)) continue;
      if(original.color && (!light.color || !validXY(light.color.xy) || Math.abs(light.color.xy.x-original.color.x)>0.002 || Math.abs(light.color.xy.y-original.color.y)>0.002 || (light.color_temperature && light.color_temperature.mirek_valid===true))) continue;
      return {returnValue:true};
    }
    throw new Error('Restauration non confirmée. Réessaie.');
  }
  async function setRoom(payload) {
    const id=safeId(payload&&payload.id), patch=patchFor(payload), c=await credentials();
    if(patch.color || patch.color_temperature) throw new Error('Règle la couleur lampe par lampe.');
    const rooms=await list(c,'room'); const room=rooms.find(r=>r.id===id);
    const group=room && (room.services||[]).find(x=>x.rtype==='grouped_light');
    if(!group) throw new Error('Pièce introuvable.');
    await updateResource(c,'grouped_light',safeId(group.rid),patch); return {returnValue:true};
  }
  async function activateScene(payload) {
    const id=safeId(payload&&payload.id),c=await credentials();
    await updateResource(c,'scene',id,{recall:{action:'active'}}); return {returnValue:true};
  }
  async function saveScene(payload) {
    const roomId=safeId(payload && payload.roomId);
    const name=payload && payload.name;
    if(typeof name!=='string' || !name.trim() || [...name.trim()].length>32 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error('Le nom doit contenir entre 1 et 32 caractères.');
    const c=await credentials();
    const [rooms,lights,devices,connections]=await Promise.all(['room','light','device','zigbee_connectivity'].map(x=>list(c,x)));
    const room=rooms.find(r=>r.id===roomId);
    if(!room) throw new Error('Pièce introuvable.');
    if(!Array.isArray(room.children)) throw new Error('La composition de la pièce est indisponible.');
    const byDevice=new Map(devices.map(d=>[d.id,d]));
    const byLight=new Map(lights.map(l=>[l.id,l]));
    const connectivity=new Map(connections.filter(x=>x && x.owner).map(x=>[x.owner.rid,x.status]));
    const targets=[];
    for(const child of room.children) {
      if(!child || child.rtype!=='device') continue;
      const device=byDevice.get(child.rid);
      if(!device || !Array.isArray(device.services)) throw new Error('La composition de la pièce est indisponible.');
      for(const ref of device.services.filter(x=>x && x.rtype==='light')) {
        const light=byLight.get(ref.rid);
        if(!light || !light.owner || light.owner.rid!==device.id || !UUID.test(light.id)) throw new Error('L’état complet des lampes est indisponible.');
        if(connectivity.get(device.id)!=='connected') throw new Error('Impossible d’enregistrer : une lampe est injoignable ou son état est inconnu.');
        targets.push(light);
      }
    }
    if(!targets.length) throw new Error('Aucune lampe à enregistrer dans cette pièce.');
    if(new Set(targets.map(l=>l.id)).size!==targets.length) throw new Error('La composition de la pièce est indisponible.');
    const actions=targets.map(light=>{
      if(!light.on || typeof light.on.on!=='boolean') throw new Error('L’état complet des lampes est indisponible.');
      const v2effect=light.effects_v2 && light.effects_v2.status && light.effects_v2.status.effect;
      const effect=light.effects && light.effects.status;
      if((effect && effect!=='no_effect') || (v2effect && v2effect!=='no_effect') ||
         (light.dynamics && light.dynamics.status && light.dynamics.status!=='none') ||
         (light.gradient && Array.isArray(light.gradient.points) && light.gradient.points.length)) throw new Error('Un effet animé ou un dégradé ne peut pas être enregistré comme ambiance statique.');
      const action={on:{on:light.on.on}};
      if(light.on.on) {
        if(light.dimming) {
          const b=light.dimming.brightness;
          if(typeof b!=='number' || !Number.isFinite(b) || b<=0 || b>100) throw new Error('L’état complet des lampes est indisponible.');
          action.dimming={brightness:b};
        }
        const ct=light.color_temperature;
        if(ct && ct.mirek_valid===true && Number.isInteger(ct.mirek) && ct.mirek>0) action.color_temperature={mirek:ct.mirek};
        else if(light.color && validXY(light.color.xy)) action.color={xy:{x:light.color.xy.x,y:light.color.xy.y}};
        else if(light.color || ct) throw new Error('L’état complet des couleurs est indisponible.');
      }
      return {target:{rid:light.id,rtype:'light'},action};
    });
    const result=await api(c,'/clip/v2/resource/scene','POST',{metadata:{name:name.trim()},group:{rid:roomId,rtype:'room'},actions});
    const created=Array.isArray(result.data) && result.data.find(x=>x && x.rtype==='scene' && UUID.test(x.rid));
    if(!created) throw new Error('Création non confirmée. Vérifie la liste des ambiances.');
    return {returnValue:true,sceneId:created.rid};
  }
  async function automationList(c) {
    const [instances,scripts]=await Promise.all([list(c,'behavior_instance'),list(c,'behavior_script')]);
    const automationScriptIds=new Set(scripts.filter(s=>s && s.metadata && s.metadata.category==='automation' && UUID.test(s.id)).map(s=>s.id));
    // Fail closed: accessory behavior instances may operate switches, sensors,
    // and other hardware and must never be exposed as user automations.
    return instances.filter(i=>i && UUID.test(i.id) && automationScriptIds.has(i.script_id) && typeof i.enabled==='boolean');
  }
  async function automations() {
    const c=await credentials(), instances=await automationList(c);
    return {returnValue:true,automations:instances.map(i=>({id:i.id,name:i.metadata && typeof i.metadata.name==='string'?i.metadata.name:'Automatisation',enabled:i.enabled,status:typeof i.status==='string'?i.status:null}))};
  }
  async function setAutomation(payload) {
    const id=safeId(payload && payload.id);
    if(typeof (payload && payload.enabled)!=='boolean') throw new Error('État invalide.');
    const c=await credentials(), instances=await automationList(c);
    if(!instances.some(i=>i.id===id)) throw new Error('Automatisation introuvable.');
    await updateResource(c,'behavior_instance',id,{enabled:payload.enabled});
    return {returnValue:true};
  }
  return {status,pair,snapshot,setLight,beginPreview,cancelPreview,setRoom,activateScene,saveScene,automations,setAutomation};
}
module.exports={createBackend,createStore,requestBridge,isLocalIP,patchFor,safeId,normalizedGamut,clampToGamut,BRIDGE_ID,DEFAULT_IP};
