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
$('enableTablet').onclick=async()=>{try{const result=await api('/api/tablet/enable',{});$('tabletLinks').replaceChildren();for(const url of result.urls){const link=document.createElement('a');link.href=url;link.textContent=url;link.target='_blank';link.rel='noreferrer';$('tabletLinks').append(link,document.createElement('br'));}$('tabletStatus').textContent='Pairing enabled for 8 hours. Anyone with this link on your network can arrange and identify lights. Keep it private.';}catch(e){$('tabletStatus').textContent=e.message}};
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
