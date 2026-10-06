import {evaluateTrack,rgbOutput,validateProject,beatGrid,detectBeats,waveform,pulseKeys} from './timeline.js';

const $=id=>document.getElementById(id),clone=x=>structuredClone(x),uid=()=>crypto.randomUUID();

const palette=[[157,112,255],[59,190,255],[84,239,193],[255,184,75],[255,89,134],[214,90,255]];

function defaultProject(){return {version:1,name:'Chroma sweep',duration:12,beats:beatGrid(12,120),waveform:[],tracks:palette.map((c,i)=>({name:`Flood ${i+1}`,keys:[{id:uid(),t:0,on:true,intensity:30,color:c,ease:'linear'},{id:uid(),t:4,on:true,intensity:65,color:palette[(i+2)%6],ease:'linear'},{id:uid(),t:8,on:true,intensity:20,color:palette[(i+4)%6],ease:'jump'},{id:uid(),t:12,on:true,intensity:30,color:c,ease:'linear'}]}))}}

let project=defaultProject(),selectedTrack=0,selectedKey=project.tracks[0].keys[0].id,position=0,playing=false,starting=false,live=false,anchor=0,startPosition=0,lap=0,undoStack=[],redoStack=[],saveTimer,drag=null;

let keySelection=new Set(),keyClipboard=null,pasteTime=null,durationDraft=null;
let currentLightState=null,manualDirty=false,lightStateBusy=false,discoveredFlood=null,cloudKeySaved=false,deviceGeneration=0,discoveryBusy=false,discoveryFailed=false,virtualPreview=false;
function hasFlood(){return project.controllers?.length?project.controllers.every(c=>deviceInventory.some(d=>d.id===c.id&&d.model==='H7062')):Boolean(discoveredFlood||currentLightState?.controller)}
function trackLabel(i){const c=project.controllers?.[Math.floor(i/6)];return c?`${c.name||'Set '+(Math.floor(i/6)+1)} · ${project.tracks[i].name}`:project.tracks[i].name}
function trackDevice(i){return project.controllers?.[Math.floor(i/6)]?.id||selectedDeviceId}
function stateFor(i){return project.controllers?lightStates[trackDevice(i)]:currentLightState}
const lightStates={};
let hardwareBusy=false,lastHardwareMode=null;
let audioContext=null,audioBuffer=null,audioSamples=null,audioRate=0,audioSource=null,audioGain=null,calibrationId=null,statusTimer,loadedAudioRef=null,playGeneration=0;

let lastPersisted=null,saveRevision=0,persistChain=Promise.resolve();

function notice(text,error=false){if($('actionStatus')){$('actionStatus').textContent=text;$('actionStatus').classList.toggle('error',error)}$('notice').textContent=text;$('notice').classList.toggle('error',error)}

let boundInstance=null,serverChanged=false;
const instanceReady=fetch('/api/instance',{cache:'no-store'}).then(async response=>{if(!response.ok)throw Error('Server identity unavailable. Reload after updating the server.');const state=await response.json();if(!state.instanceId)throw Error('Server identity is missing.');boundInstance=state.instanceId;return state;});
instanceReady.catch(error=>freezeServer(error.message));
function freezeServer(reason='Server changed. Your timeline is preserved in this tab.'){
  if(serverChanged)return;serverChanged=true;clearTimeout(saveTimer);clearInterval(statusTimer);playGeneration++;playing=false;starting=false;live=false;hardwareBusy=false;stopAudio();
  $('serverChangedMessage').textContent=reason;$('serverChangedBanner').hidden=false;
  document.querySelector('main').inert=true;document.querySelector('header').inert=true;
  for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
}
async function verifyServer(){await instanceReady;if(serverChanged)throw Error('Server changed. Export your timeline before reloading.');const response=await fetch('/api/instance',{cache:'no-store'});if(!response.ok)throw Error('Cannot verify server identity.');const state=await response.json();if(state.instanceId!==boundInstance){freezeServer();throw Error('Server changed. Your timeline is preserved in this tab.');}}
async function api(path,body){await instanceReady;if(serverChanged)throw Error('Server changed. Export your timeline before reloading.');const opts=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-LightBridge-Instance':boundInstance},body:JSON.stringify(body)};const response=await fetch(path,opts),result=await response.json();if(response.status===409&&result.code==='instance_changed')freezeServer();if(!response.ok)throw Error(result.error||'Request failed');return result}
$('exportPreservedProject').onclick=()=>$('exportProject').onclick();
$('reloadNewServer').onclick=()=>location.reload();
document.addEventListener('keydown',event=>{if(serverChanged&&!event.target.closest('#serverChangedBanner')){event.preventDefault();event.stopImmediatePropagation();}},true);
setInterval(()=>{if(!serverChanged)verifyServer().catch(()=>{});},1000);


function resetSelection(){keySelection=new Set([...keySelection].filter(id=>project.tracks.some(tr=>tr.keys.some(k=>k.id===id))));selectedTrack=Math.min(project.tracks.length-1,selectedTrack);if(!project.tracks[selectedTrack].keys.some(k=>k.id===selectedKey))selectedKey=project.tracks[selectedTrack].keys[0].id;position=Math.min(project.duration,position)}

function selected(){return project.tracks[selectedTrack].keys.find(k=>k.id===selectedKey)}

function hex(rgb){return '#'+rgb.map(c=>Math.round(c).toString(16).padStart(2,'0')).join('')}

function fromHex(value){return [1,3,5].map(n=>parseInt(value.slice(n,n+2),16))}

function record(){undoStack.push(clone(project));if(undoStack.length>40)undoStack.shift();redoStack=[]}

function changed(){validateProject(project);resetSelection();render();scheduleSave()}

function scheduleSave(){if(serverChanged)return;clearTimeout(saveTimer);$('saveState').textContent='Unsaved changes';saveTimer=setTimeout(()=>persist(),600)}

function persist(){

  clearTimeout(saveTimer);const payload=clone(project),revision=++saveRevision;

  persistChain=persistChain.catch(()=>{}).then(async()=>{const saved=await api('/api/save',payload);payload.layoutRevision=saved.layoutRevision??payload.layoutRevision??0;if(revision===saveRevision)project.layoutRevision=payload.layoutRevision;lastPersisted=JSON.stringify(payload);if(revision===saveRevision&&JSON.stringify(project)===lastPersisted)$('saveState').textContent='Saved locally'}).catch(e=>{notice('Save failed: '+e.message,true);$('saveState').textContent='Save failed'});return persistChain;

}

function snapTime(t){t=Math.max(0,Math.min(project.duration,t));if($('snap').checked&&project.beats?.length){const near=project.beats.reduce((a,b)=>Math.abs(b-t)<Math.abs(a-t)?b:a);if(Math.abs(near-t)<Math.max(.06,8/pxScale()))t=near}return Math.round(t*1000)/1000}

function keyAt(t,track=selectedTrack){return project.tracks[track].keys.find(k=>Math.abs(k.t-t)<.001)}

function choose(track,id){keySelection.clear();const sameTrack=selectedTrack===track;selectedTrack=track;selectedKey=id||(sameTrack?selectedKey:project.tracks[track].keys[0].id);if(id)seek(selected().t);render()}

function addKey(t=position){if(playing||starting)return;t=snapTime(t);const existing=keyAt(t);if(existing){choose(selectedTrack,existing.id);return}record();const state=evaluateTrack(project.tracks[selectedTrack],t),key={id:uid(),t,...state,ease:'linear'};project.tracks[selectedTrack].keys.push(key);project.tracks[selectedTrack].keys.sort((a,b)=>a.t-b.t);selectedKey=key.id;changed()}

const timePadding=18;
function pxScale(){return Math.max(1,($('timelineScroll').clientWidth||800)-120-timePadding*2)/project.duration*Number($('zoom').value)/100}

function render(){
  const timelineViewport=$('timelineScroll'),savedScrollTop=timelineViewport.scrollTop,savedScrollLeft=timelineViewport.scrollLeft;
  const trackFragment=document.createDocumentFragment();

  ensureLayout();resetSelection();if(!playing&&!starting)$('loop').checked=project.loop===true;$('currentShowName').textContent=project.name||'Untitled show';if(document.activeElement!==$('duration')&&durationDraft===null)$('duration').value=project.duration;$('scrub').max=project.duration;$('trackSelect').replaceChildren();

  project.tracks.forEach((tr,i)=>{const option=document.createElement('option');option.value=i;option.textContent=trackLabel(i);$('trackSelect').append(option)});$('trackSelect').value=selectedTrack;

  const width=project.duration*pxScale()+timePadding*2;$('timeline').style.width=(width+120)+'px';$('ruler').replaceChildren();

  const desiredTick=65/pxScale(),magnitude=10**Math.floor(Math.log10(desiredTick)),tick=[1,2,5,10].find(n=>n*magnitude>=desiredTick)*magnitude;for(let t=0;t<=project.duration;t+=tick){const span=document.createElement('span');span.textContent=Number(t.toFixed(3))+'s';span.style.left=(120+timePadding+t*pxScale())+'px';$('ruler').append(span)}

  const lastTick=$('ruler').lastElementChild,endX=120+timePadding+project.duration*pxScale();if(lastTick&&Math.abs(parseFloat(lastTick.style.left)-endX)>.1){if(endX-parseFloat(lastTick.style.left)<45)lastTick.remove();const end=document.createElement('span');end.textContent=project.duration+'s';end.style.left=endX+'px';end.style.transform='translateX(-100%)';$('ruler').append(end)}


  project.tracks.forEach((track,index)=>{

    const row=document.createElement('div');row.className='track-row'+(index===selectedTrack?' selected':'');

    const name=document.createElement('div');name.className='track-name';name.textContent=trackLabel(index);let preserveNameSelection=false;
    name.onpointerdown=e=>{$('timeline').focus({preventScroll:true});preserveNameSelection=e.shiftKey||e.ctrlKey||e.metaKey};
    name.onclick=e=>{if(preserveNameSelection||e.shiftKey||e.ctrlKey||e.metaKey)return;choose(index)};row.append(name);

    const content=document.createElement('div');content.className='track-content';content.style.width=width+'px';content.style.backgroundSize=pxScale()+'px 100%';content.style.backgroundPosition=timePadding+'px 0';content.dataset.track=index;row.append(content);

    for(const [n,beat] of (project.beats||[]).entries()){const line=document.createElement('div');line.className='beat-line'+(n%4===0?' strong':'');line.style.left=(timePadding+beat*pxScale())+'px';content.append(line)}

    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width',width);svg.setAttribute('height',56);

    const defs=document.createElementNS('http://www.w3.org/2000/svg','defs');svg.append(defs);
    const hatch=document.createElementNS('http://www.w3.org/2000/svg','pattern');hatch.id=`track-off-${index}`;hatch.setAttribute('width',8);hatch.setAttribute('height',8);hatch.setAttribute('patternUnits','userSpaceOnUse');
    const hatchLine=document.createElementNS('http://www.w3.org/2000/svg','path');hatchLine.setAttribute('d','M -2 2 L 2 -2 M 0 8 L 8 0 M 6 10 L 10 6');hatchLine.setAttribute('stroke','#101723');hatchLine.setAttribute('stroke-width',3);hatchLine.setAttribute('opacity','.6');hatch.append(hatchLine);defs.append(hatch);
    for(let k=0;k<track.keys.length;k++){
      const a=track.keys[k],b=track.keys[k+1]||{...a,t:project.duration};if(b.t<=a.t)continue;
      const gradient=document.createElementNS('http://www.w3.org/2000/svg','linearGradient'),gradientId=`track-color-${index}-${k}`;gradient.id=gradientId;
      const count=a.ease==='linear'?8:1;
      for(let j=0;j<=count;j++){const stop=document.createElementNS('http://www.w3.org/2000/svg','stop'),t=a.t+(b.t-a.t)*j/count,state=evaluateTrack({keys:[a,b]},j===count?Math.max(a.t,b.t-.000001):t);stop.setAttribute('offset',j/count);stop.setAttribute('stop-color',hex(rgbOutput({...state,on:true,intensity:state.on?state.intensity:20+state.intensity*.8})));gradient.append(stop)}defs.append(gradient);
      const strip=document.createElementNS('http://www.w3.org/2000/svg','rect');strip.setAttribute('x',timePadding+a.t*pxScale());strip.setAttribute('y',8);strip.setAttribute('width',(b.t-a.t)*pxScale());strip.setAttribute('height',40);strip.setAttribute('fill',`url(#${gradientId})`);strip.setAttribute('opacity',a.on?'.85':'.45');svg.append(strip);
      if(!a.on){const overlay=strip.cloneNode();overlay.setAttribute('fill',`url(#track-off-${index})`);overlay.setAttribute('opacity','1');svg.append(overlay);
        if((b.t-a.t)*pxScale()>48){const label=document.createElementNS('http://www.w3.org/2000/svg','text');label.setAttribute('x',timePadding+a.t*pxScale()+8);label.setAttribute('y',19);label.setAttribute('fill','#d1d9e8');label.setAttribute('font-size','9');label.textContent='OFF';svg.append(label)}
      }
    }
    for(let k=0;k<track.keys.length;k++){

      const a=track.keys[k],b=track.keys[k+1]||{...a,t:project.duration},path=document.createElementNS('http://www.w3.org/2000/svg','path');const x=timePadding+a.t*pxScale(),xx=timePadding+b.t*pxScale(),y=47-(a.on?a.intensity:0)*.32,yy=47-(b.on?b.intensity:0)*.32;

      path.setAttribute('d',a.ease==='linear'?`M ${x} ${y} L ${xx} ${yy}`:`M ${x} ${y} H ${xx} V ${yy}`);path.setAttribute('stroke','#e1e8ff');path.setAttribute('stroke-width','2');path.setAttribute('fill','none');path.setAttribute('opacity','.65');svg.append(path);

    }content.append(svg);

    for(const k of track.keys){const key=document.createElement('button');key.className='key'+((keySelection.size?keySelection.has(k.id):k.id===selectedKey&&index===selectedTrack)?' active':'')+(!k.on?' off':'');key.style.left=(timePadding+k.t*pxScale())+'px';key.title=`${track.name} · ${k.t.toFixed(3)}s · ${k.intensity}% · ${k.ease}`;key.setAttribute('aria-label',key.title);key.dataset.key=k.id;

      key.onclick=e=>{e.stopPropagation();if(e.detail===0){selectedTrack=index;selectedKey=k.id;keySelection=new Set([k.id]);seek(k.t);render()}};

      key.onpointerdown=e=>{if(playing||starting||e.button!==0)return;e.preventDefault();e.stopPropagation();$('timeline').focus({preventScroll:true});
        if(e.shiftKey||e.ctrlKey||e.metaKey){if(keySelection.has(k.id))keySelection.delete(k.id);else{if(!keySelection.size)keySelection.add(selectedKey);keySelection.add(k.id)}}
        else if(!keySelection.has(k.id))keySelection=new Set([k.id]);
        selectedTrack=index;selectedKey=k.id;drag={id:k.id,index,startX:e.clientX,original:k.t,backup:clone(project),ids:new Set(keySelection),moved:false};render();};content.append(key)}

    content.onpointerdown=beginMarquee;
    content.onclick=e=>{if(e.shiftKey||e.ctrlKey||e.metaKey||e.target.closest('.key')||drag||performance.now()<suppressTrackClickUntil)return;seek(snapTime((e.clientX-content.getBoundingClientRect().left-timePadding)/pxScale()),true);selectedTrack=index;selectedKey=track.keys[0].id;keySelection.clear();render()};

    content.ondblclick=e=>{if(e.shiftKey||e.ctrlKey||e.metaKey||e.target.closest('.key')||performance.now()<suppressTrackClickUntil)return;selectedTrack=index;position=snapTime((e.clientX-content.getBoundingClientRect().left-timePadding)/pxScale());addKey(position)};

    trackFragment.append(row);

  });

  $('trackRows').replaceChildren(trackFragment);
  timelineViewport.scrollTop=savedScrollTop;timelineViewport.scrollLeft=savedScrollLeft;
  renderDevices();$('output').querySelector('[value=group]').disabled=Boolean(project.controllers?.length);if(project.controllers?.length)$('output').value='effect-frames';drawWaveform(width);renderInspector();renderPreview();$('beatCount').textContent=`${project.beats?.length||0} beat markers`;$('audioName').textContent=project.audioName||'Audio is optional. Animate with keyframes and press Play, or import audio for music timing.';

  $('undo').disabled=!undoStack.length||playing;$('redo').disabled=!redoStack.length||playing;

}

function drawWaveform(width){$('audioLane').hidden=!audioBuffer||!project.audioRef;const c=$('waveform');c.width=Math.ceil(width);c.height=64;c.style.width=width+'px';const ctx=c.getContext('2d');ctx.strokeStyle='#8adbca';ctx.globalAlpha=.7;ctx.beginPath();const peaks=audioBuffer&&project.audioRef?(project.waveform||[]):[],audioDuration=project.audioDuration||project.duration;peaks.forEach((v,i)=>{const x=timePadding+i/peaks.length*audioDuration*pxScale();ctx.moveTo(x,32-v*27);ctx.lineTo(x,32+v*27)});ctx.stroke();ctx.globalAlpha=1;ctx.strokeStyle='#617f7655';for(const t of project.beats||[]){ctx.beginPath();ctx.moveTo(timePadding+t*pxScale(),0);ctx.lineTo(timePadding+t*pxScale(),64);ctx.stroke()}c.onclick=e=>seek(snapTime((e.clientX-c.getBoundingClientRect().left-timePadding)/pxScale()),true)}

function renderInspector(){const k=selected();$('selectionTitle').textContent=trackLabel(selectedTrack);$('selectionCount').textContent=`${keySelection.size||1} selected`;$('keyTime').value=k.t;$('keyTime').max=project.duration;$('keyTime').disabled=k.t===0||playing;$('keyOn').checked=k.on;$('keyIntensity').value=k.intensity;$('intensityValue').textContent=Math.round(k.intensity)+'%';$('keyColor').value=hex(k.color);$('keyEase').value=k.ease;$('deleteKey').disabled=playing||starting;$('deleteSelectedKey').disabled=playing||starting;

  $('keyList').replaceChildren();for(const key of project.tracks[selectedTrack].keys){const b=document.createElement('button');b.textContent=key.t.toFixed(2)+'s';b.className=key.id===selectedKey?'active':'';b.onclick=()=>{selectedKey=key.id;seek(key.t);render()};$('keyList').append(b)}

}

function renderClipboard(){const count=keyClipboard?.entries.length||0;$('pasteKeys').disabled=!count||playing||starting;$('clipboardStatus').textContent=count?`${count} copied · Paste to ${project.tracks[selectedTrack].name} at ${(pasteTime??keyClipboard.start).toFixed(3)}s${pasteTime===null?" · original timing":""}`:'No copied keys';for(const el of $('trackRows').querySelectorAll('.key'))el.classList.toggle('copied',!!keyClipboard?.entries.some(entry=>entry.key.id===el.dataset.key))}

function renderPreview(){renderClipboard();if($('lamps').children.length!==project.tracks.length){$('lamps').replaceChildren();project.tracks.forEach((_,i)=>{const lamp=document.createElement('div');lamp.className='lamp';lamp.innerHTML='<div class="lamp-bulb"></div><div class="lamp-name"></div><div class="lamp-level"></div>';lamp.onclick=()=>choose(i);$('lamps').append(lamp)})}

  project.tracks.forEach((track,i)=>{const state=evaluateTrack(track,position),rgb=rgbOutput(state),lamp=$('lamps').children[i],color=hex(rgb);lamp.classList.toggle('selected',i===selectedTrack);lamp.children[0].style.background=color;lamp.children[0].style.boxShadow=`0 0 ${state.on?30:0}px ${color}80`;lamp.children[1].textContent=track.name;lamp.children[2].textContent=state.on?`${Math.round(state.intensity)}%`:'Off'});

  renderStage();
  if(document.activeElement!==$('playheadTime'))$('playheadTime').value=position.toFixed(3);$('playheadTime').max=project.duration;$('timeDisplay').textContent=`/ ${project.duration.toFixed(3)} s`;$('scrub').value=position;$('playhead').style.left=(120+timePadding+position*pxScale())+'px';

}

let pendingSeek=null,seekStopping=false,suppressTrackClickUntil=0,stopAfterLap=1;
function seek(t,explicitPasteTime=false){if(explicitPasteTime&&keyClipboard)pasteTime=Math.max(0,Math.min(project.duration,t));t=Math.max(0,Math.min(project.duration,t));if(playing||starting||seekStopping){pendingSeek=t;if(!seekStopping){seekStopping=true;halt(false).then(()=>{const destination=pendingSeek;pendingSeek=null;seekStopping=false;seek(destination)})}return}position=t;renderPreview()}

let marquee=null;
function beginMarquee(e){
 if(playing||starting||e.button!==0||e.target.closest('.key'))return;
 $('timeline').focus({preventScroll:true});
 const additive=e.shiftKey||e.ctrlKey||e.metaKey;
 marquee={pointer:e.pointerId,x:e.clientX,y:e.clientY,moved:false,additive,before:new Set(keySelection),base:additive?new Set(keySelection.size?keySelection:[selectedKey]):new Set(),box:null};
 e.preventDefault();
}
document.addEventListener('pointermove',e=>{
 if(!marquee||e.pointerId!==marquee.pointer)return;const m=marquee;
 if(!m.moved&&Math.hypot(e.clientX-m.x,e.clientY-m.y)<4)return;m.moved=true;
 if(!m.box){m.box=document.createElement('div');m.box.className='key-marquee';document.body.append(m.box)}
 const left=Math.min(m.x,e.clientX),top=Math.min(m.y,e.clientY),right=Math.max(m.x,e.clientX),bottom=Math.max(m.y,e.clientY);
 Object.assign(m.box.style,{left:left+'px',top:top+'px',width:(right-left)+'px',height:(bottom-top)+'px'});
 keySelection=new Set(m.base);
 for(const el of $('trackRows').querySelectorAll('.key')){const r=el.getBoundingClientRect(),x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;if(x>=left&&x<=right&&y>=top&&y<=bottom)keySelection.add(el.dataset.key);el.classList.toggle('active',keySelection.has(el.dataset.key))}
 $('selectionCount').textContent=`${keySelection.size} selected`;
});
function finishMarquee(cancel=false){if(!marquee)return;const m=marquee;marquee=null;m.box?.remove();if(cancel){keySelection=m.before;render();return}if(!m.moved){if(m.additive)suppressTrackClickUntil=performance.now()+250;return}
 suppressTrackClickUntil=performance.now()+250;
 if(keySelection.size){for(let i=0;i<project.tracks.length;i++){const key=project.tracks[i].keys.find(k=>keySelection.has(k.id));if(key){selectedTrack=i;selectedKey=key.id;break}}}
 render();
}
document.addEventListener('pointerup',()=>finishMarquee());
document.addEventListener('pointercancel',()=>finishMarquee(true));
document.addEventListener('keydown',e=>{if(e.key==='Escape')finishMarquee(true)});

document.addEventListener('pointermove',e=>{if(!drag)return;if(Math.abs(e.clientX-drag.startX)>3)drag.moved=true;if(!drag.moved)return;
 const chosen=drag.backup.tracks.flatMap(tr=>tr.keys.filter(k=>drag.ids.has(k.id)));if(!chosen.length)return;
 let delta=snapTime(drag.original+(e.clientX-drag.startX)/pxScale())-drag.original;
 const earliest=Math.min(...chosen.map(k=>k.t));delta=Math.max((earliest===0?0:.001)-earliest,Math.min(project.duration-Math.max(...chosen.map(k=>k.t)),delta));
 const candidate=clone(drag.backup);for(const [i,tr] of candidate.tracks.entries()){for(const k of tr.keys)if(drag.ids.has(k.id))k.t=Math.round((k.t+delta)*1000)/1000;tr.keys.sort((a,b)=>a.t-b.t);if(tr.keys[0].t>0){drag.baselineIds??={};drag.baselineIds[i]??=uid();tr.keys.unshift({...clone(drag.backup.tracks[i].keys[0]),id:drag.baselineIds[i],t:0,on:false,intensity:0,ease:'jump'})}if(tr.keys.some((k,i)=>i&&k.t-tr.keys[i-1].t<.001))return}
 project=candidate;render();
});
document.addEventListener('pointerup',()=>{if(!drag)return;const finished=drag;drag=null;suppressTrackClickUntil=performance.now()+250;if(finished.moved){if(JSON.stringify(project)!==JSON.stringify(finished.backup)){undoStack.push(finished.backup);redoStack=[];changed();if(finished.baselineIds&&project.tracks.some(tr=>tr.keys.some(k=>Object.values(finished.baselineIds).includes(k.id))))notice("Moved selected keys. Lights stay off until the shifted first key.")}}else{seek(selected().t);render()}});
document.addEventListener('pointercancel',()=>{if(drag){project=drag.backup;drag=null;render()}});

function copyKeys(){if(playing||starting)return;const ids=keySelection.size?keySelection:new Set([selectedKey]);const entries=project.tracks.flatMap((tr,track)=>tr.keys.filter(k=>ids.has(k.id)).map(key=>({track,key:clone(key)})));if(!entries.length)return;keyClipboard={entries,start:Math.min(...entries.map(e=>e.key.t)),track:Math.min(...entries.map(e=>e.track))};pasteTime=null;renderClipboard();notice(`Copied ${entries.length} keyframes. Choose a destination light, then Paste at the original times. Click the timeline to choose a different start time.`)}
function pasteKeys(){if(playing||starting||!keyClipboard)return;const candidate=clone(project),ids=[];
 try{for(const entry of keyClipboard.entries){const track=selectedTrack+entry.track-keyClipboard.track,t=Math.round(((pasteTime??keyClipboard.start)+entry.key.t-keyClipboard.start)*1000)/1000;if(track>=candidate.tracks.length||t>project.duration)throw Error('The copied keys do not fit here. Choose an earlier time or track.');const keys=candidate.tracks[track].keys;if(keys.some(k=>Math.abs(k.t-t)<.001)&&t!==0)throw Error('A destination key already exists at this time. Move the playhead or delete that key first.');const key={...clone(entry.key),id:uid(),t};if(t===0)keys.splice(0,1,key);else keys.push(key);keys.sort((a,b)=>a.t-b.t);ids.push(key.id)}validateProject(candidate);record();project=candidate;keySelection=new Set(ids);selectedKey=ids[0];changed();notice(`Pasted ${ids.length} keyframes. Undo restores the previous keys.`)}catch(e){notice(e.message,true)}}
$('copyKeys').onclick=copyKeys;$('pasteKeys').onclick=pasteKeys;
document.addEventListener('keydown',e=>{if(location.hash!=='#advanced'||e.target.closest('input,textarea,select,[contenteditable="true"]'))return;if((e.ctrlKey||e.metaKey)&&['c','v','a'].includes(e.key.toLowerCase())){e.preventDefault();if(e.key.toLowerCase()==='c')copyKeys();else if(e.key.toLowerCase()==='v')pasteKeys();else{keySelection=new Set(project.tracks[selectedTrack].keys.map(k=>k.id));render()}}});

function edit(action){if(playing||starting)return;record();try{action(selected());changed()}catch(e){project=undoStack.pop();notice(e.message,true);render()}}

$('trackSelect').onchange=()=>choose(Number($('trackSelect').value));

$('keyTime').onchange=()=>{const t=snapTime(Number($('keyTime').value));edit(k=>{if(t===0||keyAt(t)&&keyAt(t).id!==k.id)throw Error('That time already has a keyframe');k.t=t;project.tracks[selectedTrack].keys.sort((a,b)=>a.t-b.t)})};

$('keyOn').onchange=()=>edit(k=>k.on=$('keyOn').checked);

$('keyIntensity').oninput=()=>{$('intensityValue').textContent=$('keyIntensity').value+'%'};$('keyIntensity').onchange=()=>edit(k=>k.intensity=Number($('keyIntensity').value));

$('keyColor').onchange=()=>edit(k=>k.color=fromHex($('keyColor').value));$('keyEase').onchange=()=>edit(k=>k.ease=$('keyEase').value);

function emptyKey(color){return {id:uid(),t:0,on:false,intensity:0,color:[...color],ease:'jump'}}
function deleteSelectedKey(){if(playing||starting)return;record();const ids=keySelection.size?keySelection:new Set([selectedKey]);for(const tr of project.tracks){tr.keys=tr.keys.flatMap(k=>!ids.has(k.id)?[k]:k.t===0?[emptyKey(k.color)]:[])}keySelection.clear();resetSelection();changed();notice('Selected keys deleted. Zero-time baselines reset to Off. Undo restores them.')}

$('deleteKey').onclick=deleteSelectedKey;$('deleteSelectedKey').onclick=deleteSelectedKey;
$('clearTrack').onclick=()=>{edit(()=>{const track=project.tracks[selectedTrack];track.keys=[emptyKey(track.keys[0].color)];selectedKey=track.keys[0].id});notice('Track cleared to Off. Undo restores its keyframes.')};
$('clearAllTracks').onclick=()=>{edit(()=>{project.tracks.forEach(track=>track.keys=[emptyKey(track.keys[0].color)]);selectedKey=project.tracks[selectedTrack].keys[0].id});notice('All animation tracks cleared to Off. Undo restores the show.')};
document.addEventListener('keydown',e=>{if(location.hash!=='#advanced'||playing||starting||!['Delete','Backspace'].includes(e.key)||e.target.closest('input,textarea,select,[contenteditable="true"]'))return;e.preventDefault();deleteSelectedKey()});


$('addKey').onclick=()=>addKey();$('scrub').oninput=()=>seek(Number($('scrub').value),true);$('zoom').oninput=render;$('fitTimeline').onclick=()=>{$('zoom').value=100;render();$('timelineScroll').scrollLeft=0};
function commitPlayheadTime(){const t=Number($('playheadTime').value);if($('playheadTime').value.trim()===''||!Number.isFinite(t)||t<0||t>project.duration){notice(`Enter a time from 0 to ${project.duration} seconds.`,true);return}seek(t,true)}
$('playheadTime').onchange=commitPlayheadTime;$('playheadTime').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();commitPlayheadTime();$('playheadTime').blur()}};

async function commitDuration(){const raw=$('duration').value,d=Number(raw);durationDraft=raw;$('durationError').textContent='';if(raw.trim()===''||!Number.isFinite(d)||d<.1||d>3600){$('durationError').textContent='Enter 0.1–3600 seconds.';return false}if(project.tracks.some(tr=>tr.keys.some(k=>k.t>d))){$('durationError').textContent=`Keys extend to ${Math.max(...project.tracks.flatMap(tr=>tr.keys.map(k=>k.t))).toFixed(3)}s. Move or delete those keys before shortening.`;return false}if(d===project.duration){durationDraft=null;return true}if(playing||starting)await halt(false);durationDraft=null;edit(()=>{project.duration=d;$('zoom').value=100;$('timelineScroll').scrollLeft=0;project.beats=(project.beats||[]).filter(t=>t<=d)});return true}
$('duration').oninput=()=>{durationDraft=$('duration').value;$('durationError').textContent=''};
$('duration').onchange=commitDuration;
$('duration').onkeydown=async e=>{if(e.key==='Enter'){e.preventDefault();if(await commitDuration())$('duration').blur()}else if(e.key==='Escape'){durationDraft=null;$('durationError').textContent='';$('duration').value=project.duration;$('duration').blur()}};

$('undo').onclick=async()=>{if(playing||starting||!undoStack.length)return;redoStack.push(clone(project));project=undoStack.pop();changed();if(loadedAudioRef!==(project.audioRef||null))await restoreAudio()};$('redo').onclick=async()=>{if(playing||starting||!redoStack.length)return;undoStack.push(clone(project));project=redoStack.pop();changed();if(loadedAudioRef!==(project.audioRef||null))await restoreAudio()};
document.addEventListener('keydown',e=>{if(location.hash!=='#advanced'||e.target.closest('input,textarea,select,[contenteditable="true"]')||!(e.ctrlKey||e.metaKey)||e.altKey)return;const key=e.key.toLowerCase();if(key!=='z'&&key!=='y')return;e.preventDefault();if(playing||starting)return;const redo=key==='y'||e.shiftKey;$(redo?'redo':'undo').click()});


async function refreshShows(){const result=await api('/api/shows');$('savedShows').replaceChildren(new Option('Choose a show',''));for(const show of result.shows)$('savedShows').append(new Option(show.name,show.id));$('savedShows').value=project.libraryShowId||''}
function openSaveShowDialog(){$('showName').value=project.name||'Untitled show';$('showSaveError').textContent='';$('saveShowDialog').showModal();$('showName').select()}
async function saveNamedShow(name,id){const next=clone(project);next.name=name;delete next.libraryShowId;const saved=await api('/api/shows/save',{project:next,...(id?{id}:{})});project.name=name;project.libraryShowId=saved.id;await persist();await refreshShows();render();notice(`Saved show “${name}”.`)}
$('saveProject').onclick=async()=>{try{if(!project.libraryShowId){openSaveShowDialog();return}await saveNamedShow(project.name,project.libraryShowId)}catch(e){notice(e.message,true)}};
$('saveShowAs').onclick=openSaveShowDialog;$('cancelSaveShow').onclick=()=>$('saveShowDialog').close();
$('saveShowForm').onsubmit=async e=>{e.preventDefault();const name=$('showName').value.trim();if(!name){$('showSaveError').textContent='Enter a show name.';return}$('confirmSaveShow').disabled=true;try{await saveNamedShow(name);$('saveShowDialog').close()}catch(error){$('showSaveError').textContent=error.message}finally{$('confirmSaveShow').disabled=false}};
$('openShow').onclick=async()=>{const id=$('savedShows').value;if(!id){notice('Choose a saved show to open.',true);return}try{await halt(false);await persist();if(lastPersisted!==JSON.stringify(project))throw Error('Current show could not be saved. Opening was cancelled.');const next=await api('/api/shows/'+encodeURIComponent(id));validateProject(next);record();project=next;project.libraryShowId=id;selectedTrack=0;selectedKey=project.tracks[0].keys[0].id;keySelection.clear();position=0;keyClipboard=null;pasteTime=null;$('loop').checked=project.loop===true;changed();await persist();await restoreAudio();notice(`Opened “${project.name}”. Undo restores your previous timeline.`)}catch(e){notice(e.message,true)}};

$('exportProject').onclick=()=>{const blob=new Blob([JSON.stringify(project,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Light-Bridge-Project.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);notice('Project exported. Imported audio stays in this app’s local data folder; keep the original audio for moving the project to another computer.')};

async function ensureContext(resume=true){if(!audioContext){audioContext=new AudioContext();audioGain=audioContext.createGain();audioGain.connect(audioContext.destination)}audioGain.gain.value=Number($('volume').value)/100;if(resume)await audioContext.resume()}

async function decodeAudio(bytes){await ensureContext(false);const buffer=await audioContext.decodeAudioData(bytes.slice(0));if(buffer.duration>3600)throw Error('Audio must be at most one hour');const offline=new OfflineAudioContext(1,Math.ceil(buffer.duration*22050),22050),source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start();const mono=await offline.startRendering();return {buffer,samples:mono.getChannelData(0),rate:mono.sampleRate}}

async function restoreAudio(){audioBuffer=null;audioSamples=null;loadedAudioRef=null;if(!project.audioRef){$('detect').disabled=true;return}try{const r=await fetch('/audio/'+encodeURIComponent(project.audioRef));if(!r.ok)throw Error('Saved audio not available');const decoded=await decodeAudio(await r.arrayBuffer());audioBuffer=decoded.buffer;audioSamples=decoded.samples;audioRate=decoded.rate;loadedAudioRef=project.audioRef;$('detect').disabled=false;render()}catch(e){notice(e.message+'. Re-import the original audio file.',true);$('detect').disabled=true}}

$('importProject').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>4*1024*1024)throw Error('Project exceeds 4 MB');const next=validateProject(JSON.parse(await file.text()));next.tracks.forEach(tr=>tr.keys.forEach(k=>k.id=uid()));await halt(false);record();project=next;delete project.libraryShowId;selectedKey=null;position=0;changed();await restoreAudio();notice('Project opened')}catch(e){notice(e.message,true)}finally{$('importProject').value=''}};

let importingAudio=false;
$('importAudio').onchange=async e=>{const file=e.target.files[0];if(!file||importingAudio)return;importingAudio=true;$('importAudio').disabled=true;try{if(file.size>100*1024*1024)throw Error('Audio exceeds 100 MB');notice('Decoding audio and finding transients…');await halt(false);const bytes=await file.arrayBuffer(),decoded=await decodeAudio(bytes);notice('Saving audio…');await verifyServer();const r=await fetch('/api/audio',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-LightBridge-Instance':boundInstance},body:bytes});if(r.status===409)freezeServer();const upload=await r.json();if(!r.ok)throw Error(upload.error);record();audioBuffer=decoded.buffer;audioSamples=decoded.samples;audioRate=decoded.rate;project.audioRef=upload.ref;loadedAudioRef=upload.ref;project.audioName=file.name;project.audioDuration=audioBuffer.duration;project.waveform=waveform(audioSamples);project.duration=Math.max(project.duration,Math.round(audioBuffer.duration*1000)/1000);project.beats=detectBeats(audioSamples,audioRate,Number($('sensitivity').value)).beats.filter(t=>t<=project.duration);$('detect').disabled=false;changed();notice(`Imported ${file.name}. Found ${project.beats.length} transient markers; adjust or replace them with a tempo grid.`)}catch(e){notice(e.message,true)}finally{importingAudio=false;$('importAudio').disabled=false;$('importAudio').value=''}};

$('removeAudio').onclick=async()=>{await halt(false);record();delete project.audioRef;delete project.audioName;delete project.audioDuration;project.waveform=[];audioBuffer=null;audioSamples=null;loadedAudioRef=null;$('detect').disabled=true;changed()};

$('volume').oninput=()=>{if(audioGain)audioGain.gain.value=Number($('volume').value)/100};

$('makeGrid').onclick=()=>edit(()=>{project.beats=beatGrid(project.duration,Number($('bpm').value),Number($('beatOffset').value))});

$('detect').onclick=()=>{if(!audioSamples)return;edit(()=>{project.beats=detectBeats(audioSamples,audioRate,Number($('sensitivity').value)).beats.filter(t=>t<=project.duration)});notice('Transient markers updated. Listen and adjust timing before building a pattern.')};

$('addBeat').onclick=()=>edit(()=>{project.beats=[...new Set([...(project.beats||[]),Math.round(position*1000)/1000])].sort((a,b)=>a-b)});

$('removeBeat').onclick=()=>edit(()=>{if(!project.beats?.length)return;const closest=project.beats.reduce((a,b)=>Math.abs(b-position)<Math.abs(a-position)?b:a);project.beats=project.beats.filter(t=>t!==closest)});

$('generate').onclick=()=>{if(!project.beats?.length){notice('Add beat markers first.',true);return}const color=[...selected().color],level=selected().intensity||65;edit(()=>{project.tracks.forEach((tr,i)=>tr.keys=pulseKeys(project.beats,project.duration,($('pattern').value==='spatial'?spatialOrder().indexOf(i):i),($('pattern').value==='spatial'?'chase':$('pattern').value),color,level,project.tracks.length).map(k=>({...k,id:uid()})));selectedKey=project.tracks[selectedTrack].keys[0].id});notice('Pattern created. Edit any generated keyframe, or Undo to restore the earlier tracks.')};

function stopAudio(){if(audioSource){try{audioSource.stop()}catch{}audioSource=null}}

function scheduleAudio(wall,offset){stopAudio();if(!audioBuffer||offset>=audioBuffer.duration||offset>=project.duration)return;const ctxTime=audioContext.currentTime+Math.max(0,wall-Date.now()/1000);audioSource=audioContext.createBufferSource();audioSource.buffer=audioBuffer;audioSource.connect(audioGain);audioSource.start(ctxTime,offset,Math.min(audioBuffer.duration-offset,project.duration-offset))}

function lockEditing(value){for(const id of ['addKey','deleteSelectedKey','clearTrack','clearAllTracks','keyOn','keyIntensity','keyColor','keyEase','trackSelect','importProject','makeGrid','detect','addBeat','removeBeat','generate','removeAudio','output','calibrate','confirmHeads'])$(id).disabled=value||(id==='detect'&&!audioSamples);$('undo').disabled=value||!undoStack.length;$('redo').disabled=value||!redoStack.length;$('keyTime').disabled=value||selected().t===0;$('deleteKey').disabled=value;$('scrub').disabled=false;$('play').disabled=value;renderDevices()}

async function play(){if(importingAudio){notice('Wait for audio import to finish.');return}if(playing||starting)return;starting=true;notice('Connecting to flood controller…');const generation=++playGeneration;lockEditing(true);$('loop').disabled=true;try{validateProject(project);if(position>=project.duration)position=0;if(audioBuffer)await ensureContext();if(generation!==playGeneration)return;let startWall=Date.now()/1000+.15;live=true;if(live){const state=await api('/api/play',{project,mode:$('output').value==='individual'?'individual-cloud':$('output').value,position,loop:$('loop').checked});startWall=state.startWall;if(generation!==playGeneration){await api('/api/stop',{});return}}startPosition=position;lap=0;stopAfterLap=1;anchor=performance.now()/1000+(startWall-Date.now()/1000);scheduleAudio(startWall,position);playing=true;notice('Playing on your lights. Stop restores the controller’s starting state.');requestAnimationFrame(frame)}catch(e){live=false;notice(e.message,true);lockEditing(false)}finally{starting=false;$('loop').disabled=false}}

function frame(){if(!playing)return;const elapsed=Math.max(0,performance.now()/1000-anchor),raw=startPosition+elapsed;if(raw>=project.duration*stopAfterLap&&!$('loop').checked){position=project.duration;halt(false);renderPreview();return}const currentLap=Math.floor(raw/project.duration);position=raw%project.duration;if(currentLap>lap){lap=currentLap;const remainder=raw%project.duration;scheduleAudio(Date.now()/1000,remainder)}renderPreview();requestAnimationFrame(frame)}

async function halt(reset){playGeneration++;starting=false;playing=false;stopAudio();if(live||hardwareBusy){try{const stopped=await api('/api/stop',{});if(stopped.error)notice(stopped.error,true);else if(stopped.restored===true)notice('Stopped. Starting controller state restored and confirmed by device readback.');else notice('Stopped. Controller restoration has not been confirmed.',true)}catch(e){notice('Could not stop hardware: '+e.message,true)}}live=false;if(reset)position=0;lockEditing(false);renderPreview()}

$('loop').onchange=async()=>{const enabled=$('loop').checked;try{if(live&&(playing||starting))await api('/api/loop',{loop:enabled});if(!enabled)stopAfterLap=Math.floor((startPosition+Math.max(0,performance.now()/1000-anchor))/project.duration)+1;project.loop=enabled;scheduleSave();notice(enabled?'Loop enabled.':playing?'Loop disabled. Playback will finish this pass.':'Loop disabled.')}catch(e){$('loop').checked=!enabled;notice(e.message,true)}};

$('play').onclick=play;$('pause').onclick=()=>halt(false);$('stop').onclick=()=>halt(true);window.addEventListener('pagehide',()=>{if(live&&boundInstance&&!serverChanged)fetch('/api/stop',{method:'POST',headers:{'Content-Type':'application/json','X-LightBridge-Instance':boundInstance},body:'{}',keepalive:true}).catch(()=>{})});

let deviceInventory=[],selectedDeviceId=null;
let controlledDeviceId=null;
const controlLabels={powerSwitch:'Power',brightness:'Brightness',colorRgb:'Color',colorTemperatureK:'White temperature (K)',lightScene:'Scene',diyScene:'DIY scene',segmentedColorRgb:'Segment colors',segmentedBrightness:'Segment brightness',musicMode:'Music mode'};
function capabilityInput(spec, name){
 const wrap=document.createElement('div'),kind=String(spec.dataType).toUpperCase();let read;
 if(kind==='STRUCT'){
  const readers=[];for(const field of spec.fields||[]){const label=document.createElement('label');label.textContent=controlLabels[field.fieldName]||field.fieldName;const child=capabilityInput(field,field.fieldName);label.append(child.element);let enabled=null;if(!field.required){enabled=document.createElement('input');enabled.type='checkbox';label.prepend(enabled);}wrap.append(label);readers.push(()=>!enabled||enabled.checked?[field.fieldName,child.read()]:null);}read=()=>Object.fromEntries(readers.map(r=>r()).filter(Boolean));
 }else if(kind==='ENUM'){
  const input=document.createElement('select');for(const [i,o] of (spec.options||[]).entries()){const option=document.createElement('option');option.value=i;option.textContent=o.name||JSON.stringify(o.value);input.append(option);}wrap.append(input);read=()=>spec.options[Number(input.value)].value;
 }else if(kind==='ARRAY'){
  const input=document.createElement('input');input.placeholder='Segments, e.g. 0,1,2';input.setAttribute('aria-label',name);wrap.append(input);read=()=>input.value.split(',').map(s=>{if(!s.trim())throw Error('Enter segment numbers');return Number(s.trim())});
 }else{
  const input=document.createElement('input');input.type=name==='colorRgb'||name==='rgb'?'color':'number';if(input.type==='color'){input.value='#ffffff';read=()=>parseInt(input.value.slice(1),16);}else{input.min=spec.range?.min??0;input.max=spec.range?.max??100;input.step=spec.range?.precision||1;input.value=input.min;read=()=>{if(!input.value)throw Error('Enter a value');return Number(input.value)}}input.setAttribute('aria-label',controlLabels[name]||name);wrap.append(input);
 }return {element:wrap,read};
}
function openDeviceControls(id){
 controlledDeviceId=id;const device=deviceInventory.find(d=>d.id===id);if(!device)return;
 $('deviceControlPanel').hidden=false;$('deviceControlTitle').textContent=`${device.name||device.model} · ${device.model}`;
 $('deviceControlStatus').textContent='Choose a value and Apply. Inputs are command values; use Read state for the device report.';$('deviceReportedState').textContent='Not read yet';
 $('loadDeviceScenes').disabled=!device.cloud;$('loadDeviceDiy').disabled=!device.cloud;
 const host=$('deviceCapabilityControls');host.replaceChildren();
 for(const cap of device.capabilities||[]){const row=document.createElement('form');row.className='capability-control';const label=document.createElement('strong');label.textContent=controlLabels[cap.instance]||cap.instance;row.append(label);
  if(!cap.controllable){const note=document.createElement('span');note.textContent=cap.unsupportedReason||'Read-only';row.append(note);host.append(row);continue;}
  const input=capabilityInput(cap.parameters,cap.instance),button=document.createElement('button');button.textContent='Apply';row.append(input.element,button);row.onsubmit=async event=>{event.preventDefault();button.disabled=true;try{const result=await api('/api/devices/control',{id,type:cap.type,instance:cap.instance,value:input.read()});await refreshLightState();$('deviceControlStatus').textContent=`Command sent via ${result.source}.`;$('deviceReportedState').textContent=JSON.stringify(result.readback||result.response,null,2);}catch(e){$('deviceControlStatus').textContent=e.message;}finally{button.disabled=false}};host.append(row);
 }
}
$('readDeviceState').onclick=async()=>{try{$('deviceReportedState').textContent=JSON.stringify(await api('/api/devices/state',{id:controlledDeviceId}),null,2);$('deviceControlStatus').textContent='State read from device.';}catch(e){$('deviceControlStatus').textContent=e.message}};
async function loadDeviceScenes(diy){try{await api('/api/devices/scenes',{id:controlledDeviceId,diy});await refreshDevices();openDeviceControls(controlledDeviceId);$('deviceControlStatus').textContent='Available scenes loaded.';}catch(e){$('deviceControlStatus').textContent=e.message}}
$('loadDeviceScenes').onclick=()=>loadDeviceScenes(false);$('loadDeviceDiy').onclick=()=>loadDeviceScenes(true);
function renderDevices(){
 const host=$('deviceInventory');host.replaceChildren();const floods=deviceInventory.filter(d=>d.model==='H7062');
 $('devicesSummary').textContent=`${deviceInventory.length} controllers · ${floods.length} flood sets · ${floods.length*6} flood heads`;
 for(const d of deviceInventory){
  const card=document.createElement('div');card.className='device-card'+(project.controllers?.some(c=>c.id===d.id)?' selected':'');
  const title=document.createElement('strong');title.textContent=d.name||d.model;
  const detail=document.createElement('span');detail.textContent=`${d.model} · ${d.ip||'Account device'} · ${d.source||'LAN'}`;
  const info=document.createElement('span');info.textContent=d.model==='H7062'?'6 individually animated flood heads':(d.controlSupported?'Device controls available':'No controllable capabilities exposed');card.append(title,detail,info);
  if(d.model==='H7062'){const added=project.controllers?.some(c=>c.id===d.id);const button=document.createElement('button');button.textContent=added?'Added':'Add lights';button.disabled=added||playing||starting||hardwareBusy;button.onclick=()=>{try{edit(()=>{ensureLayout();if(!project.controllers)project.controllers=[{id:selectedDeviceId||d.id,model:'H7062',name:'Set 1'}];if(project.controllers.some(c=>c.id===d.id))return;if(project.controllers.length>=16)throw Error('A show supports up to 16 flood sets.');const n=project.controllers.length;project.controllers.push({id:d.id,model:'H7062',name:`Set ${n+1}`});for(let h=0;h<6;h++){project.tracks.push({name:`Flood ${h+1}`,keys:[{id:uid(),t:0,on:false,intensity:0,color:[255,255,255],ease:'linear'}]});project.layout.fixtures.push({x:12+h*15.2,y:12+n*76/Math.max(1,n),angle:0});}});renderDevices();refreshLightState();notice(`Lights added. ${project.tracks.length} lights in this show.`);}catch(e){notice(e.message,true)}};card.append(button);} else if(!d.deviceType||d.deviceType==='devices.types.light'){const add=document.createElement('button');add.textContent=project.layout?.lights?.some(f=>f.deviceId===d.id)?'Added':'Add lights';add.disabled=project.layout?.lights?.some(f=>f.deviceId===d.id);add.onclick=()=>{edit(()=>{ensureLayout();project.layout.lights??=[];project.layout.lights.push({deviceId:d.id,model:d.model,name:d.name||d.model,x:50,y:50});});notice('Light added to layout. Device controls are available in Settings.');};card.append(add);} const controls=document.createElement('button');controls.textContent='Controls';controls.className='secondary';controls.onclick=()=>openDeviceControls(d.id);card.append(controls);host.append(card);
 }
}
async function refreshDevices(){const result=await api('/api/devices');deviceInventory=result.devices;selectedDeviceId=result.selectedId;discoveredFlood=deviceInventory.find(d=>d.id===selectedDeviceId)||null;renderDevices();renderStage();}
$('discover').onclick=async()=>{const generation=++deviceGeneration;discoveryBusy=true;discoveryFailed=false;discoveredFlood=null;currentLightState=null;renderStage();try{$('discover').disabled=true;notice('Searching for Lights...');const discovery=await api('/api/devices/refresh',{});$('discoveryStatus').textContent=discovery.cloudError||'LAN and account discovery complete.';if(generation!==deviceGeneration)return;await refreshDevices();discoveryFailed=!discoveredFlood;notice(discoveredFlood?`Found ${deviceInventory.length} controllers. Add lights in Settings.`:deviceInventory.length?'Devices found. Add lights in Settings.':'No lights replied. Check power and LAN control.',!deviceInventory.length)}catch(e){discoveryFailed=true;notice(e.message,true)}finally{discoveryBusy=false;$('discover').disabled=false;renderStage()}};


$('output').onchange=()=>{$('connectionStatus').textContent=$('output').value==='group'?'All lights follow Track 1. The other tracks are not sent.':$('output').value==='effect-frames'?'Local animation · plays every added light over Wi-Fi.':'Six tracks via Govee API · slow updates, not beat-accurate.'};

$('calibrate').onclick=async()=>{try{await halt(false);$('calibrationPanel').hidden=false;$('observed').checked=false;notice('Connecting for the separate-head test…');const state=await api('/api/calibrate',{});calibrationId=state.calibrationId;live=true;notice('API head test running. Colors arrive one by one, then hold for 8 seconds before restoration.');$('calibrationStatus').textContent='Test running…'}catch(e){notice(e.message,true)}};

$('confirmHeads').onclick=async()=>{try{if(!$('observed').checked)throw Error('Confirm the physical colors only if you saw one distinct color per flood');const state=await api('/api/confirm',{testId:calibrationId,observed:true});applyStatus(state);notice('Separate-head API control confirmed. Local animation is ready to use.')}catch(e){notice(e.message,true)}};

function applyStatus(state){hardwareBusy=state.playing;const isTest=['calibration','cloud-calibration'].includes(state.mode);if(isTest&&state.playing){$('actionStatus').textContent=state.mode==='cloud-calibration'?`API head test running · ${state.frames} color commands accepted. Colors will hold, then restore.`:'LAN head test running…';$('calibrate').disabled=true}else if(!playing&&!starting)$('calibrate').disabled=!hasFlood();if(isTest&&!state.playing&&lastHardwareMode===state.mode)notice(state.error||(state.calibrationDone?'Head test finished. Starting controller state restored.':'Head test stopped.'),Boolean(state.error));lastHardwareMode=state.playing?state.mode:null;if(state.calibrationId){calibrationId=state.calibrationId;$('calibrationPanel').hidden=state.individualConfirmed;}if(state.calibrationId)$('calibrationStatus').textContent=state.calibrationDone?'Test finished. Confirm only if all six heads showed separate colors.':state.playing&&['calibration','cloud-calibration'].includes(state.mode)?'Test running…':'Test stopped before completion.';if(state.error){notice(state.error,true);if(playing)halt(false)}if(live&&!playing&&!starting&&!state.playing)live=false}

async function settingsSection(section){
 const mcp=section==='mcp';$('settingsApiPanel').hidden=section!=='api';$('settingsMcpPanel').hidden=!mcp;$('settingsLightsPanel').hidden=section!=='lights';$('settingsLightsTab').setAttribute('aria-pressed',String(section==='lights'));
 $('settingsApiTab').setAttribute('aria-pressed',String(section==='api'));$('settingsMcpTab').setAttribute('aria-pressed',String(mcp));
 if(mcp){try{const setup=await api('/api/mcp/setup');$('mcpConfig').value=JSON.stringify(setup.config,null,2);$('copyMcpConfig').disabled=false;$('mcpSetupStatus').textContent='MCP server available · local stdio transport';}catch(error){$('mcpSetupStatus').textContent=error.message;$('copyMcpConfig').disabled=true;}}
}
$('settingsLightsTab').onclick=()=>settingsSection('lights');$('manageLights').onclick=()=>{openSettings();settingsSection('lights')};
$('settingsApiTab').onclick=()=>settingsSection('api');$('settingsMcpTab').onclick=()=>settingsSection('mcp');
$('copyMcpConfig').onclick=async()=>{try{await navigator.clipboard.writeText($('mcpConfig').value);$('mcpSetupStatus').textContent='Configuration copied.';}catch(error){$('mcpConfig').focus();$('mcpConfig').select();$('mcpSetupStatus').textContent='Select and copy the configuration with Ctrl+C.';}};
function openSettings(firstRun=false){settingsSection('api');$('settingsTitle').textContent=firstRun?'Connect your lights':'Settings';$('settingsDialog').showModal();$('apiKey').focus()}
$('openSettings').onclick=()=>openSettings();
$('skipSetup').onclick=()=>{$('settingsDialog').close();notice('Enable LAN Control and use Find lights for local playback.');};
$('closeSettings').onclick=()=>$('settingsDialog').close();
$('settingsDialog').onclick=event=>{if(event.target===$('settingsDialog'))$('settingsDialog').close()};
function showCloud(state){
  cloudKeySaved=Boolean(state.keySaved);

  $('cloudStatus').textContent=state.connected?`Connected · ${state.deviceCount} devices`:(state.keySaved?'Key saved · disconnected':'Not connected');

  $('disconnectCloud').disabled=!state.connected;

  if(!state.connected){$('cloudCapabilities').textContent='';return}

  $('cloudCapabilities').textContent=state.floods.length?state.floods.map(f=>`${f.name}: individual color ${f.segmentColor?'available':'not reported'}, individual brightness ${f.segmentBrightness?'available':'not reported'}.`).join(' '):'Connected, but no H7062 flood controller was returned by Govee.';

}

$('cloudForm').onsubmit=async event=>{

  event.preventDefault();if(!$('apiKey').value.trim()&&!cloudKeySaved){$('setupStatus').textContent='Enter your Govee API key, or continue without one.';$('setupStatus').classList.add('error');$('apiKey').focus();return}$('setupStatus').textContent='';$('connectCloud').disabled=true;$('cloudStatus').textContent='Connecting…';

  try{const state=await api($('apiKey').value?'/api/cloud/connect':'/api/cloud/reconnect', $('apiKey').value?{apiKey:$('apiKey').value}:{});if(!state.connected)throw new Error('Paste your API key to save and connect.');showCloud(state);$('setupStatus').textContent='API key saved on this computer. Govee connected.';$('setupStatus').classList.remove('error');notice('API key saved securely. Govee connected. Flood capabilities are shown above. Cloud connection does not enable unverified LAN segment playback.');}

  catch(error){$('cloudStatus').textContent='Connection failed';$('setupStatus').textContent=error.message;$('setupStatus').classList.add('error');notice(error.message,true);}

  finally{$('apiKey').value='';$('connectCloud').disabled=false;}

};

$('disconnectCloud').onclick=async()=>{try{showCloud(await api('/api/cloud/disconnect',{}));$('apiKey').value='';notice('Govee disconnected. Your API key remains saved.');}catch(error){notice(error.message,true)}};

setTimeout(()=>api('/api/cloud/status').then(showCloud).catch(()=>{}),16000);
api('/api/cloud/status').then(state=>{showCloud(state);if(!state.keySaved&&!state.connected)openSettings(true)}).catch(error=>notice(error.message,true));

async function init(){try{const saved=await api('/api/project');await verifyServer();if(saved){validateProject(saved);saved.tracks.forEach(tr=>tr.keys.forEach(k=>{if(!k.id)k.id=uid()}));project=saved;$('loop').checked=project.loop===true;selectedKey=project.tracks[0].keys[0].id}render();if(project.audioRef)await restoreAudio();applyStatus(await api('/api/status'));statusTimer=setInterval(async()=>{try{await verifyServer();const state=await api('/api/status');applyStatus(state);if(live&&playing&&!state.playing){await halt(false);notice(state.error||(state.restored===true?'Live playback finished; controller restoration confirmed by readback.':'Live playback finished; controller restoration is unconfirmed.'),Boolean(state.error)||state.restored!==true)}}catch(e){if(live)notice('Hardware status unavailable: '+e.message,true)}},750)}catch(e){render();notice(e.message,true)}}

init().then(()=>refreshShows()).catch(e=>notice('Saved shows unavailable: '+e.message,true));


function ensureLayout(){if(!project.layout)project.layout={fixtures:project.tracks.map((_,i)=>({x:12+(i%6)*15.2,y:project.tracks.length===6?68:12+Math.floor(i/6)*76/Math.max(1,Math.ceil(project.tracks.length/6)-1),angle:0}))};}
function spatialOrder(){ensureLayout();return project.layout.fixtures.map((f,i)=>i).sort((a,b)=>project.layout.fixtures[a].x-project.layout.fixtures[b].x||project.layout.fixtures[a].y-project.layout.fixtures[b].y||a-b)}
let placementDrag=null;
let extraPlacementDrag=null;
function renderExtraLights(){
 const host=$('stageExtraLights'),lights=project.layout?.lights||[];
 if(extraPlacementDrag)return;host.replaceChildren();
 lights.forEach((f,i)=>{const b=document.createElement('button');b.className='stage-fixture extra-fixture';b.textContent=f.name;b.title=`${f.model} · Device controls`;b.style.left=f.x+'%';b.style.top=f.y+'%';
 b.onpointerdown=e=>{e.preventDefault();extraPlacementDrag={f,b,backup:clone(project),startX:e.clientX,startY:e.clientY,moved:false};b.setPointerCapture(e.pointerId)};
 b.onpointermove=e=>{const d=extraPlacementDrag;if(!d||d.b!==b)return;if(Math.hypot(e.clientX-d.startX,e.clientY-d.startY)>4)d.moved=true;if(!d.moved)return;const r=$('stageMap').getBoundingClientRect();f.x=Math.max(5,Math.min(95,(e.clientX-r.left)/r.width*100));f.y=Math.max(8,Math.min(92,(e.clientY-r.top)/r.height*100));b.style.left=f.x+'%';b.style.top=f.y+'%'};
 b.onpointerup=()=>{const d=extraPlacementDrag;if(!d)return;extraPlacementDrag=null;if(d.moved){undoStack.push(d.backup);redoStack=[];changed();}else{openSettings();settingsSection('lights');openDeviceControls(f.deviceId);}};
 b.onpointercancel=()=>{if(extraPlacementDrag){project=extraPlacementDrag.backup;extraPlacementDrag=null;render()}};host.append(b);});
}
function renderTabletPairing(urls){
 const host=$('tabletLinks');host.replaceChildren();
 if(!urls.length)throw Error('No Wi-Fi address found for pairing.');
 const label=document.createElement('label');label.textContent='Network address ';const select=document.createElement('select');select.setAttribute('aria-label','iPad network address');
 for(const url of urls){const option=document.createElement('option');option.value=url;option.textContent=new URL(url).hostname;select.append(option);}select.value=urls.find(url=>new URL(url).hostname.startsWith('192.168.'))||urls[0];label.append(select);
 const image=document.createElement('img');image.alt='Scan to open Light Bridge yard setup on your iPad';image.width=280;image.height=280;image.className='tablet-qr';
 const link=document.createElement('a');link.target='_blank';link.rel='noreferrer';link.textContent='Open yard setup';
 const hint=document.createElement('p');hint.textContent='Scan with your iPad camera while connected to the same Wi-Fi.';
 const update=()=>{const qr=qrcode(0,'M');qr.addData(select.value);qr.make();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(qr.createSvgTag({cellSize:6,margin:24,scalable:true}));link.href=select.value;};select.onchange=update;update();host.append(label,image,hint,link);
}
$('enableTablet').onclick=async()=>{try{const result=await api('/api/tablet/enable',{});renderTabletPairing(result.urls);$('tabletStatus').textContent='Pairing enabled for 8 hours. Anyone with this code on your network can arrange and identify lights. Keep it private.';}catch(e){$('tabletStatus').textContent=e.message}};
$('exitIdentify').onclick=async()=>{try{await api('/api/layout/identify/end',{});$('tabletStatus').textContent='Identify mode ended; controller states restored.';}catch(e){$('tabletStatus').textContent=e.message}};
$('disableTablet').onclick=async()=>{try{await api('/api/tablet/disable',{});$('tabletLinks').replaceChildren();$('tabletStatus').textContent='iPad access disabled.';}catch(e){$('tabletStatus').textContent=e.message}};
setInterval(async()=>{if(placementDrag||extraPlacementDrag)return;try{const remote=await api('/api/layout');if(remote.projectId!==(project.layoutId||project.libraryShowId||project.name)||remote.revision<=(project.layoutRevision||0))return;for(const f of remote.lights){if(f.key.startsWith('track:')){const i=Number(f.key.slice(6));if(project.layout?.fixtures[i])Object.assign(project.layout.fixtures[i],{x:f.x,y:f.y});}else{const local=project.layout?.lights?.find(l=>l.deviceId===f.deviceId);if(local)Object.assign(local,{x:f.x,y:f.y});}}project.layoutRevision=remote.revision;renderStage();}catch{}},3000);
function renderStage(){
  ensureLayout();const container=$('stageFixtures'),connected=hasFlood(),basic=document.body.classList.contains('basic-view'),searching=discoveryBusy||lightStateBusy;
  $('stageEmpty').querySelector('strong').textContent=searching?'Searching for Lights...':discoveryFailed?'No lights found':'No lights connected';
  $('stageEmpty').querySelector('p').textContent=searching?'Checking your network for supported lights.':'Use Find lights with LAN Control enabled. Your layout appears after a flood controller responds.';
  container.hidden=!connected&&(basic||!virtualPreview);$('stageEmpty').hidden=connected||(!basic&&virtualPreview);$('showVirtualPreview').hidden=basic||connected;
  $('lamps').hidden=!connected&&!virtualPreview;
  $('deviceLabel').textContent=project.controllers?.length?`${project.controllers.length} flood sets · ${project.tracks.length} heads · ${connected?'connected':'one or more sets unavailable'}`:searching&&!connected?'Searching for Lights...':connected?(discoveredFlood?`Flood set ${discoveredFlood.id.slice(-5)} · six heads`:'H7062 · controller responding · six physical heads'):(virtualPreview?'Saved layout · no flood controller connected':'No flood controller connected · saved tracks are retained');
  $('manualTarget').disabled=!connected;$('manualApply').disabled=!connected;
  $('calibrate').disabled=!connected||hardwareBusy;
  $('stageHeading').textContent=`Light layout · ${project.tracks.length+(project.layout.lights?.length||0)} lights`;renderExtraLights();
  const targets=$('manualTarget'),previous=targets.value;if(targets.options.length!==project.tracks.length+1){targets.replaceChildren(new Option('All timeline lights','all'));project.tracks.forEach((_,i)=>targets.add(new Option(trackLabel(i),String(i))));targets.value=[...targets.options].some(o=>o.value===previous)?previous:'all';}project.tracks.forEach((_,i)=>targets.options[i+1].textContent=trackLabel(i));$('stageMap').style.height=project.tracks.length>12?Math.min(900,Math.ceil(project.tracks.length/6)*72)+'px':'';
  $('liveColorStatus').textContent=searching&&!connected?'Searching for Lights...':connected?`${discoveredFlood?'H7062 connected':'H7062 controller responding'} · ${Object.values(currentLightState?.lastApplied||{}).some(s=>s)?'Icons show last applied colors; other heads unknown':'Individual colors unknown until applied'}`:'No flood controller connected. Use Find lights to discover your hardware.';

  if(container.children.length!==project.tracks.length)container.replaceChildren();
  if(!container.children.length)project.tracks.forEach((_,i)=>{
    const button=document.createElement('button');button.className='stage-fixture';button.innerHTML='<span class="beam"></span><span class="fixture-core"></span><span class="fixture-number"></span><span class="fixture-caption"></span>';
    button.onpointerdown=e=>{if(playing||starting)return;e.preventDefault();selectedTrack=i;selectedKey=project.tracks[i].keys[0].id;placementDrag={index:i,startX:e.clientX,startY:e.clientY,backup:clone(project),moved:false};button.setPointerCapture(e.pointerId);render()};
    button.onclick=()=>{if(!playing&&!starting){if(document.body.classList.contains('basic-view'))$('manualTarget').value=i;syncManualReadback();choose(i)}};
    button.onkeydown=e=>{if(playing||starting)return;const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!delta)return;e.preventDefault();record();const f=project.layout.fixtures[i];f.x=Math.max(5,Math.min(95,f.x+delta[0]));f.y=Math.max(8,Math.min(92,f.y+delta[1]));changed()};
    container.append(button);
  });
  project.tracks.forEach((track,i)=>{const f=project.layout.fixtures[i],button=container.children[i],state=(document.body.classList.contains('basic-view')?basicIconState(i):evaluateTrack(track,position)),color=hex(document.body.classList.contains('basic-view')?state.color:rgbOutput(state));button.style.left=f.x+'%';button.style.top=f.y+'%';button.style.setProperty('--fixture-color',color);button.classList.toggle('selected',document.body.classList.contains('basic-view')?($('manualTarget').value==='all'||Number($('manualTarget').value)===i):i===selectedTrack);button.children[0].style.transform=`rotate(${f.angle}deg)`;button.children[0].style.opacity=state.on?state.intensity/100*.6:0;button.children[2].textContent=i+1;button.children[3].textContent=track.name;button.title=trackLabel(i);button.setAttribute('aria-label',`${track.name}, X ${Math.round(f.x)}%, Y ${Math.round(f.y)}%, ${document.body.classList.contains('basic-view')&&state.unknown?'color unknown':state.on?Math.round(state.intensity)+'%':'off'}`)});
  const f=project.layout.fixtures[selectedTrack];$('fixtureTitle').textContent=trackLabel(selectedTrack);
  for(const [id,value] of [['fixtureName',project.tracks[selectedTrack].name],['fixtureX',Math.round(f.x)],['fixtureY',Math.round(f.y)]]){if(document.activeElement!==$(id))$(id).value=value;$(id).disabled=playing||starting}
  $('resetLayout').disabled=playing||starting;
}
document.addEventListener('pointermove',e=>{if(!placementDrag)return;const d=placementDrag;if(Math.hypot(e.clientX-d.startX,e.clientY-d.startY)>3)d.moved=true;if(!d.moved)return;const rect=$('stageMap').getBoundingClientRect(),f=project.layout.fixtures[d.index];f.x=Math.max(5,Math.min(95,(e.clientX-rect.left)/rect.width*100));f.y=Math.max(8,Math.min(92,(e.clientY-rect.top)/rect.height*100));renderStage()});
function finishPlacement(cancel=false){if(!placementDrag)return;const d=placementDrag;placementDrag=null;if(cancel){project=d.backup;render();return}if(d.moved){undoStack.push(d.backup);redoStack=[];changed()}}
document.addEventListener('pointerup',()=>finishPlacement());document.addEventListener('pointercancel',()=>finishPlacement(true));
$('resetLayout').onclick=()=>edit(()=>{const extra=project.layout?.lights;delete project.layout;ensureLayout();if(extra)project.layout.lights=extra;});
$('fixtureName').onchange=()=>edit(()=>{const name=$('fixtureName').value.trim();if(!name)throw Error('Enter a flood name');project.tracks[selectedTrack].name=name.slice(0,80)});
for(const [id,field,min,max] of [['fixtureX','x',5,95],['fixtureY','y',8,92]])$(id).onchange=()=>edit(()=>{const value=Number($(id).value);if(!Number.isFinite(value)||value<min||value>max)throw Error(`Enter a value from ${min} to ${max}`);project.layout.fixtures[selectedTrack][field]=value});

$('manualIntensity').oninput=()=>{manualDirty=true;$('manualLevel').textContent=$('manualIntensity').value+'%';$('colorStateLabel').textContent='Pending change · click Apply';renderStage()};
for(const [name,color] of [['Red','#ff0000'],['Green','#00ff00'],['Blue','#0000ff'],['Cyan','#00ffff'],['Pink','#ff0080'],['Amber','#ff8000'],['Purple','#a000ff'],['White','#ffffff']]){const b=document.createElement('button');b.type='button';b.textContent=name;b.style.setProperty('--swatch',color);b.onclick=()=>{setManualColor(color)};$('manualPresets').append(b)}
$('manualForm').onsubmit=async e=>{e.preventDefault();$('manualApply').disabled=true;try{await halt(false);notice('Applying static look to your lights…');const target=$('manualTarget').value;const ids=target==='all'?(project.controllers?.map(c=>c.id)||[selectedDeviceId]):[trackDevice(Number(target))];let applied=0;for(const deviceId of ids){try{await api('/api/manual',{deviceId,target:target==='all'?'all':Number(target)%6,color:fromHex($('manualColor').value),intensity:Number($('manualIntensity').value),on:$('manualOn').checked});applied++;}catch(e){throw Error(`${applied} of ${ids.length} sets applied. ${e.message}`)}}manualDirty=false;await refreshLightState();notice(target==='all'?'Static look applied to all timeline lights.':`Flood ${Number(target)+1} command accepted by Govee. Changes can take a moment.`)}catch(error){notice(error.message,true)}finally{$('manualApply').disabled=!hasFlood()}};

function showPage(){const advanced=location.hash==='#advanced';(advanced?$('advancedLayoutHost'):$('basicLayoutHost')).append($('stageMap'));$('basicPage').hidden=advanced;$('advancedPage').hidden=!advanced;document.body.classList.toggle('basic-view',!advanced);$('pageTitle').textContent=advanced?'Make light move.':'Control your lights.';for(const [id,active] of [['basicLink',!advanced],['advancedLink',advanced]]){if(active)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current')}if(!advanced&&!playing&&!starting&&!hardwareBusy&&$('actionStatus').textContent==='Ready. Choose an output, then press Play.')$('actionStatus').textContent='Choose a color and intensity, then Apply.';renderStage();if(advanced)render();}
window.addEventListener('hashchange',()=>{showPage();if(!playing&&!starting&&!hardwareBusy&&['Choose a color and intensity, then Apply.','Ready. Choose an output, then press Play.'].includes($('actionStatus').textContent))$('actionStatus').textContent=location.hash==='#advanced'?'Ready. Choose an output, then press Play.':'Choose a color and intensity, then Apply.';});showPage();
if(document.body.classList.contains('basic-view'))$('notice').textContent='Basic control ready. Changes apply when you click Apply.';

function hsvRgb(h,s){const sector=h*6,c=1-s,x=1-s*Math.abs(sector%2-1);const colors=[[1,x,c],[x,1,c],[c,1,x],[c,x,1],[x,c,1],[1,c,x]];return colors[Math.floor(sector)%6].map(v=>Math.round(v*255))}
function colorHs(rgb){const c=rgb.map(v=>v/255),max=Math.max(...c),min=Math.min(...c),delta=max-min;let h=0;if(delta){if(max===c[0])h=((c[1]-c[2])/delta)%6;else if(max===c[1])h=(c[2]-c[0])/delta+2;else h=(c[0]-c[1])/delta+4;}return [((h/6)%1+1)%1,max?delta/max:0]}
let wheelBase=null;
function drawColorWheel(){const canvas=$('colorWheel'),ctx=canvas.getContext('2d'),size=canvas.width,r=size/2-6;if(!wheelBase){wheelBase=ctx.createImageData(size,size);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const dx=x-size/2,dy=y-size/2,d=Math.hypot(dx,dy);if(d>r)continue;const hue=(Math.atan2(dy,dx)/(2*Math.PI)+1)%1,rgb=hsvRgb(hue,d/r),offset=(y*size+x)*4;wheelBase.data.set([...rgb,255],offset)}}ctx.putImageData(wheelBase,0,0);const [h,s]=colorHs(fromHex($('manualColor').value)),angle=h*Math.PI*2,x=size/2+Math.cos(angle)*s*r,y=size/2+Math.sin(angle)*s*r;ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.strokeStyle='#101a28';ctx.lineWidth=5;ctx.stroke();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();$('manualHex').textContent=$('manualColor').value.toUpperCase();for(const chip of $('manualPresets').children)chip.setAttribute('aria-pressed',String(chip.style.getPropertyValue('--swatch').toLowerCase()===$('manualColor').value.toLowerCase()))}
function setManualColor(value){manualDirty=true;$('colorStateLabel').textContent='Pending change · click Apply';$('manualColor').value=value;drawColorWheel();renderStage()}
function pickWheel(e){const rect=$('colorWheel').getBoundingClientRect(),dx=(e.clientX-rect.left)/rect.width*220-110,dy=(e.clientY-rect.top)/rect.height*220-110,hue=(Math.atan2(dy,dx)/(2*Math.PI)+1)%1,saturation=Math.min(1,Math.hypot(dx,dy)/104);setManualColor(hex(hsvRgb(hue,saturation)))}
$('colorWheel').onpointerdown=e=>{e.preventDefault();$('colorWheel').setPointerCapture(e.pointerId);pickWheel(e)};
$('colorWheel').onpointermove=e=>{if($('colorWheel').hasPointerCapture(e.pointerId))pickWheel(e)};
$('colorWheel').onpointerup=e=>{$('colorWheel').releasePointerCapture(e.pointerId)};
$('manualColor').oninput=()=>{manualDirty=true;$('colorStateLabel').textContent='Pending change · click Apply';drawColorWheel();renderStage()};$('manualTarget').onchange=()=>{if($('manualTarget').value!=='all')selectedTrack=Number($('manualTarget').value);syncManualReadback();renderStage()};$('manualOn').onchange=()=>{manualDirty=true;renderStage()};drawColorWheel();

function basicIconState(index){const last=stateFor(index)?.lastApplied?.[index%6];return last||{on:false,intensity:0,color:[40,50,65],unknown:true};}
function syncManualReadback(){manualDirty=false;if(!currentLightState)return;const target=$('manualTarget').value,state=target==='all'?currentLightState:stateFor(Number(target)),last=target==='all'?null:state?.lastApplied?.[Number(target)%6];const c=state?.controller;const s=last||(c?{on:c.onOff===1,intensity:c.brightness,color:['r','g','b'].map(k=>c.color?.[k]||0)}:null);if(!s)return;$('manualColor').value=hex(s.color);$('manualIntensity').value=s.intensity;$('manualLevel').textContent=s.intensity+'%';$('manualOn').checked=s.on;drawColorWheel();$('colorStateLabel').textContent=last?'Last applied to this flood':'Controller color · per-head readback unavailable';}
async function refreshLightState(){if(lightStateBusy||discoveryBusy||discoveryFailed)return;const generation=deviceGeneration;lightStateBusy=true;renderStage();try{const ids=project.controllers?.map(c=>c.id)||[selectedDeviceId];for(const id of ids){const result=await api('/api/light-state'+(id?'?deviceId='+encodeURIComponent(id):''));if(generation!==deviceGeneration)return;if(id)lightStates[id]=result;currentLightState=result;}lightStateBusy=false;await refreshDevices();if(!manualDirty)syncManualReadback();renderStage()}catch(error){if(generation===deviceGeneration){currentLightState=null;renderStage();$('liveColorStatus').textContent='State refresh failed: '+error.message;console.error('Light state refresh failed',error);}}finally{lightStateBusy=false;renderStage()}}
$('showVirtualPreview').onclick=()=>{virtualPreview=true;renderStage()};
refreshLightState();setInterval(()=>{if(document.body.classList.contains('basic-view'))refreshLightState()},2500);

// Keep ownership of a slider gesture, including movements outside its track.
let intensityPointer=null;
function dragIntensity(e){const slider=$('manualIntensity'),rect=slider.getBoundingClientRect(),padding=10;const fraction=Math.max(0,Math.min(1,(e.clientX-rect.left-padding)/Math.max(1,rect.width-2*padding)));slider.value=Math.round(fraction*100);slider.oninput();}
$('manualIntensity').onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();manualDirty=true;intensityPointer=e.pointerId;$('manualIntensity').focus();$('manualIntensity').setPointerCapture(e.pointerId);dragIntensity(e)};
$('manualIntensity').onpointermove=e=>{if(e.pointerId!==intensityPointer)return;e.preventDefault();e.stopPropagation();dragIntensity(e)};
$('manualIntensity').onpointerup=e=>{if(e.pointerId!==intensityPointer)return;e.stopPropagation();dragIntensity(e);intensityPointer=null;$('manualIntensity').releasePointerCapture(e.pointerId)};
$('manualIntensity').onpointercancel=()=>{intensityPointer=null};

let timeSliderPointer=null;
function dragTimeSlider(e){const slider=$('scrub'),rect=slider.getBoundingClientRect(),padding=10,fraction=Math.max(0,Math.min(1,(e.clientX-rect.left-padding)/Math.max(1,rect.width-2*padding)));seek(Math.round(fraction*project.duration*1000)/1000,true)}
$('scrub').onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();timeSliderPointer=e.pointerId;$('scrub').focus();$('scrub').setPointerCapture(e.pointerId);dragTimeSlider(e)};
$('scrub').onpointermove=e=>{if(e.pointerId!==timeSliderPointer)return;e.preventDefault();e.stopPropagation();dragTimeSlider(e)};
$('scrub').onpointerup=e=>{if(e.pointerId!==timeSliderPointer)return;e.stopPropagation();dragTimeSlider(e);timeSliderPointer=null;$('scrub').releasePointerCapture(e.pointerId)};
$('scrub').onpointercancel=()=>{timeSliderPointer=null};
async function navigateKey(direction){await halt(false);const keys=project.tracks[selectedTrack].keys;let key;if(direction===0)key=keys[0];else if(direction<0)key=[...keys].reverse().find(k=>k.t<position-.0005);else key=keys.find(k=>k.t>position+.0005);if(!key)return;selectedKey=key.id;seek(direction===0?0:key.t);render();}
$('animStart').onclick=()=>navigateKey(0);$('previousKey').onclick=()=>navigateKey(-1);$('nextKey').onclick=()=>navigateKey(1);

$('ruler').onclick=e=>{const rect=$('ruler').getBoundingClientRect();seek(Math.round(Math.max(0,(e.clientX-rect.left-120-timePadding)/pxScale())*1000)/1000,true)};
$('scrub').onclick=e=>{e.preventDefault();e.stopPropagation();dragTimeSlider(e)};

let timelineResizeFrame;window.addEventListener("resize",()=>{cancelAnimationFrame(timelineResizeFrame);timelineResizeFrame=requestAnimationFrame(()=>{if(location.hash==="#advanced"&&!drag&&!marquee)render()})});

document.addEventListener('keydown',e=>{if(location.hash!=='#advanced'||e.code!=='Space'||e.repeat||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||e.target.closest('input,textarea,select,[contenteditable="true"],dialog'))return;e.preventDefault();if(playing)halt(false);else if(!starting)play()});

// Vendored qrcode-generator 2.0.4 (MIT). Kept local; pairing tokens are never sent to external QR services.
//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\u0020width="';
      img += size;
      img += '"';
      img += '\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();

(function (factory) {
  if (typeof define === 'function' && define.amd) {
      define([], factory);
  } else if (typeof exports === 'object') {
      module.exports = factory();
  }
}(function () {
    return qrcode;
}));
