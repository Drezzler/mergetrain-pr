import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readStory, frameSvg, sceneAt, DURATION, TIMELINE, storyTime} from '../docs/media/loop-scenes.mjs';
const original = JSON.parse(fs.readFileSync(new URL('../docs/media/cycle-evidence.json', import.meta.url)));
test('the captured story preserves work-item identity across fresh queue jobs', () => {
  assert.deepEqual(readStory(original).map(r => [r.id,r.deployedId]), [[1,5],[2,6],[3,3],[4,4],[5,7],[6,8]]);
});
for (const phase of ['first_deploy', 'agent_repair', 'resubmit', 'repaired_validation', 'second_deploy', 'remote_proof', 'next_batch_work', 'next_batch_sync', 'next_batch_submit', 'next_batch_validation', 'third_deploy', 'cycle_remote_proof', 'following_work_started', 'following_work_during_validation']) {
  test(`the renderer refuses a repair story without ${phase} evidence`, () => {
    const evidence=structuredClone(original);
    evidence.records=evidence.records.filter(r=>r.phase!==phase);
    assert.throws(()=>readStory(evidence));
  });
}
test('a replacement pinned to the old commit cannot be presented as repaired', () => {
  const evidence=structuredClone(original);
  const retry=evidence.records.find(r=>r.phase==='resubmit' && r.command.includes('retry 1'));
  const payload=JSON.parse(retry.stdout);
  payload.job.head_sha=evidence.proof.revisions[0].before;
  retry.stdout=JSON.stringify(payload);
  assert.throws(()=>readStory(evidence), /replacement proof/);
});
test('work committed after validation cannot be claimed as overlapping', () => {
  const evidence=structuredClone(original);
  const commit=evidence.records.find(r=>r.phase==='next_batch_work' && r.command.startsWith('git commit'));
  commit.started_seconds=evidence.proof.overlap.validation_finished_seconds+1;
  assert.throws(()=>readStory(evidence), /next-batch proof/);
});
test('the next batch must build on the first applied result and refresh its commit', () => {
  for (const field of ['base', 'submitted_head']) {
    const evidence=structuredClone(original);
    evidence.proof.next_batch[0][field]=evidence.proof.next_batch[0].during_validation_head;
    assert.throws(()=>readStory(evidence), /next-batch proof/);
  }
});
test('the next work must remain an unsubmitted draft on the final applied base', () => {
  const evidence=structuredClone(original);
  evidence.proof.following_drafts[0].state='deployed';
  assert.throws(()=>readStory(evidence), /following drafts/);
});
test('the first five seconds show new work while earlier work is checked', () => {
  readStory(original);
  const opening=sceneAt(4.5);
  assert.deepEqual(opening.checking,['A','B']);
  assert.deepEqual(opening.rows.filter(r=>r.state==='Building').map(r=>r.work),['E','F']);
});
test('following drafts cannot be shown during checks without overlapping edit evidence', () => {
  const evidence=structuredClone(original);
  const edit=evidence.records.find(r=>r.phase==='following_work_during_validation' && r.branch);
  edit.finished_seconds=evidence.proof.draft_overlap.validation_finished_seconds+1;
  assert.throws(()=>readStory(evidence), /following-draft overlap/);
  assert.deepEqual(sceneAt(9.5).checking,['E','F']);
  assert.deepEqual(sceneAt(9.5).rows.filter(r=>r.state==='New draft').map(r=>r.work),['G','H']);
});
test('agent identities remain visible after their work leaves and through replay', () => {
  const story=readStory(original);
  for(const time of [0,1.7,3,4.5,7.1,9.5,12.4,13.9]) {
    const svg=frameSvg(time,story);
    assert.ok(svg.includes('data-processing="batch"'));
    assert.ok(svg.includes('Batch · default'));
    for(let id=1;id<=4;id++) assert.ok(svg.includes(`data-agent="${id}"`));
  }
  assert.equal(frameSvg(0,story),frameSvg(DURATION,story));
});
test('the faster batch story preserves passing work, repair and both overlaps', () => {
  assert.equal(DURATION,14);
  assert.deepEqual(sceneAt(2.4).added,['C','D']);
  assert.deepEqual(sceneAt(2.4).rows.slice(0,2).map(r=>r.state),['Fixing','Fixing']);
  assert.deepEqual(sceneAt(4.5).checking,['A','B']);
  assert.deepEqual(sceneAt(4.5).rows.slice(2).map(r=>r.work),['E','F']);
  assert.deepEqual(sceneAt(12.5).added,['C','D','A','B','E','F']);
  assert.deepEqual(sceneAt(12.5).rows.map(r=>r.work),['G','H','I','J']);
  for(let i=1;i<TIMELINE.length;i++) {
    assert.ok(TIMELINE[i][0]>TIMELINE[i-1][0]);
    assert.ok(TIMELINE[i][1]>TIMELINE[i-1][1]);
  }
  for(const [playback,logical] of TIMELINE.slice(0,-1))
    assert.ok(Math.abs(storyTime(playback)-logical)<1e-10);
  // The two logical replay phases still have time for at least one 20fps frame.
  assert.ok(storyTime(13.9)<23.9);
  assert.ok(storyTime(13.95)>=23.9);
});
test('two stable messages are supported by applied work, repair and ongoing next tasks', () => {
  const story=readStory(original);
  for(const seconds of [2,2.5]) {
    const state=sceneAt(seconds);
    assert.equal(state.message.id,'passing-first');
    assert.deepEqual(state.added,['C','D']);
    assert.ok(state.rows.slice(0,2).every(row=>row.state==='Fixing'));
  }
  for(const seconds of [4.5,9.5]) {
    const state=sceneAt(seconds);
    assert.equal(state.message.id,'keep-building');
    assert.equal(state.checking.length,2);
    assert.equal(state.rows.filter(row=>row.activity==='Next task').length,2);
  }
  assert.ok(sceneAt(13).rows.every(row=>row.activity==='Next task'));
  const messages=new Set();
  for(let frame=0;frame<DURATION*20;frame++) {
    const svg=frameSvg(frame/20,story);
    messages.add(svg.match(/data-message="([^"]+)"/)[1]);
    assert.ok(!svg.includes('Submitted'));
    assert.ok(!svg.includes('Checking A + B. Building E + F.'));
  }
  assert.deepEqual([...messages],['passing-first','keep-building']);
  const passing=frameSvg(2.5,story);
  assert.ok(passing.includes('data-applied-batch="CD"'));
  assert.ok(!passing.includes('data-applied-batch="AB"'));
  const poster=frameSvg(0,story,{poster:true});
  assert.ok(poster.includes('lands first.'));
  assert.ok(poster.includes('Keep building during checks.'));
});
