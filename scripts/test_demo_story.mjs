import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readStory, frameSvg, DURATION} from '../docs/media/loop-scenes.mjs';
const original = JSON.parse(fs.readFileSync(new URL('../docs/media/cycle-evidence.json', import.meta.url)));
test('the captured story preserves work-item identity across fresh queue jobs', () => {
  assert.deepEqual(readStory(original).map(r => [r.id,r.deployedId]), [[1,5],[2,6],[3,3],[4,4],[5,7],[6,8]]);
});
for (const phase of ['first_deploy', 'agent_repair', 'resubmit', 'repaired_validation', 'second_deploy', 'remote_proof', 'next_batch_work', 'next_batch_sync', 'next_batch_submit', 'next_batch_validation', 'third_deploy', 'cycle_remote_proof', 'following_work_started']) {
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
test('the loop joins equal active-work poses instead of clearing the scene', () => {
  const story=readStory(original);
  assert.equal(frameSvg(0,story),frameSvg(DURATION,story));
  assert.match(frameSvg(DURATION-.05,story), /Working/);
  assert.doesNotMatch(frameSvg(DURATION-.05,story), /All.*applied/);
});
