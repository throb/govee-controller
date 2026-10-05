export function evaluateTrack(track,t){
  let a=track.keys[0],b=null;
  for(const k of track.keys.slice(1)){if(k.t<=t)a=k;else{b=k;break}}
  const u=b&&a.ease==='linear'?Math.max(0,Math.min(1,(t-a.t)/(b.t-a.t))):0;
  return {on:a.on,intensity:b?a.intensity+(b.intensity-a.intensity)*u:a.intensity,color:b?a.color.map((c,i)=>Math.round(c+(b.color[i]-c)*u)):[...a.color]};
}
export function rgbOutput(s){return s.color.map(c=>Math.round(c*(s.on?s.intensity/100:0)))}
export function validateProject(p){
  if(!p||p.version!==1||!Number.isFinite(p.duration)||p.duration<.1||p.duration>3600||!Array.isArray(p.tracks)||p.tracks.length!==6)throw Error('Invalid six-head project');
  let count=0;
  if(p.layout!==undefined){
    if(!p.layout||!Array.isArray(p.layout.fixtures)||p.layout.fixtures.length!==6)throw Error('Layout needs six flood placements');
    for(const f of p.layout.fixtures)if(!f||!Number.isFinite(f.x)||f.x<5||f.x>95||!Number.isFinite(f.y)||f.y<8||f.y>92||!Number.isFinite(f.angle)||f.angle< -180||f.angle>180)throw Error('Invalid flood placement');
  }
  for(const tr of p.tracks){
    if(!Array.isArray(tr.keys)||!tr.keys.length||tr.keys.length>5000)throw Error('Invalid track keyframes');
    tr.keys.sort((a,b)=>a.t-b.t);
    if(tr.keys[0].t!==0)throw Error('Each track needs a keyframe at zero');
    for(let i=0;i<tr.keys.length;i++){
      const k=tr.keys[i];count++;
      if(!Number.isFinite(k.t)||k.t<0||k.t>p.duration||typeof k.on!=='boolean'||!Number.isFinite(k.intensity)||k.intensity<0||k.intensity>100||!Array.isArray(k.color)||k.color.length!==3||k.color.some(c=>!Number.isInteger(c)||c<0||c>255)||!['linear','jump'].includes(k.ease))throw Error('Invalid keyframe');
      if(i&&Math.abs(k.t-tr.keys[i-1].t)<1e-6)throw Error('Duplicate keyframe time');
    }
  }
  if(count>12000)throw Error('Too many keyframes');
  if(p.beats!==undefined&&(!Array.isArray(p.beats)||p.beats.length>12000||p.beats.some(t=>!Number.isFinite(t)||t<0||t>p.duration)))throw Error('Invalid beat markers');
  return p;
}
export function beatGrid(duration,bpm,offset=0){
  if(!Number.isFinite(bpm)||bpm<20||bpm>300||!Number.isFinite(offset)||offset<0||offset>duration)throw Error('Invalid tempo or offset');
  const beats=[];for(let t=offset;t<=duration;t+=60/bpm)beats.push(Math.round(t*1000)/1000);return beats;
}
export function detectBeats(samples,rate,sensitivity=1.7){
  const hop=Math.max(1,Math.round(rate*.01)),window=Math.max(1,Math.round(rate*.03));
  const envelope=[];
  for(let start=0;start<samples.length;start+=hop){let energy=0;const end=Math.min(start+window,samples.length);for(let i=start;i<end;i++)energy+=samples[i]*samples[i];envelope.push(Math.sqrt(energy/(end-start)))}
  const maximum=Math.max(0,...envelope.slice(0,50000));
  if(maximum<1e-5)return {beats:[],envelope};
  const candidates=[];let previous=-Infinity;
  for(let i=2;i<envelope.length-2;i++){
    let total=0;const start=Math.max(0,i-70);for(let j=start;j<i;j++)total+=envelope[j];const baseline=total/Math.max(1,i-start);
    const value=envelope[i];
    if(value>maximum*.08&&value>baseline*sensitivity&&value>=envelope[i-1]&&value>envelope[i+1]&&i*hop/rate-previous>=.22){previous=i*hop/rate;candidates.push(Math.max(0,Math.round(previous*1000)/1000))}
  }
  return {beats:candidates,envelope};
}
export function waveform(samples,points=2000){
  const result=[];const step=Math.max(1,Math.ceil(samples.length/points));
  for(let i=0;i<samples.length;i+=step){let max=0;for(let j=i;j<Math.min(i+step,samples.length);j++)max=Math.max(max,Math.abs(samples[j]));result.push(max)}return result;
}
export function pulseKeys(beats,duration,index,pattern,color,intensity=65){
  const events=new Map();const put=(t,level,ease)=>{if(t>=0&&t<=duration)events.set(Math.round(t*1000)/1000,{t:Math.round(t*1000)/1000,on:true,intensity:level,color:[...color],ease})};
  put(0,0,'jump');
  beats.forEach((t,n)=>{
    if(pattern==='chase'&&n%6!==index)return;
    if(pattern==='alternate'&&n%2!==index%2)return;
    const interval=beats[n+1]===undefined?.5:beats[n+1]-t;
    put(t,intensity,'linear');put(t+Math.min(.25,interval*.65),0,'jump');
  });
  return [...events.values()].sort((a,b)=>a.t-b.t);
}
