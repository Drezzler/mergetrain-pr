import test from 'node:test';
import assert from 'node:assert/strict';
import {attachDemoLoop} from '../site/demo-loop.mjs';

class Element extends EventTarget {
  constructor(dataset = {}) { super(); this.dataset = dataset; this.hidden = true; this.textContent = ''; }
  getAttribute(name) { return this[name] || null; }
  fire(name) { this.dispatchEvent(new Event(name)); }
}
function fixture({blocked = false, reduced = false, saveData = false, delayed = false, Observer = null} = {}) {
  let release;
  const poster = new Element();
  poster.hidden = false;
  const button = new Element({play: 'Play loop', pause: 'Pause loop'});
  const status = new Element({unavailable: 'View the GIF instead.'});
  const video = new Element({loopSrc: 'demo.mp4'});
  video.paused = true; video.currentTime = 0; video.loads = 0; video.plays = 0;
  video.load = () => { video.loads++; video.error = null; };
  video.play = async () => {
    video.plays++;
    if (blocked) throw new Error('NotAllowedError');
    if (delayed) return new Promise(resolve => { release = () => { video.paused = false; video.fire('playing'); resolve(); }; });
    video.paused = false; video.fire('playing');
  };
  video.pause = () => { video.paused = true; video.fire('pause'); };
  const motion = new Element(); motion.matches = reduced;
  const elements = {video, '[data-loop-poster]': poster, '[data-loop-toggle]': button, '[data-loop-status]': status};
  attachDemoLoop({querySelector: key => elements[key]}, {motion, saveData, Observer});
  return {video, poster, button, status, motion, release: () => release(), allow: () => { blocked = false; }};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('muted playback starts, and the visible button pauses and resumes it', async () => {
  const f = fixture(); await settle();
  assert.equal(f.video.muted, true);
  assert.equal(f.video.paused, false);
  assert.equal(f.button.textContent, 'Pause loop');
  f.video.currentTime = 4;
  f.button.fire('click');
  assert.equal(f.video.paused, true);
  assert.equal(f.poster.hidden, true);
  assert.equal(f.button.textContent, 'Play loop');
  f.button.fire('click'); await settle();
  assert.equal(f.video.paused, false);
  assert.equal(f.video.loads, 1);
  f.button.fire('click');
});
test('blocked autoplay restores the poster and permits a tap to retry', async () => {
  const f = fixture({blocked: true}); await settle();
  assert.equal(f.poster.hidden, false);
  assert.equal(f.video.hidden, true);
  assert.equal(f.status.textContent, 'View the GIF instead.');
  f.allow(); f.button.fire('click'); await settle();
  assert.equal(f.poster.hidden, true);
  assert.equal(f.video.paused, false);
  assert.equal(f.status.textContent, '');
  f.button.fire('click');
});
for (const option of ['reduced', 'saveData']) {
  test(`${option} leaves a still poster until the visitor presses play`, async () => {
    const f = fixture({[option]: true}); await settle();
    assert.equal(f.video.plays, 0);
    assert.equal(f.video.src, undefined);
    assert.equal(f.poster.hidden, false);
    f.button.fire('click'); await settle();
    assert.equal(f.video.paused, false);
    f.button.fire('click');
  });
}
test('a media error restores the readable poster', async () => {
    const f = fixture(); await settle();
    f.video.fire('error');
    assert.equal(f.poster.hidden, false);
    assert.equal(f.video.hidden, true);
    assert.equal(f.video.paused, true);
});
test('changing the motion preference stops a playing loop', async () => {
  const f = fixture(); await settle();
  const event = new Event('change'); event.matches = true;
  f.motion.dispatchEvent(event);
  assert.equal(f.video.paused, true);
});

test('a late play result cannot restart playback after the visitor cancels', async () => {
  const f = fixture({delayed: true});
  assert.equal(f.button.textContent, 'Pause loop');
  f.button.fire('click');
  assert.equal(f.poster.hidden, false);
  assert.equal(f.video.hidden, true);
  assert.equal(f.status.textContent, '');
  f.release(); await settle();
  assert.equal(f.video.paused, true);
  assert.equal(f.button.textContent, 'Play loop');
});
test('an offscreen loop keeps its poster and does not request video data', async () => {
  let show;
  class Observer {
    constructor(callback) { show = callback; }
    observe() {}
    disconnect() {}
  }
  const f = fixture({Observer}); await settle();
  assert.equal(f.video.src, undefined);
  assert.equal(f.status.textContent, '');
  assert.equal(f.poster.hidden, false);
  show([{isIntersecting: true}]); await settle();
  assert.equal(f.video.paused, false);
  f.button.fire('click');
});
