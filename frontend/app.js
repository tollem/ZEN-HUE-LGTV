(function () {
  'use strict';
  var main = document.getElementById('main');
  var dot = document.getElementById('connection-dot');
  var connection = document.getElementById('connection-label');
  var updated = document.getElementById('updated');
  var refreshButton = document.getElementById('refresh');
  var toast = document.getElementById('toast');
  var state = { rooms: [], lights: [], scenes: [], automations:[], automationError:'', automationLoading:false, view:'lights', currentRoom: null, colorLight: null, sceneRoom:null, pending: false, paired: false, bridgeReachable: false, lastUpdated: null };
  var toastTimer;
  var exitArmedAt = null;
  var exitHint = 'Appuyez à nouveau sur Retour pour quitter.';
  // A preview session keeps its original state until it is safely restored or kept.
  var wheelDraft = null;
  var wheelSession = null;
  var wheelPointer = null;
  var lastWheelPointerAt = 0;
  var wheelImages = {};
  var demo = /(?:\?|&)demo=1(?:&|$)/.test(location.search);
  var recoveryKey='hue-wheel-recovery'+(demo?'-demo':'');
  var recovery=null, recoveryBusy=false;
  try { var stored=JSON.parse(localStorage.getItem(recoveryKey)||'null'); if(stored&&typeof stored.id==='string'&&stored.original&&typeof stored.original.on==='boolean')recovery=stored; } catch (_) {}

  function demoService(method, args) {
    var lightList = demoService.lights || (demoService.lights = [
      {id:'d1',name:'Lumière principale',on:true,brightness:72,reachable:true,supportsColor:true,supportsColorTemperature:true,mirekMin:153,mirekMax:500},
      {id:'d2',name:'Lampe TV',on:true,brightness:38,reachable:true,supportsColor:true,supportsColorTemperature:false},
      {id:'d3',name:'Lampe de lecture',on:false,brightness:48,reachable:true,supportsColor:false,supportsColorTemperature:true,mirekMin:153,mirekMax:500},
      {id:'d4',name:'Lampe d’appoint',on:false,brightness:50,reachable:false}
    ]);
    var roomList = demoService.rooms || (demoService.rooms = [
      {id:'r1',name:'Salon',lights:['d1','d2','d3']},
      {id:'r2',name:'Chambre',lights:['d4']}
    ]);
    if (method === 'status' || method === 'pair') return Promise.resolve({returnValue:true,paired:true,bridgeReachable:true});
    if (method === 'automations') return Promise.resolve({returnValue:true,automations:demoService.automations||(demoService.automations=[{id:'a1',name:'Lumière du matin',enabled:true,status:'ready'},{id:'a2',name:'Extinction du soir',enabled:false,status:'disabled'}])});
    if (method === 'setAutomation') { (demoService.automations||[]).forEach(function(a){if(a.id===args.id)a.enabled=args.enabled;});return Promise.resolve({returnValue:true}); }
    var sceneList=demoService.scenes||(demoService.scenes=[{id:'sc1',name:'Soirée',roomId:'r1'},{id:'sc2',name:'Lecture',roomId:'r1'}]);
    if (method === 'activateScene') return Promise.resolve({returnValue:true});
    if (method === 'saveScene') { sceneList.push({id:'sc'+(sceneList.length+1),name:args.name,roomId:args.roomId});return Promise.resolve({returnValue:true}); }
    if (method === 'beginPreview') { var original=lightList.find(function(l){return l.id===args.id;}); if(!original)return Promise.reject(new Error('Lampe introuvable.')); return Promise.resolve({returnValue:true,original:JSON.parse(JSON.stringify(original))}); }
    if (method === 'cancelPreview') { var index=lightList.findIndex(function(l){return l.id===args.id;}); if(index<0)return Promise.reject(new Error('Lampe introuvable.')); lightList[index]=JSON.parse(JSON.stringify(args.original)); return Promise.resolve({returnValue:true}); }
    if (method === 'setLight' || method === 'setRoom') {
      var ids = method === 'setRoom' ? (roomList.find(function (r) { return r.id === args.id; }) || {lights:[]}).lights : [args.id];
      lightList.forEach(function (l) { if (ids.indexOf(l.id) >= 0 && l.reachable) { if (typeof args.on === 'boolean') l.on = args.on; if (args.brightness != null) l.brightness = args.brightness; if(args.color)l.colorXy=args.color; if(args.temperature)l.colorTemperature=args.temperature; } });
      return Promise.resolve({returnValue:true});
    }
    return Promise.resolve({returnValue:true,scenes:sceneList,lights:lightList,rooms:roomList.map(function (r) { var members=lightList.filter(function (l) { return r.lights.indexOf(l.id)>=0; }); return {id:r.id,name:r.name,lights:r.lights,on:members.some(function(l){return l.on;}),brightness:members.length?members[0].brightness:0}; })});
  }

  function call(method, params) {
    if (demo) return demoService(method, params || {});
    if (typeof window.PalmServiceBridge !== 'function') return Promise.reject(new Error('Le service Hue n’est pas disponible sur cette TV.'));
    return new Promise(function (resolve, reject) {
      var bridge = new window.PalmServiceBridge();
      // The service can spend up to 8 s sending a change and 21 s restoring it.
      var deadline=method==='cancelPreview'?35000:method==='setLight'?20000:15000;
      var timer = window.setTimeout(function () { try {bridge.cancel();} catch (_) {} reject(new Error('Le pont ne répond pas. Vérifiez sa connexion.')); }, deadline);
      bridge.onservicecallback = function (payload) {
        window.clearTimeout(timer);
        try {
          var result = JSON.parse(payload);
          if (!result.returnValue) reject(new Error(result.errorText || result.error || 'La commande a échoué.'));
          else resolve(result);
        } catch (e) { reject(new Error('Réponse du pont illisible.')); }
      };
      try { bridge.call('luna://com.samuel.huetv.service/' + method, JSON.stringify(params || {})); }
      catch (e) {window.clearTimeout(timer); reject(new Error('Impossible de joindre le service Hue.'));}
    });
  }
  // Ce contrat est aussi utilisable par les tests ou par un autre service webOS.
  window.HueBridge = {status:function(){return call('status');},pair:function(ip){return call('pair',ip?{ip:ip}:{});},snapshot:function(){return call('snapshot');},setLight:function(id,patch){return call('setLight',Object.assign({id:id},patch));},beginPreview:function(id){return call('beginPreview',{id:id});},cancelPreview:function(id,original){return call('cancelPreview',{id:id,original:original});},setRoom:function(id,patch){return call('setRoom',Object.assign({id:id},patch));},activateScene:function(id){return call('activateScene',{id:id});},saveScene:function(roomId,name){return call('saveScene',{roomId:roomId,name:name});},automations:function(){return call('automations');},setAutomation:function(id,enabled){return call('setAutomation',{id:id,enabled:enabled});}};

  function html(s) { return String(s == null ? '' : s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function notify(message, error, duration) {
    toast.textContent = message; toast.style.color = error ? '#ffb8b8' : '#fff'; toast.classList.add('visible');
    window.clearTimeout(toastTimer); toastTimer = window.setTimeout(function(){toast.classList.remove('visible');},duration || 4500);
  }
  function disarmExit() { if(exitArmedAt!==null){exitArmedAt=null;if(toast.textContent===exitHint)toast.classList.remove('visible');} }
  document.addEventListener('click',disarmExit,true);
  function getSelected() { return state.rooms.find(function(r){return r.id === state.currentRoom;}) || null; }
  function roomLights(room) { var ids=(room && Array.isArray(room.lights))?room.lights:[]; return state.lights.filter(function(l){return ids.indexOf(l.id)>=0;}); }
  function hasWhitePreset(l) {var min=Number(l.mirekMin),max=Number(l.mirekMax);return !!l.supportsColorTemperature && Number.isInteger(min) && Number.isInteger(max) && min>0 && max>=min;}
  // Hue's colour API uses CIE xy; convert sRGB values from the palette and the colour field.
  function hexToXy(hex) {
    if(!/^#[0-9a-f]{6}$/i.test(hex))throw new Error('Choisissez une couleur valide.');
    var rgb=[1,3,5].map(function(i){var v=parseInt(hex.slice(i,i+2),16)/255;return v>0.04045?Math.pow((v+0.055)/1.055,2.4):v/12.92;});
    var x=rgb[0]*0.664511+rgb[1]*0.154324+rgb[2]*0.162028;
    var y=rgb[0]*0.283881+rgb[1]*0.668433+rgb[2]*0.047685;
    var z=rgb[0]*0.000088+rgb[1]*0.072310+rgb[2]*0.986039;
    var sum=x+y+z;if(sum<0.000001)throw new Error('Le noir ne peut pas être utilisé comme couleur lumineuse.');
    return {x:Number((x/sum).toFixed(6)),y:Number((y/sum).toFixed(6))};
  }
  function hsvRgb(h,s) {
    var sector=Math.floor(h*6), f=h*6-sector, p=1-s, q=1-f*s, t=1-(1-f)*s;
    return [[1,t,p],[q,1,p],[p,1,t],[p,q,1],[t,p,1],[1,p,q]][sector%6].map(function(v){return Math.round(v*255);});
  }
  function rgbHex(rgb) { return '#'+rgb.map(function(v){return Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0');}).join(''); }
  function wheelHex(x,y) {
    var radius=Math.min(1,Math.sqrt(x*x+y*y)),h=(Math.atan2(y,x)/(2*Math.PI)+1)%1;
    return rgbHex(hsvRgb(h,radius));
  }
  // Approximate display colour for colour temperature; the bridge receives
  // the exact mirek selected within this particular lamp's range.
  function temperatureRgb(kelvin) {
    var t=kelvin/100,r=t<=66?255:329.698727446*Math.pow(t-60,-0.1332047592);
    var g=t<=66?99.4708025861*Math.log(t)-161.1195681661:288.1221695283*Math.pow(t-60,-0.0755148492);
    var b=t>=66?255:t<=19?0:138.5177312231*Math.log(t-10)-305.0447927307;
    return [r,g,b].map(function(v){return Math.round(Math.max(0,Math.min(255,v)));});
  }
  function temperatureFor(light,x) {
    return Math.round(light.mirekMax-(x+1)/2*(light.mirekMax-light.mirekMin));
  }
  function paintWheel(button,light) {
    var canvas=button.querySelector('canvas'),context=canvas.getContext('2d'),size=canvas.width;
    var kind=button.getAttribute('data-wheel'),cacheKey=kind+':'+size+(kind==='temperature'?':'+light.mirekMin+':'+light.mirekMax:'');
    if(wheelImages[cacheKey]){context.putImageData(wheelImages[cacheKey],0,0);return;}
    var pixels=context.createImageData(size,size),data=pixels.data,temperatures=[];
    if(kind==='temperature')for(var tx=0;tx<size;tx++)temperatures[tx]=temperatureRgb(1000000/temperatureFor(light,(tx+.5-size/2)/(size/2)));
    for(var y=0;y<size;y++)for(var x=0;x<size;x++) {
      var dx=(x+.5-size/2)/(size/2),dy=(y+.5-size/2)/(size/2),distance=Math.sqrt(dx*dx+dy*dy),i=(y*size+x)*4;
      if(distance>1)continue;
      var rgb=kind==='color'?hsvRgb((Math.atan2(dy,dx)/(2*Math.PI)+1)%1,distance):temperatures[x];
      data[i]=rgb[0];data[i+1]=rgb[1];data[i+2]=rgb[2];data[i+3]=255;
    }
    wheelImages[cacheKey]=pixels;
    context.putImageData(pixels,0,0);
  }
  function paintWheels() {
    var light=state.lights.find(function(l){return l.id===state.colorLight;});
    if(!light)return;
    Array.prototype.forEach.call(main.querySelectorAll('.wheel'),function(button){paintWheel(button,light);});
    updateWheelSelection();
  }
  function limitPoint(x,y) {
    var radius=Math.sqrt(x*x+y*y);
    return radius>1?{x:x/radius,y:y/radius}:{x:x,y:y};
  }
  function updateWheelSelection() {
    if(!wheelDraft || !wheelSession)return;
    var tx=wheelSession, light=state.lights.find(function(l){return l.id===state.colorLight;}), selected=document.getElementById('wheel-selection');
    Array.prototype.forEach.call(main.querySelectorAll('.wheel'),function(button){
      var kind=button.getAttribute('data-wheel'),marker=button.querySelector('.wheel-marker'),active=wheelDraft.kind===kind;
      button.disabled=tx.phase!=='ready';
      button.classList.toggle('editing',wheelDraft.editing===kind);
      marker.hidden=!active;
      if(active){marker.style.left=((wheelDraft.x+1)*50)+'%';marker.style.top=((wheelDraft.y+1)*50)+'%';}
    });
    var apply=main.querySelector('[data-action="apply-wheel"]'), close=main.querySelector('[data-action="close-color"]');
    if(apply)apply.disabled=tx.phase!=='ready'||!tx.latestPatch;
    if(close){close.disabled=tx.phase==='canceling'||tx.phase==='committing';close.textContent=tx.phase==='cancelFailed'?'Réessayer l’annulation':'Annuler';}
    if(!selected||!light)return;
    if(tx.phase==='loading')selected.textContent='Préparation de l’aperçu…';
    else if(tx.phase==='canceling')selected.textContent='Rétablissement de la lampe…';
    else if(tx.phase==='committing')selected.textContent='Enregistrement du choix…';
    else if(tx.phase==='cancelFailed')selected.textContent='La lampe n’a pas pu être rétablie. Réessayez l’annulation.';
    else if(tx.phase==='beginFailed')selected.textContent=tx.error;
    else if(tx.error)selected.textContent='Aperçu non confirmé : '+tx.error;
    else if(wheelDraft.editing&&!wheelDraft.hasSelection)selected.textContent='Déplacez le curseur pour voir l’aperçu';
    else if(wheelDraft.kind==='color')selected.textContent='Couleur choisie : '+wheelHex(wheelDraft.x,wheelDraft.y).toUpperCase();
    else if(wheelDraft.kind==='temperature')selected.textContent='Blanc choisi : '+Math.round(1000000/temperatureFor(light,wheelDraft.x))+' K';
    else selected.textContent='Choisissez un disque pour commencer';
    var hint=document.getElementById('wheel-hint');
    if(hint)hint.textContent=wheelDraft.editing?'Flèches pour ajuster en direct · OK pour conserver · Retour pour annuler':'Choisissez sur un disque ou appuyez sur OK pour le régler. Appliquer conserve le choix ; Retour annule.';
  }
  function wheelPatch() {
    var light=state.lights.find(function(l){return l.id===state.colorLight;});
    if(!light||!wheelDraft||!wheelDraft.kind)return null;
    return wheelDraft.kind==='color'?{on:true,color:hexToXy(wheelHex(wheelDraft.x,wheelDraft.y))}:{on:true,temperature:temperatureFor(light,wheelDraft.x)};
  }
  function sendPreview(tx, patch) {
    tx.lastSent=Date.now();tx.dirty=true;
    tx.inFlight=window.HueBridge.setLight(tx.id,patch).then(function(){tx.error='';return true;},function(e){tx.error=e.message||'La commande a échoué.';return false;}).then(function(ok){
      tx.inFlight=null; if(wheelSession===tx){updateWheelSelection();if(tx.phase==='ready')pumpPreview(tx);} return ok;
    });
    return tx.inFlight;
  }
  function pumpPreview(tx) {
    if(wheelSession!==tx||tx.phase!=='ready'||tx.inFlight||!tx.pending||tx.timer)return;
    var delay=Math.max(0,350-(Date.now()-tx.lastSent));
    if(delay){tx.timer=window.setTimeout(function(){tx.timer=null;pumpPreview(tx);},delay);return;}
    var patch=tx.pending;tx.pending=null;sendPreview(tx,patch);
  }
  function queuePreview() {
    var tx=wheelSession;if(!tx||tx.phase!=='ready')return;
    wheelDraft.hasSelection=true;tx.latestPatch=wheelPatch();tx.pending=tx.latestPatch;updateWheelSelection();pumpPreview(tx);
  }
  function closeWheel(tx, message) {
    if(wheelSession!==tx)return;
    try {localStorage.removeItem(recoveryKey);} catch (_) {tx.phase=message?'ready':'cancelFailed';tx.error='Impossible d’effacer le rappel de restauration.';updateWheelSelection();notify(tx.error,true);return;}
    var id=tx.id;wheelSession=null;wheelDraft=null;state.colorLight=null;refreshButton.disabled=false;
    load().then(function(){restoreFocus('color:'+id);if(message)notify(message,false);});
  }
  function startWheel(id) {
    state.colorLight=id;wheelDraft={kind:null,x:0,y:0,editing:null,hasSelection:false};
    var tx=wheelSession={id:id,phase:'loading',original:null,pending:null,inFlight:null,timer:null,lastSent:0,dirty:false,error:''};
    refreshButton.disabled=true;render();updateWheelSelection();
    tx.begin=window.HueBridge.beginPreview(id).then(function(r){
      tx.original=r.original;
      if(!tx.original)throw new Error('Impossible de mémoriser l’état initial.');
      try {localStorage.setItem(recoveryKey,JSON.stringify({id:tx.id,original:tx.original}));} catch (_) {tx.original=null;throw new Error('Impossible de sauvegarder l’état initial sur la TV.');}
      if(tx.phase==='loading'){tx.phase='ready';updateWheelSelection();var first=main.querySelector('.wheel');if(first)first.focus();}
    }).catch(function(e){tx.error=e.message||'Impossible de mémoriser l’état initial.';if(tx.phase==='loading'){tx.phase='beginFailed';updateWheelSelection();var close=main.querySelector('[data-action="close-color"]');if(close)close.focus();}});
  }
  function cancelWheel() {
    var tx=wheelSession;if(!tx||tx.phase==='canceling'||tx.phase==='committing')return;
    tx.phase='canceling';tx.pending=null;wheelPointer=null;if(tx.timer){window.clearTimeout(tx.timer);tx.timer=null;}updateWheelSelection();
    Promise.resolve(tx.begin).then(function(){return tx.inFlight;}).then(function(){
      if(!tx.original||!tx.dirty)return;return window.HueBridge.cancelPreview(tx.id,tx.original);
    }).then(function(){closeWheel(tx);}).catch(function(e){tx.phase='cancelFailed';tx.error=e.message||'Impossible de rétablir la lampe.';updateWheelSelection();var close=main.querySelector('[data-action="close-color"]');if(close)close.focus();notify('Rétablissement impossible : '+tx.error,true);});
  }
  function applyWheel() {
    var tx=wheelSession;if(!tx||tx.phase!=='ready')return;
    if(!tx.latestPatch){cancelWheel();return;}
    tx.phase='committing';wheelPointer=null;if(tx.timer){window.clearTimeout(tx.timer);tx.timer=null;}updateWheelSelection();
    Promise.resolve(tx.inFlight).then(function(){
      var patch=tx.pending||(tx.error?tx.latestPatch:null);tx.pending=null;
      if(!patch)return !tx.error;
      var wait=Math.max(0,350-(Date.now()-tx.lastSent));
      return new Promise(function(resolve){window.setTimeout(resolve,wait);}).then(function(){return sendPreview(tx,patch);});
    }).then(function(ok){
      if(ok===false||tx.error){tx.phase='ready';updateWheelSelection();notify('Le choix n’a pas pu être confirmé. Réessayez ou annulez.',true);return;}
      closeWheel(tx,'Couleur conservée');
    });
  }
  function selectWheelPoint(button, clientX, clientY, clamp) {
    if(!wheelSession||wheelSession.phase!=='ready')return;
    var rect=button.getBoundingClientRect(),x=(clientX-rect.left)/rect.width*2-1,y=(clientY-rect.top)/rect.height*2-1;
    if(!clamp&&Math.sqrt(x*x+y*y)>1)return;
    var point=limitPoint(x,y);wheelDraft.kind=button.getAttribute('data-wheel');wheelDraft.x=point.x;wheelDraft.y=point.y;wheelDraft.editing=null;queuePreview();
  }
  function colorDialog() {
    var l=state.lights.find(function(item){return item.id===state.colorLight;});
    if(!l)return '';
    var colour=l.supportsColor?'<div class="wheel-column"><h3>Couleur</h3><button class="wheel" type="button" data-action="pick-wheel" data-wheel="color" data-focus="wheel:color" aria-label="Disque des couleurs"><canvas width="360" height="360" aria-hidden="true"></canvas><span class="wheel-marker" aria-hidden="true"></span></button><p class="wheel-description">Du blanc au centre aux couleurs vives sur le bord</p></div>':'';
    var white=hasWhitePreset(l)?'<div class="wheel-column"><h3>Température du blanc</h3><button class="wheel" type="button" data-action="pick-wheel" data-wheel="temperature" data-focus="wheel:temperature" aria-label="Disque de température du blanc"><canvas width="360" height="360" aria-hidden="true"></canvas><span class="wheel-marker" aria-hidden="true"></span></button><div class="wheel-extremes"><span>Chaud</span><span>Froid</span></div></div>':'';
    if(!colour&&!white)return '';
    return '<div class="color-overlay"><section class="color-dialog" role="dialog" aria-modal="true" aria-labelledby="color-title"><div class="color-header"><div><h2 id="color-title">'+html(l.name)+'</h2><p>'+ (colour?'Choisissez une couleur ou un blanc':'Choisissez une teinte de blanc') +'</p></div><button class="soft-button" type="button" data-action="close-color" data-focus="close-color">Annuler</button></div><div class="wheels">'+colour+white+'</div><div class="wheel-footer"><div><p class="wheel-selection" id="wheel-selection" aria-live="polite">Aucun choix pour le moment</p><p class="color-hint" id="wheel-hint">Pointeur : choisissez sur un disque puis appliquez. Télécommande : OK pour régler, flèches pour déplacer, OK pour appliquer.</p></div><button class="pill" type="button" data-action="apply-wheel" data-focus="apply-wheel" disabled>Appliquer</button></div><p class="wheel-note">L’aperçu allume la lampe ; Annuler rétablit son état initial. Les couleurs affichées sont indicatives.</p></section></div>';
  }
  function recoveryDialog() {
    if(!recovery)return '';
    var light=state.lights.find(function(l){return l.id===recovery.id;});
    return '<div class="color-overlay"><section class="color-dialog scene-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title"><div class="color-header"><div><h2 id="recovery-title">Réglage interrompu</h2><p>'+html(light?light.name:'Une lampe')+'</p></div></div><p class="color-caption">Un réglage a été interrompu. Vous pouvez rétablir l’état enregistré avant le réglage ou garder l’état actuel de la lampe.</p><div class="scene-dialog-actions"><button class="soft-button" type="button" data-action="recovery-keep" data-focus="recovery-keep">Garder l’état actuel</button><button class="pill" type="button" data-action="recovery-restore" data-focus="recovery-restore">Rétablir l’état précédent</button></div><p class="scene-error" id="recovery-error" aria-live="polite"></p></section></div>';
  }
  function clearRecovery() {
    try {localStorage.removeItem(recoveryKey);} catch (_) {document.getElementById('recovery-error').textContent='Impossible d’effacer le rappel. Réessayez.';return false;}
    recovery=null;refreshButton.disabled=false;render();return true;
  }
  function sceneDialog() {
    var room=state.rooms.find(function(r){return r.id===state.sceneRoom;});if(!room)return '';
    return '<div class="color-overlay"><section class="color-dialog scene-dialog" role="dialog" aria-modal="true" aria-labelledby="save-scene-title"><div class="color-header"><div><h2 id="save-scene-title">Enregistrer une ambiance</h2><p>'+html(room.name)+'</p></div><button class="soft-button" type="button" data-action="close-scene" data-focus="close-scene">Fermer</button></div><p class="color-caption">L’état actuel des lampes sera enregistré comme une ambiance statique.</p><label class="field-label" for="scene-name">Nom de l’ambiance (32 caractères maximum)</label><input class="field" type="text" id="scene-name" maxlength="32" autocomplete="off" placeholder="Par exemple : Soirée cinéma"><div class="scene-dialog-actions"><button class="pill" type="button" data-action="save-scene" data-focus="save-scene">Enregistrer</button></div><p class="scene-error" id="scene-error" aria-live="polite"></p></section></div>';
  }
  function renderAutomations() {
    var focused=rememberFocus();
    var list=state.automationLoading?'<div class="empty">Chargement des automatisations…</div>':state.automationError?'<div class="empty">'+html(state.automationError)+' <button class="text-button" type="button" data-action="retry-automations" data-focus="retry-automations">Réessayer</button></div>':state.automations.length?state.automations.map(function(a){return '<div class="automation-row"><div><div class="light-name">'+html(a.name)+'</div><div class="light-detail">'+(a.enabled?'Activée':'Désactivée')+'</div></div><button type="button" class="soft-button '+(a.enabled?'on':'')+'" data-action="automation-toggle" data-id="'+html(a.id)+'" data-enabled="'+(!a.enabled)+'" data-focus="automation:'+html(a.id)+'">'+(a.enabled?'Désactiver':'Activer')+'</button></div>';}).join(''):'<div class="empty">Aucune automatisation Hue disponible sur ce pont.</div>';
    main.innerHTML='<div class="heading"><div><h1>Automatisations</h1><p>Activez ou désactivez les automatisations existantes du pont Hue.</p></div><button type="button" class="pill" data-action="show-lights" data-focus="show-lights">Lumières</button></div><section class="pane automation-pane"><div class="pane-heading"><h2>Vos automatisations</h2><span class="count">'+(state.automationLoading?'':state.automations.length)+'</span></div><div class="automation-list">'+list+'</div><p class="automation-hint">Pour modifier les horaires ou créer une automatisation, utilisez l’application Hue.</p></section>';
    restoreFocus(focused||'show-lights');
  }
  function loadAutomations() {
    state.automationLoading=true;state.automationError='';renderAutomations();
    return window.HueBridge.automations().then(function(r){state.automations=Array.isArray(r.automations)?r.automations:[];}).catch(function(e){state.automationError=e.message;}).finally(function(){state.automationLoading=false;if(state.view==='automations')renderAutomations();});
  }
  function rememberFocus() { var a=document.activeElement; return a && a.getAttribute ? a.getAttribute('data-focus') : null; }
  function restoreFocus(key) { var options=Array.prototype.slice.call(document.querySelectorAll('[data-focus]')); var found=options.find(function(e){return e.getAttribute('data-focus')===key;}); if(found) found.focus({preventScroll:true}); }
  function setupView(msg, pairable) {
    dot.className='connection-dot'+(pairable?'':' error'); connection.textContent=pairable?'Association requise':'Pont indisponible'; refreshButton.disabled=false;
    main.innerHTML='<section class="setup"><div><h1>La lumière,<br>à portée de main.</h1><p>Retrouvez vos pièces et commandez vos lampes depuis la télécommande.</p></div><div class="setup-panel"><h2>Connecter le pont Hue</h2><p>Appuyez sur le bouton de votre pont Hue, puis sélectionnez « Associer » dans la minute.</p><label class="field-label" for="bridge-ip">Adresse du pont</label><input class="field" id="bridge-ip" type="text" inputmode="decimal" value="192.168.1.100" autocomplete="off" spellcheck="false"><button class="pill" type="button" id="pair">Associer</button><div class="message" id="setup-message">'+html(msg||'')+'</div></div></section>';
    document.getElementById('pair').onclick = function(){
      var ip=document.getElementById('bridge-ip').value.trim();
      if(!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split('.').some(function(n){return Number(n)>255;})){document.getElementById('setup-message').textContent='Saisissez une adresse IP valide.';return;}
      var btn=this; btn.disabled=true; btn.textContent='Association…'; document.getElementById('setup-message').textContent='';
      window.HueBridge.pair(ip).then(function(){state.paired=true;return load();}).catch(function(e){setupView(e.message,true);document.getElementById('pair').focus();});
    };
    document.getElementById('pair').focus();
  }
  function render() {
    if(state.view==='automations'){renderAutomations();return;}
    var focus=rememberFocus(); var rooms=state.rooms; var all=state.lights; var selected=getSelected();
    if (!selected && state.currentRoom!=='__other__' && rooms.length){ state.currentRoom=rooms[0].id; selected=rooms[0]; }
    var assigned = {}; rooms.forEach(function(r){(r.lights||[]).forEach(function(id){assigned[id]=true;});});
    var unassigned=all.filter(function(l){return !assigned[l.id];});
    var virtual = state.currentRoom === '__other__';
    var lights = virtual ? unassigned : roomLights(selected);
    var currentTitle = virtual ? 'Autres lumières' : (selected ? selected.name : 'Vos lumières');
    if (!selected && !virtual) lights=all;
    var reachable=all.filter(function(l){return l.reachable === true;});
    var unknown=all.filter(function(l){return l.reachable !== true && l.reachable !== false;}).length;
    var lit=reachable.filter(function(l){return l.on;}).length;
    var allOn=all.some(function(l){return l.reachable!==false && l.on;});
    var list=rooms.map(function(r){var group=roomLights(r); var count=group.filter(function(l){return l.on && l.reachable!==false;}).length; return '<button class="room '+(r.id===state.currentRoom?'selected':'')+'" type="button" data-action="room" data-id="'+html(r.id)+'" data-focus="room:'+html(r.id)+'"><span class="room-name">'+html(r.name)+'</span><span class="room-state">'+count+' / '+group.length+' allumée'+(count===1?'':'s')+'</span></button>';}).join('');
    if(unassigned.length) list+='<button class="room '+(virtual?'selected':'')+'" type="button" data-action="room" data-id="__other__" data-focus="room:__other__"><span class="room-name">Autres lumières</span><span class="room-state">'+unassigned.length+'</span></button>';
    if (!rooms.length && !unassigned.length) list='<div class="empty">Aucune pièce trouvée sur ce pont.</div>';
    var selectedOn=lights.some(function(l){return l.on && l.reachable!==false;});
    var summary=selected && !virtual ? '<div class="summary"><div><div class="summary-name">'+html(currentTitle)+'</div><div class="summary-state">'+lights.length+' lumière'+(lights.length===1?'':'s')+'</div></div><button class="soft-button '+(selectedOn?'on':'')+'" data-action="room-power" data-id="'+html(selected.id)+'" data-on="'+(!selectedOn)+'" data-focus="room-power">'+(selectedOn?'Tout éteindre':'Tout allumer')+'</button></div>' : '<div class="summary"><div><div class="summary-name">'+html(currentTitle)+'</div><div class="summary-state">Lampes détectées sur le pont</div></div></div>';
    var rows=lights.map(function(l){var avail=l.reachable!==false;var bright=Math.max(1,Math.min(100,Math.round(Number(l.brightness)||1)));var colour=(l.supportsColor||hasWhitePreset(l))?'<button class="soft-button color-button" type="button" data-action="open-color" data-id="'+html(l.id)+'" data-focus="color:'+html(l.id)+'" '+(!avail?'disabled':'')+' aria-label="Modifier la couleur de '+html(l.name)+'">Couleur</button>':''; return '<div class="light-row"><div><div class="light-name">'+html(l.name)+'</div><div class="light-detail">'+(!avail?'Injoignable':l.reachable!==true?'État de connexion inconnu':(l.on?'Allumée':'Éteinte'))+'</div></div><div class="brightness"><button class="round" type="button" aria-label="Réduire la luminosité de '+html(l.name)+'" data-action="brightness" data-id="'+html(l.id)+'" data-value="'+Math.max(1,bright-10)+'" data-focus="minus:'+html(l.id)+'" '+(!avail||!l.on||l.supportsDimming===false?'disabled':'')+'>−</button><span class="brightness-value">'+(avail&&l.on&&l.supportsDimming!==false?bright+' %':'—')+'</span><button class="round" type="button" aria-label="Augmenter la luminosité de '+html(l.name)+'" data-action="brightness" data-id="'+html(l.id)+'" data-value="'+Math.min(100,bright+10)+'" data-focus="plus:'+html(l.id)+'" '+(!avail||!l.on||l.supportsDimming===false?'disabled':'')+'>+</button></div><div class="light-actions">'+colour+'<button class="soft-button '+(l.on?'on':'')+'" type="button" data-action="light-power" data-id="'+html(l.id)+'" data-on="'+(!l.on)+'" data-focus="light:'+html(l.id)+'" '+(!avail?'disabled':'')+'>'+(l.on?'Éteindre':'Allumer')+'</button></div></div>';}).join('');
    if(!rows)rows='<div class="empty">Aucune lumière dans cette pièce.</div>';
    var scenes = selected ? state.scenes.filter(function(scene){return scene.roomId===selected.id;}) : [];
    if(selected&&!virtual){var canSave=lights.length>0&&lights.every(function(l){return l.reachable===true;});rows+='<div class="scenes"><div class="scenes-header"><h3>Ambiances</h3><button type="button" class="soft-button" data-action="open-scene" data-id="'+html(selected.id)+'" data-focus="open-scene" '+(!canSave?'disabled':'')+'>Enregistrer l’éclairage</button></div>'+(canSave?'':'<p class="hint">Toutes les lampes doivent être joignables et leur connexion confirmée pour enregistrer une ambiance.</p>')+'<div class="scenes-list">'+(scenes.length?scenes.map(function(scene){return '<button class="scene" type="button" data-action="scene" data-id="'+html(scene.id)+'" data-focus="scene:'+html(scene.id)+'">'+html(scene.name)+'</button>';}).join(''):'<p class="hint">Aucune ambiance enregistrée dans cette pièce.</p>')+'</div></div>';}
    main.innerHTML='<div class="heading"><div><h1>Votre éclairage</h1><p>'+lit+' lumière'+(lit===1?'':'s')+' allumée'+(lit===1?'':'s')+' · '+reachable.length+' joignable'+(reachable.length===1?'':'s')+(unknown?' · '+unknown+' connexion'+(unknown===1?'':'s')+' inconnue'+(unknown===1?'':'s'):'')+'</p></div><div class="heading-actions"><button class="soft-button" type="button" data-action="show-automations" data-focus="show-automations">Automatisations</button><button class="pill" type="button" data-action="all-power" data-on="'+(!allOn)+'" data-focus="all-power" '+(!all.some(function(l){return l.reachable!==false;})?'disabled':'')+'>'+(allOn?'Tout éteindre':'Tout allumer')+'</button></div></div><div class="layout"><section class="pane"><div class="pane-heading"><h2>Pièces</h2><span class="count">'+rooms.length+'</span></div><div class="room-list">'+list+'</div></section><section class="pane"><div class="pane-heading"><h2>Lumières</h2><span class="count">'+html(currentTitle)+'</span></div>'+summary+'<div class="light-list">'+rows+'</div></section></div>'+colorDialog()+sceneDialog()+recoveryDialog();
    if(state.colorLight)paintWheels();
    dot.className='connection-dot ok';connection.textContent=demo?'Aperçu de démonstration':'Pont connecté';
    if (state.lastUpdated) updated.textContent='Mis à jour à '+state.lastUpdated;
    if(recovery){refreshButton.disabled=true;restoreFocus('recovery-restore');}
    else restoreFocus(focus || (selected?'room:'+selected.id:'all-power'));
  }
  function load() {
    refreshButton.disabled=true; connection.textContent='Actualisation…';
    return window.HueBridge.snapshot().then(function(result){state.rooms=Array.isArray(result.rooms)?result.rooms:[];state.lights=Array.isArray(result.lights)?result.lights:[];state.scenes=Array.isArray(result.scenes)?result.scenes:[];state.paired=true;state.bridgeReachable=true;state.lastUpdated=new Date().toLocaleTimeString('fr-CH',{hour:'2-digit',minute:'2-digit'});refreshButton.disabled=false;render();return true;}).catch(function(e){refreshButton.disabled=false;dot.className='connection-dot error';connection.textContent='Pont indisponible';if(state.rooms.length||state.lights.length){notify(e.message,true);}else{setupView(e.message,false);}return false;});
  }
  function action(promise, success) {
    if(state.pending)return;state.pending=true;
    promise.then(function(){return load();}).then(function(loaded){if(loaded && success)notify(success,false);}).catch(function(e){notify(e.message,true);}).finally(function(){state.pending=false;});
  }
  main.addEventListener('click', function(e){
    var b=e.target.closest('button[data-action]');if(!b||b.disabled)return;
    var kind=b.getAttribute('data-action');var id=b.getAttribute('data-id');
    if(recovery){
      if(recoveryBusy)return;
      if(kind==='recovery-keep'){clearRecovery();return;}
      if(kind==='recovery-restore'){
        recoveryBusy=true;var buttons=main.querySelectorAll('[data-action^="recovery-"]');Array.prototype.forEach.call(buttons,function(item){item.disabled=true;});
        document.getElementById('recovery-error').textContent='Rétablissement en cours…';
        window.HueBridge.cancelPreview(recovery.id,recovery.original).then(function(){if(clearRecovery())return load();}).catch(function(e){document.getElementById('recovery-error').textContent='Rétablissement impossible : '+e.message;}).finally(function(){recoveryBusy=false;Array.prototype.forEach.call(buttons,function(item){item.disabled=false;});});return;
      }
      return;
    }
    if(state.colorLight && ['close-color','pick-wheel','apply-wheel'].indexOf(kind)<0)return;
    if(kind==='show-automations'){state.view='automations';loadAutomations();return;}
    if(kind==='show-lights'){state.view='lights';render();restoreFocus('show-automations');return;}
    if(kind==='retry-automations'){loadAutomations();return;}
    if(kind==='automation-toggle') {if(state.pending)return;state.pending=true;window.HueBridge.setAutomation(id,b.getAttribute('data-enabled')==='true').then(function(){return loadAutomations();}).then(function(){restoreFocus('automation:'+id);}).catch(function(e){notify(e.message,true);}).finally(function(){state.pending=false;});return;}
    if(kind==='room'){state.currentRoom=id;state.colorLight=null;render();return;}
    if(kind==='open-color'){if(!state.pending)startWheel(id);return;}
    if(kind==='close-color'){cancelWheel();return;}
    if(kind==='pick-wheel'){
      // Pointer events handle dragging; click is a fallback for devices without them.
      if(e.detail && Date.now()-lastWheelPointerAt>600)selectWheelPoint(b,e.clientX,e.clientY,false);
      return;
    }
    if(kind==='apply-wheel'){applyWheel();return;}
    if(kind==='open-scene'){state.sceneRoom=id;render();document.getElementById('scene-name').focus();return;}
    if(kind==='close-scene'){state.sceneRoom=null;render();restoreFocus('open-scene');return;}
    if(state.pending)return;
    if(kind==='save-scene'){
      var name=document.getElementById('scene-name').value.trim(),error=document.getElementById('scene-error');
      if(!name){error.textContent='Choisissez un nom pour cette ambiance.';return;}
      state.pending=true;b.disabled=true;window.HueBridge.saveScene(state.sceneRoom,name).then(function(){state.sceneRoom=null;return load();}).then(function(ok){if(ok){restoreFocus('open-scene');notify('Ambiance enregistrée',false);}}).catch(function(e){error.textContent=e.message;b.disabled=false;}).finally(function(){state.pending=false;});return;
    }
    if(kind==='room-power'){action(window.HueBridge.setRoom(id,{on:b.getAttribute('data-on')==='true'}));return;}
    if(kind==='light-power'){action(window.HueBridge.setLight(id,{on:b.getAttribute('data-on')==='true'}));return;}
    if(kind==='scene'){action(window.HueBridge.activateScene(id));return;}
    if(kind==='brightness'){action(window.HueBridge.setLight(id,{brightness:Number(b.getAttribute('data-value'))}));return;}
    if(kind==='all-power'){
      var target=b.getAttribute('data-on')==='true';var list=state.lights.filter(function(l){return l.reachable!==false;});
      var failures=0;var skipped=state.lights.length-list.length;state.pending=true;
      // Each request settles independently: an unavailable light must not block the rest.
      var job=list.reduce(function(p,l){return p.then(function(){return Promise.resolve().then(function(){return window.HueBridge.setLight(l.id,{on:target});}).catch(function(){failures++;});});},Promise.resolve());
      job.then(function(){return load();}).then(function(loaded){
        var succeeded=list.length-failures;
        var suffix=loaded?'':' État non actualisé.';
        var skippedText=skipped?' '+skipped+' lumière'+(skipped===1?'':'s')+' injoignable'+(skipped===1?'':'s')+' non commandée'+(skipped===1?'':'s')+'.':'';
        if(failures){notify(failures+' échec'+(failures===1?'':'s')+' sur '+list.length+' ; '+succeeded+' commande'+(succeeded===1?'':'s')+' réussie'+(succeeded===1?'':'s')+'.'+skippedText+suffix,true);}
        else if(skipped){notify(list.length+' commande'+(list.length===1?'':'s')+' réussie'+(list.length===1?'':'s')+'.'+skippedText+suffix,true);}
        else if(loaded){notify(target?'Lumières allumées':'Lumières éteintes',false);}
        else{notify(list.length+' commandes envoyées.'+suffix,true);}
      }).catch(function(e){notify(e.message,true);}).finally(function(){state.pending=false;});
    }
  });
  main.addEventListener('pointerdown',function(e){
    var button=e.target.closest('.wheel');if(!button||button.disabled||e.button!==0)return;
    var rect=button.getBoundingClientRect(),x=(e.clientX-rect.left)/rect.width*2-1,y=(e.clientY-rect.top)/rect.height*2-1;
    if(x*x+y*y>1)return;
    wheelPointer={id:e.pointerId,button:button};lastWheelPointerAt=Date.now();button.focus();
    try{button.setPointerCapture(e.pointerId);}catch(_){}
    selectWheelPoint(button,e.clientX,e.clientY,false);e.preventDefault();
  });
  main.addEventListener('pointermove',function(e){if(wheelPointer&&wheelPointer.id===e.pointerId)selectWheelPoint(wheelPointer.button,e.clientX,e.clientY,true);});
  main.addEventListener('pointerup',function(e){if(wheelPointer&&wheelPointer.id===e.pointerId)wheelPointer=null;});
  main.addEventListener('pointercancel',function(e){if(wheelPointer&&wheelPointer.id===e.pointerId)wheelPointer=null;});
  refreshButton.onclick=function(){if(state.colorLight||recovery)return;if(state.paired){if(state.view==='automations')loadAutomations();else load();}else initialize();};
  function initialize(){window.HueBridge.status().then(function(r){state.paired=!!r.paired;state.bridgeReachable=!!r.bridgeReachable;if(!r.paired){setupView(r.bridgeReachable?'':'Pont non détecté. Vérifiez son adresse et sa connexion.',!!r.bridgeReachable);}else{return load();}}).catch(function(e){setupView(e.message,false);});}
  // Navigation spatiale des flèches : choisit la commande visible la plus proche dans la direction.
  window.addEventListener('keydown',function(e){
    var arrowKey=({37:'ArrowLeft',38:'ArrowUp',39:'ArrowRight',40:'ArrowDown'})[e.keyCode]||e.key;
    var active=document.activeElement;
    var isBack=e.keyCode===461||e.key==='Escape'||(e.key==='Backspace' && !(active && (active.tagName==='INPUT'||active.tagName==='TEXTAREA'||active.isContentEditable)));
    if(isBack){
      e.preventDefault();
      if(e.repeat)return;
      if(recovery){disarmExit();return;}
      if(state.colorLight){disarmExit();cancelWheel();return;}
      if(state.sceneRoom){disarmExit();state.sceneRoom=null;render();restoreFocus('open-scene');return;}
      if(state.view==='automations'){disarmExit();state.view='lights';render();restoreFocus('show-automations');return;}
      if(e.keyCode===461){
        var now=Date.now();
        if(exitArmedAt!==null && now-exitArmedAt<=2500){disarmExit();if(window.webOS && typeof window.webOS.platformBack==='function')window.webOS.platformBack();}
        else {exitArmedAt=now;notify(exitHint,false,2500);}
      }
      return;
    }
    disarmExit();
    var wheel=state.colorLight&&active&&active.classList&&active.classList.contains('wheel')?active:null;
    if(wheel && (e.key==='Enter'||e.key===' '||e.keyCode===13)){
      if(!wheelSession||wheelSession.phase!=='ready'){e.preventDefault();return;}
      var kind=wheel.getAttribute('data-wheel');
      if(wheelDraft.editing===kind){wheelDraft.editing=null;applyWheel();}
      else {if(wheelDraft.kind!==kind){wheelDraft.kind=kind;wheelDraft.x=0;wheelDraft.y=0;wheelDraft.hasSelection=false;}wheelDraft.editing=kind;updateWheelSelection();}
      e.preventDefault();return;
    }
    if(wheel&&wheelDraft&&wheelDraft.editing && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].indexOf(arrowKey)>=0){
      var step=.08,point=limitPoint(wheelDraft.x+(arrowKey==='ArrowLeft'?-step:arrowKey==='ArrowRight'?step:0),wheelDraft.y+(arrowKey==='ArrowUp'?-step:arrowKey==='ArrowDown'?step:0));
      wheelDraft.x=point.x;wheelDraft.y=point.y;queuePreview();e.preventDefault();return;
    }
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].indexOf(arrowKey)<0)return;
    if(document.activeElement && document.activeElement.tagName==='INPUT')return;
    var root=(state.colorLight||state.sceneRoom||recovery)?document.querySelector('.color-dialog'):document;
    var els=Array.prototype.slice.call(root.querySelectorAll('button:not([disabled]),input:not([disabled])')).filter(function(x){var q=x.getBoundingClientRect();return q.width>0&&q.height>0;});
    var current=document.activeElement;if(els.indexOf(current)<0){if(els[0])els[0].focus();e.preventDefault();return;}
    var a=current.getBoundingClientRect(),ax=a.left+a.width/2,ay=a.top+a.height/2,vertical=arrowKey==='ArrowUp'||arrowKey==='ArrowDown',sign=(arrowKey==='ArrowUp'||arrowKey==='ArrowLeft')?-1:1;
    var best=null,score=Infinity;els.forEach(function(el){if(el===current)return;var r=el.getBoundingClientRect(),dx=r.left+r.width/2-ax,dy=r.top+r.height/2-ay,primary=vertical?dy:dx,secondary=vertical?dx:dy;if(primary*sign<=4)return;var s=Math.abs(primary)+Math.abs(secondary)*2.5;if(s<score){score=s;best=el;}});
    if(best){best.focus();best.scrollIntoView({block:'nearest',inline:'nearest'});}e.preventDefault();
  });
  initialize();
}());
