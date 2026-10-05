import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateTrack,rgbOutput,validateProject,beatGrid,detectBeats,pulseKeys} from '../timeline.js';
const key=(t,intensity,color,ease='linear',on=true)=>({t,intensity,color,ease,on});
test('linear color and intensity agree at midpoint and exact end',()=>{
  const track={keys:[key(0,0,[255,0,0]),key(2,100,[0,0,255])]};
  assert.deepEqual(evaluateTrack(track,1),{on:true,intensity:50,color:[128,0,128]});
  assert.deepEqual(evaluateTrack(track,2),{on:true,intensity:100,color:[0,0,255]});
});
test('jump holds until target; on/off is discrete',()=>{
  const track={keys:[key(0,40,[255,0,0],'jump'),key(2,90,[0,255,0],'linear',false)]};
  assert.deepEqual(evaluateTrack(track,1.999),{on:true,intensity:40,color:[255,0,0]});
  assert.equal(evaluateTrack(track,2).on,false);
  assert.deepEqual(rgbOutput(evaluateTrack(track,2)),[0,0,0]);
});
test('steady tempo supports offset and preserves precision',()=>assert.deepEqual(beatGrid(2,120,.25),[.25,.75,1.25,1.75]));
test('silence produces no beat candidates',()=>assert.deepEqual(detectBeats(new Float32Array(44100),44100).beats,[]));
test('synthetic 120 BPM clicks produce correctly timed hit markers',()=>{
  const rate=22050,data=new Float32Array(rate*4),times=[.5,1,1.5,2,2.5,3,3.5];
  for(const t of times)for(let i=0;i<rate*.025;i++)data[Math.floor(t*rate)+i]=Math.sin(i*1.7)*Math.exp(-i/(rate*.01));
  const {beats}=detectBeats(data,rate);
  assert.equal(beats.length,times.length);
  beats.forEach((t,i)=>assert.ok(Math.abs(t-times[i])<.04,`${t} vs ${times[i]}`));
});
test('chase assigns consecutive beats to consecutive floods',()=>{
  const beats=beatGrid(3,120),color=[255,80,0];
  for(let i=0;i<6;i++){
    const keys=pulseKeys(beats,3,i,'chase',color,60);
    assert.equal(evaluateTrack({keys},i*.5).intensity,60);
    assert.equal(evaluateTrack({keys},i*.5+.3).intensity,0);
  }
});
test('reject duplicate time, invalid RGB and non-finite values',()=>{
  const project={version:1,duration:3,tracks:Array.from({length:6},()=>({keys:[key(0,50,[20,40,60])]}))};
  assert.doesNotThrow(()=>validateProject(project));
  const duplicate=structuredClone(project);duplicate.tracks[0].keys.push(key(0,20,[1,2,3]));assert.throws(()=>validateProject(duplicate));
  const invalid=structuredClone(project);invalid.tracks[0].keys[0].color=[300,0,0];assert.throws(()=>validateProject(invalid));
  const nan=structuredClone(project);nan.duration=NaN;assert.throws(()=>validateProject(nan));
});
