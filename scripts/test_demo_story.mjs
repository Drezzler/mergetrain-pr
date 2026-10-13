import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readStory} from '../docs/media/loop-scenes.mjs';
const original = JSON.parse(fs.readFileSync(new URL('../docs/media/repair-evidence.json', import.meta.url)));
test('the captured story preserves work-item identity across fresh queue jobs', () => {
  assert.deepEqual(readStory(original).map(r => [r.id,r.deployedId]), [[1,5],[2,6],[3,3],[4,4]]);
});
for (const phase of ['first_deploy', 'agent_repair', 'resubmit', 'repaired_validation', 'second_deploy', 'remote_proof']) {
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
