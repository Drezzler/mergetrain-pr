// A condensed illustration of recorded CLI results, not a product UI recording.
export const WIDTH = 960;
export const HEIGHT = 800;
export const DURATION = 24;
function readRepairStory(evidence) {
  const records = evidence.records;
  const one = (phase, match) => records.find(r => r.phase === phase && match(r));
  const combined = one('combined_failure', r => r.command.endsWith(' validate'));
  const first = one('first_deploy', r => r.command.endsWith(' deploy'));
  const second = one('second_deploy', r => r.command.endsWith(' deploy'));
  const repaired = one('repaired_validation', r => r.command.endsWith(' validate'));
  const remoteTests = one('remote_proof', r => /unittest/.test(r.command));
  const healthFix = one('agent_repair', r => r.command === 'git diff -- app/health.py');
  if (combined?.returncode !== 1 || first?.returncode !== 0 || second?.returncode !== 0 ||
      repaired?.returncode !== 0 || remoteTests?.returncode !== 0 ||
      !remoteTests.stderr.includes('Ran 4 tests') || !remoteTests.stderr.includes('OK') ||
      !healthFix?.stdout.includes('+TIMEOUT_BUDGET = DEFAULT_TIMEOUT') ||
      evidence.proof?.first_deploy_main === evidence.proof?.final_main)
    throw new Error('The recorded run does not prove the repair loop.');
  const names = ['faster-timeout', 'health-check', 'add-retries', 'request-logging'];
  const labels = ['Faster timeout', 'Health check', 'Retries', 'Request logs'];
  return names.map((name, index) => {
    const branch = `agent/${name}`, id = index + 1, needsRepair = id < 3;
    const individual = one('individual_checks', r => r.branch === branch);
    const validationLine = `#${id} ${needsRepair ? 'blocked' : 'validated'}: ${branch}`;
    const revision = evidence.proof.revisions.find(r => r.item === id);
    const deployedId = needsRepair ? revision?.replacement_job_id : id;
    const outcomeLine = `#${deployedId} deployed (push=succeeded, verify=succeeded): ${branch}`;
    if (individual?.returncode !== 0 || !combined.stdout.includes(validationLine) ||
        !(needsRepair ? second : first).stdout.includes(outcomeLine))
      throw new Error(`Missing recorded proof for ${branch}.`);
    if (needsRepair) {
      const retry = one('resubmit', r => r.command.endsWith(` retry ${id} --json`));
      const job = retry?.returncode === 0 ? JSON.parse(retry.stdout).job : null;
      const stillBlocked = one('first_deploy', r => r.command.endsWith(` inspect ${id} --json`));
      if (!job || job.id !== deployedId || job.head_sha !== revision.after ||
          revision.before === revision.after || job.status !== 'queued' ||
          JSON.parse(stillBlocked?.stdout || '{}').job?.status !== 'blocked')
        throw new Error(`Missing repair and replacement proof for ${branch}.`);
    }
    return {id, branch, label: labels[index], needsRepair, deployedId, validationLine, outcomeLine,
      ...(revision ? {before: revision.before, after: revision.after} : {})};
  });
}

export function readStory(evidence) {
  const story = readRepairStory(evidence);
  const records = evidence.records;
  const one = (phase, match = () => true) => records.find(r => r.phase === phase && match(r));
  const overlap = evidence.proof.overlap;
  const validation = one('repaired_validation', r => r.command.endsWith(' validate'));
  const final = one('cycle_remote_proof', r => /unittest/.test(r.command));
  const deployment = one('third_deploy', r => r.command.endsWith(' deploy'));
  if (!overlap?.validator_alive_after_commits || !validation ||
      !(validation.started_seconds < overlap.gate_active_seconds &&
        overlap.gate_active_seconds < overlap.next_work_committed_seconds &&
        overlap.next_work_committed_seconds < validation.finished_seconds) ||
      final?.returncode !== 0 || !final.stderr.includes('Ran 6 tests') || !final.stderr.includes('OK') ||
      deployment?.returncode !== 0 ||
      new Set([evidence.proof.first_deploy_main, evidence.proof.repaired_main, evidence.proof.final_main]).size !== 3)
    throw new Error('Missing overlapping work and final deployment proof.');
  const next = evidence.proof.next_batch;
  if (next?.length !== 2) throw new Error('Missing next batch.');
  for (const item of next) {
    const commit = one('next_batch_work', r => r.command === `git commit -m ${item.branch}`);
    const tested = one('next_batch_work', r => r.branch === item.branch && /unittest/.test(r.command));
    const sync = one('next_batch_sync', r => r.branch === item.branch && /unittest/.test(r.command));
    const submission = one('next_batch_submit', r => r.command.includes(`--branch ${item.branch} `));
    const job = submission?.returncode === 0 ? JSON.parse(submission.stdout).job : null;
    if (!commit || commit.returncode !== 0 ||
        !(commit.started_seconds > overlap.gate_active_seconds && commit.started_seconds <= commit.finished_seconds && commit.finished_seconds < validation.finished_seconds) ||
        tested?.returncode !== 0 || sync?.returncode !== 0 ||
        item.base !== evidence.proof.first_deploy_main || item.during_validation_head === item.submitted_head ||
        !job || job.head_sha !== item.submitted_head || job.id !== item.job_id ||
        !one('next_batch_validation', r => r.returncode === 0 && r.stdout.includes(`#${job.id} validated: ${item.branch}`)) ||
        !deployment.stdout.includes(`#${job.id} deployed (push=succeeded, verify=succeeded): ${item.branch}`))
      throw new Error(`Missing next-batch proof for ${item.branch}.`);
    story.push({id:item.item, branch:item.branch, deployedId:item.job_id, needsRepair:false, nextBatch:true,
      base:item.base, duringValidation:item.during_validation_head, submitted:item.submitted_head});
  }
  const drafts = evidence.proof.following_drafts;
  if (drafts?.length !== 4 || drafts.some(d => d.base !== evidence.proof.final_main || d.state !== 'draft; not submitted or validated') ||
      records.filter(r => r.phase === 'following_work_started' && r.command.startsWith('git diff -- ') && r.returncode === 0 && r.stdout.includes('\n+')).length !== 4)
    throw new Error('Missing actual following drafts on the latest applied base.');
  return story;
}

const C = {paper:'#f7f7f5', ink:'#16191f', muted:'#65707c', line:'#d5d9de', blue:'#005de8', pale:'#edf3ff', amber:'#a84c24', amberBg:'#fff5ed', green:'#237457'};
const clamp = x => Math.max(0, Math.min(1, x));
const ease = x => { x=clamp(x); return x*x*x*(x*(x*6-15)+10); };
const progress = (t,a,b) => ease((t-a)/(b-a));
const mix = (a,b,p) => a+(b-a)*p;
const bezier = (a,b,c,d,p) => (1-p)**3*a+3*(1-p)**2*p*b+3*(1-p)*p*p*c+p**3*d;
const curve = (a,b,c,d,p) => [bezier(a[0],b[0],c[0],d[0],p),bezier(a[1],b[1],c[1],d[1],p)];
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const text = (x,y,value,size=32,color=C.ink,weight=500,extra='') => `<text x="${x}" y="${y}" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" ${extra}>${escape(value)}</text>`;
const centered = (x,y,value,size=32,color=C.ink,weight=500) => text(x,y,value,size,color,weight,'text-anchor="middle"');
const check = (x,y,color=C.blue,s=1) => `<path d="M-8 0 L-2 6 L10 -8" transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
const agent = [[165,588],[265,588],[165,652],[265,652]];
const queue = [[447,370],[553,370],[447,448],[553,448]];
function card(pos, {color=C.blue, fill='#fff', state='work', opacity=1, scale=1}={}) {
  const [x,y]=pos;
  return `<g opacity="${opacity}" transform="translate(${x} ${y}) scale(${scale})"><rect x="-43" y="-28" width="86" height="56" rx="11" fill="${fill}" stroke="${color}" stroke-width="2.2"/>`+
    (state==='conflict' ? centered(0,10,'!',29,color,600) : state==='pass' ? check(0,1,color,1.05) :
      `<path d="M-22-8H18M-22 1H7M-22 10H14" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" opacity=".65"/>`)+'</g>';
}
function applied(t,a,b,from,index) {
  const p=progress(t,a,b), offset=index-.5;
  const pos=curve([from[0]-offset*106,from[1]],[600,510],[520,675],[775,635],p);
  pos[0]+=offset*mix(106,93,p);
  return card(pos,{color:p>.75?C.green:C.blue,state:'pass',opacity:1-progress(t,b,b+.8)});
}

export function frameSvg(t,story,{poster=false}={}) {
  if(story.length!==6) throw new Error('The scene requires the recorded following batch.');
  // The seam joins equal work-in-progress poses. It repeats this recorded window;
  // it does not count the unfinished drafts as additional completed changes.
  t=poster?11:((Math.max(0,t)%DURATION)+DURATION)%DURATION;
  const caption=t<2.5||t>=21.5?'Agents work in parallel.':t<8?'One pair returns. Other work moves ahead.':t<15.4?'Check the fix. Build the next changes.':'New work follows the latest changes.';
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="800" viewBox="0 0 960 800"><defs><marker id="arrow-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1L8 5L1 9" fill="none" stroke="${C.blue}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker><marker id="arrow-amber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1L8 5L1 9" fill="none" stroke="${C.amber}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker></defs><rect width="960" height="800" fill="${C.paper}"/>`;
  svg+=text(48,52,'mergetrain',29,C.blue,600);
  svg+=text(48,123,'Agents keep building.',60,C.ink,600,'letter-spacing="-1.5"');
  svg+=text(48,190,'Work keeps moving.',60,C.ink,600,'letter-spacing="-1.5"');
  svg+=text(48,250,caption,32,C.muted,400);
  // A permanent circuit connects work, checking and the latest project state.
  svg+=`<path d="M295 527C310 472 341 450 371 435" fill="none" stroke="${C.blue}" stroke-width="3" marker-end="url(#arrow-blue)" opacity=".6"/>`;
  svg+=`<path d="M640 420C690 480 590 580 650 618" fill="none" stroke="${C.blue}" stroke-width="3" marker-end="url(#arrow-blue)" opacity=".6"/>`;
  svg+=`<path d="M691 704C590 763 403 763 302 704" fill="none" stroke="${C.blue}" stroke-width="3" marker-end="url(#arrow-blue)" opacity=".55"/>`;
  svg+=centered(497,784,'Build on the latest changes',25,C.muted,400);
  svg+=`<path d="M374 318C247 308 115 405 115 527" fill="none" stroke="${C.amber}" stroke-width="2.5" marker-end="url(#arrow-amber)" opacity="${t>=3.7&&t<8.2?.85:.2}"/>`;
  svg+=text(119,389,'Fix',24,C.amber,500);
  for(let i=0;i<3;i++) {
    const p=((t/8+i/3)%1);
    const pos=curve([691,704],[590,763],[403,763],[302,704],p);
    svg+=`<circle cx="${pos[0]}" cy="${pos[1]}" r="4" fill="${C.blue}" opacity=".45"/>`;
  }
  svg+=centered(215,506,'AI agents',33,C.ink,600)+centered(500,294,'Check together',33,C.ink,600)+centered(779,506,'Your project',33,C.ink,600);
  svg+=`<rect x="70" y="527" width="290" height="177" rx="22" fill="${C.pale}" stroke="${C.blue}" stroke-width="2"/>`;
  for(let i=0;i<3;i++) svg+=`<circle cx="${111+i*19}" cy="548" r="4" fill="${C.blue}" opacity="${.35+.65*(.5+.5*Math.sin((t/2-i/3)*Math.PI*2))}"/>`;
  svg+=text(173,554,'Working',19,C.blue,500);
  svg+=`<rect x="360" y="326" width="280" height="179" rx="22" fill="#f0f1f2" stroke="${C.line}" stroke-width="2"/>`;
  svg+=`<rect x="650" y="527" width="260" height="177" rx="22" fill="#edf6f1" stroke="${C.green}" stroke-width="2"/>`;
  svg+=centered(780,556,'Latest version',23,C.green,500);
  for(let i=0;i<4;i++) svg+=`<path d="M682 ${582+i*25}H${i%2?836:876}" stroke="${C.green}" stroke-width="${i===0?5:3}" opacity="${i===0?.42:.18}" stroke-linecap="round"/>`;
  const approving=(t>=5.4&&t<6.7)||(t>=12.2&&t<14.2)||(t>=18.5&&t<20.5);
  const checking=(t>=2.5&&t<3.7)||(t>=10&&t<12.2)||(t>=17.2&&t<18.5);
  const status=approving?'Approve · check again':checking?'Checking':t>=3.7&&t<5.4?'Fix the pair':'Ready for work';
  svg+=centered(500,317,status,21,approving?C.blue:C.muted,500);
  // Original four changes, including the exact pair that is repaired and retried.
  for(let i=0;i<4;i++) {
    let pos=agent[i];
    if(t<2.5) {
      const p=progress(t,1,2.3);
      pos=curve([215,620],[415,620],[400,490],[500,409],p);
      pos[0]+=(i%2-.5)*mix(100,106,p);
      pos[1]+=(Math.floor(i/2)-.5)*mix(64,78,p);
    }
    else pos=queue[i];
    if(i<2) {
      if(t>=3.7&&t<5.6) {
        const p=progress(t,4.05,5.6);
        pos=curve([500,370],[270,310],[85,510],[215,588],p);
        pos[0]+=(i-.5)*mix(106,100,p);
      }
      if(t>=5.6&&t<8.2) pos=agent[i];
      if(t>=8.2&&t<10) pos=curve(agent[i],[agent[i][0]+200,588],[queue[i][0]-100,410],queue[i],progress(t,8.2,10));
      if(t>=14.2) { if(t<16.2) svg+=applied(t,14.2,15.4,queue[i],i); continue; }
      svg+=card(pos,{state:t>=3.7&&t<7.7?'conflict':t>=12.2?'pass':'work',color:t>=3.7&&t<7.7?C.amber:C.blue,fill:t>=3.7&&t<7.7?C.amberBg:'#fff'});
    } else {
      if(t>=6.7) { if(t<8.8) svg+=applied(t,6.7,8,queue[i],i-2); continue; }
      svg+=card(pos,{state:t>=3.7?'pass':'work'});
    }
  }
  // These next changes are actually committed while the repair gate is active.
  for(let i=0;i<2;i++) {
    if(t<10.2||t>=22.1) continue;
    if(t>=20.5) {svg+=applied(t,20.5,21.3,queue[i],i);continue;}
    const growth=progress(t,10.2+i*.25,11.2+i*.25);
    const pos=curve(agent[i+2],[agent[i+2][0]+200,588],[queue[i][0]-100,410],queue[i],progress(t,16.2,17.2));
    svg+=card(pos,{opacity:growth,scale:.85+.15*growth,state:t>=18.5?'pass':'work'});
  }
  // Four real, unsubmitted drafts close the loop without clearing the project.
  for(let i=0;i<4;i++) if(t>=21.5) {
    const growth=progress(t,21.5+i*.15,22.6+i*.15);
    svg+=card(agent[i],{opacity:growth,scale:.85+.15*growth});
  }
  if(checking||approving) {
    const p=(t%1.2)/1.2;
    svg+=`<path d="M${378+p*244} 337V495" stroke="${C.blue}" stroke-width="2.5" opacity=".18"/>`;
  }
  return svg+'</svg>';
}
