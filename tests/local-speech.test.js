import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSpeechFollower, encodePCM16 } from '../src/local-speech.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({pendingMedia=false}={}) {
  const states=[],errors=[],transcripts=[],requests=[],tracks=[];
  let capture, resolveMedia;
  class Context {
    constructor(){this.sampleRate=48000;this.destination={};}
    resume(){return Promise.resolve();}
    close(){this.closed=true;return Promise.resolve();}
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
    createScriptProcessor(){capture={connect(){},disconnect(){}};return capture;}
  }
  const stream={getTracks:()=>tracks}; tracks.push({stopped:false,stop(){this.stopped=true;}});
  const follower=new LocalSpeechFollower({
    onState:s=>states.push(s),onError:(...e)=>errors.push(e),onTranscript:(...t)=>transcripts.push(t),
    AudioContext:Context, WorkletNode:null,
    mediaDevices:{getUserMedia:()=>pendingMedia?new Promise(resolve=>{resolveMedia=resolve;}):Promise.resolve(stream)},
    fetchImpl:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>url.endsWith('/start')?{session:'session-a'}:url.includes('/audio')?{text:'говорите в своём темпе',utterance:0,isFinal:false}:{stopped:true}};}
  });
  return {follower,states,errors,transcripts,requests,tracks,getCapture:()=>capture,grant:()=>resolveMedia(stream)};
}
test('PCM conversion clips and resamples to little-endian 16 kHz',()=>{
  const data=encodePCM16(new Float32Array([1,1,1,-1,-1,-1]),48000);
  const view=new DataView(data);assert.equal(data.byteLength,4);assert.equal(view.getInt16(0,true),32767);assert.equal(view.getInt16(2,true),-32768);
});
test('local capture sends PCM to the authenticated loopback route and follows partial results',async()=>{
  const f=fixture();await f.follower.start('ru-RU',{ready:true,token:'test-token'});
  assert.equal(f.states.at(-1),'listening-local');
  f.getCapture().onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4096)},outputBuffer:{getChannelData:()=>new Float32Array(4096)}});
  await tick();assert.equal(f.transcripts.length,1);assert.match(f.transcripts[0][1].id,/local:/);
  assert.equal(f.requests[1].options.headers['X-Sufler-Token'],'test-token');assert.ok(f.requests[1].options.body instanceof ArrayBuffer);
  f.follower.stop();assert.equal(f.tracks[0].stopped,true);assert.equal(f.getCapture().onaudioprocess,null);assert.ok(f.requests.some(r=>r.url.includes('/stop')));assert.equal(f.errors.length,0);
});
test('pause while permission is pending closes the stream as soon as it arrives',async()=>{
  const f=fixture({pendingMedia:true});const pending=f.follower.start('ru-RU',{ready:true,token:'test-token'});
  await tick();f.follower.stop();f.grant();await pending;
  assert.equal(f.tracks[0].stopped,true);assert.equal(f.states.includes('listening-local'),false);
});
test('local permission errors have a microphone-specific code',async()=>{
  const f=fixture();f.follower.mediaDevices.getUserMedia=async()=>{const e=new Error('Denied');e.name='NotAllowedError';throw e;};
  await f.follower.start('ru-RU',{ready:true,token:'test-token'});assert.equal(f.errors[0][1].code,'not-allowed');assert.equal(f.follower.active,false);
});
test('failure of local processing stops capture instead of switching to a remote provider',async()=>{
  const f=fixture();await f.follower.start('ru-RU',{ready:true,token:'test-token'});
  f.follower.fetchImpl=async()=>{throw new Error('Stopped server');};
  f.getCapture().onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4096)}});
  await tick();assert.equal(f.tracks[0].stopped,true);assert.equal(f.errors[0][1].code,'local-engine');
});
