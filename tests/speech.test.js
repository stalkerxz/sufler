import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechFollower } from '../src/speech.js';

function fixture() {
  const instances = [], transcripts = [], states = [], errors = [], scheduled = [];
  const activeTasks = new Map();
  let taskId = 0;
  class Recognition {
    constructor() { instances.push(this); }
    start() { this.started = true; this.onstart?.(); }
    abort() { this.aborted = true; }
  }
  const follower = new SpeechFollower({ Recognition, onTranscript: (...args) => transcripts.push(args), onState: s => states.push(s), onError: e => errors.push(e), schedule: (fn, delay) => { const id = ++taskId; activeTasks.set(id, {fn,delay}); scheduled.push(fn); return id; }, cancel: id => activeTasks.delete(id) });
  return { follower, instances, transcripts, states, errors, scheduled, activeTasks };
}
const result = (text, final = false) => Object.assign([{ transcript: text }], { isFinal: final });
test('does not activate microphone before start and configures chosen language', () => {
  const f = fixture(); assert.equal(f.instances.length, 0);
  f.follower.start('ru-RU'); assert.equal(f.instances.length, 1);
  assert.equal(f.instances[0].lang, 'ru-RU'); assert.equal(f.instances[0].interimResults, true);
  assert.equal(f.states.at(-1), 'listening');
});
test('a final result is delivered once, interim updates have a stable result ID', () => {
  const f = fixture(); f.follower.start('ru-RU'); const r = f.instances[0];
  r.onresult({ resultIndex: 0, results: [result('привет')] });
  r.onresult({ resultIndex: 0, results: [result('привет мир', true)] });
  r.onresult({ resultIndex: 0, results: [result('привет мир', true)] });
  assert.equal(f.transcripts.length, 2);
  assert.equal(f.transcripts[0][1].id, f.transcripts[1][1].id);
});
test('pause aborts and detaches callbacks; stale events cannot restart', () => {
  const f = fixture(); f.follower.start('ru-RU'); const oldEnd = f.instances[0].onend;
  f.follower.stop(); oldEnd();
  assert.equal(f.instances[0].aborted, true); assert.equal(f.instances[0].onresult, null);
  assert.equal(f.activeTasks.size, 0);
});
test('normal browser disconnect reconnects, then pause cancels a pending reconnect', () => {
  const f = fixture(); f.follower.start('en-US'); f.instances[0].onend();
  assert.equal(f.states.at(-1), 'reconnecting'); f.scheduled.at(-1)();
  assert.equal(f.instances.length, 2); assert.equal(f.instances[1].lang, 'en-US');
  f.instances[1].onend(); const reconnect = f.scheduled.at(-1); f.follower.stop(); reconnect(); assert.equal(f.instances.length, 2);
});
test('permission and network failures stop, expose an actionable message, and do not retry', () => {
  for (const error of ['not-allowed', 'network', 'audio-capture']) {
    const f = fixture(); f.follower.start('ru-RU'); const end = f.instances[0].onend;
    f.instances[0].onerror({ error }); end();
    assert.equal(f.follower.active, false); assert.equal(f.errors.length, 1); assert.equal(f.activeTasks.size, 0);
  }
});
test('unsupported browsers give a usable fallback', () => {
  let message = ''; const follower = new SpeechFollower({ onError: e => { message = e; } });
  follower.start('ru-RU'); assert.match(message, /По скорости/);
});
test('reconnection loop is bounded when a browser repeatedly ends without results', () => {
  const f = fixture(); f.follower.start('ru-RU');
  for (let i = 0; i < 5; i++) { f.instances.at(-1).onend(); f.scheduled.at(-1)(); }
  f.instances.at(-1).onend(); assert.equal(f.errors.length, 1); assert.equal(f.follower.active, false);
});
test('constructor failure is handled without an uncaught exception', () => {
  const errors = [];
  class BrokenRecognition { constructor() { throw new Error('Disabled'); } }
  const follower = new SpeechFollower({ Recognition: BrokenRecognition, onError: e => errors.push(e), onState: () => {} });
  assert.doesNotThrow(() => follower.start('ru-RU'));
  assert.equal(follower.active, false); assert.equal(errors.length, 1);
});
test('start failures abort the recognition instance', () => {
  const f = fixture(); f.follower.Recognition.prototype.start = function () { throw new Error('Denied'); };
  f.follower.start('ru-RU'); assert.equal(f.errors.length, 1);
  assert.equal(f.instances[0].aborted, true); assert.equal(f.activeTasks.size, 0);
});
test('a silent failed start times out; normal start clears the watchdog', () => {
  const f = fixture(); f.follower.Recognition.prototype.start = () => {};
  f.follower.start('ru-RU'); const timeout = [...f.activeTasks.values()].find(t => t.delay === 12000);
  assert.ok(timeout); timeout.fn(); assert.equal(f.errors.length, 1); assert.equal(f.follower.active, false);
  const normal = fixture(); normal.follower.start('ru-RU'); assert.equal(normal.activeTasks.size, 0);
});

test('network errors carry a service code, distinct from microphone permission', () => {
  const f=fixture();const details=[];f.follower.onError=(message,detail)=>details.push(detail);
  f.follower.start('ru-RU');f.instances.at(-1).onerror({error:'network'});
  assert.equal(details[0].code,'network');
});
