// A condensed illustration of recorded CLI results, not a product UI recording.
export const WIDTH = 960;
export const HEIGHT = 800;
export const DURATION = 14;
export const PROCESSING_MODE = 'batch';
// Playback seconds -> the existing recorded-story timeline. Shorten holds more
// than handoffs, and retain both overlaps, three approvals and the replay seam.
export const TIMELINE = [[0,0],[1.8,2.2],[2.8,2.8],[3.5,3.8],[5.7,7.1],[7.2,10.4],
  [8.4,12.7],[10.5,15.3],[12.4,18.7],[13.85,23.8],[14,24]];
export const PRIMARY_MESSAGES = [
  {id:'passing-first',lines:['Passing work','lands first.']},
  {id:'keep-building',lines:['Keep building','during checks.']},
];
export function storyTime(seconds) {
  const t=((Math.max(0,seconds)%DURATION)+DURATION)%DURATION;
  const end=TIMELINE.findIndex(([playback])=>playback>t);
  const [a,x]=TIMELINE[end-1], [b,y]=TIMELINE[end];
  return x+(y-x)*(t-a)/(b-a);
}
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
  const draftOverlap=evidence.proof.draft_overlap;
  const nextValidation=one('next_batch_validation', r=>r.command.endsWith(' validate'));
  if(!draftOverlap?.validator_alive_after_edits || !nextValidation ||
      !(nextValidation.started_seconds < draftOverlap.gate_active_seconds &&
        draftOverlap.gate_active_seconds < draftOverlap.drafts_started_seconds &&
        draftOverlap.drafts_started_seconds < nextValidation.finished_seconds) ||
      drafts.map(d=>d.item).join(',')!=='7,8,9,10')
    throw new Error('Missing following-draft overlap proof.');
  for(const draft of drafts.slice(0,2)) {
    const edit=one('following_work_during_validation', r=>r.branch===draft.branch && r.command.startsWith('git diff -- '));
    if(!draft.started_during_validation || draft.started_base!==evidence.proof.repaired_main ||
        !edit || edit.returncode!==0 || !edit.stdout.includes('\n+') ||
        !(edit.started_seconds>draftOverlap.gate_active_seconds && edit.started_seconds<=edit.finished_seconds && edit.finished_seconds<nextValidation.finished_seconds))
      throw new Error('Missing following-draft overlap proof.');
  }
  return story.map(item=>({...item,visualId:'ABCDEFGHIJ'[item.id-1]}));
}

const C = {paper:'#f7f7f5', ink:'#16191f', muted:'#5a6572', line:'#d5d9de', blue:'#005de8', pale:'#edf3ff', amber:'#a84c24', amberBg:'#fff5ed', green:'#237457'};
const clamp = x => Math.max(0, Math.min(1, x));
const ease = x => { x=clamp(x); return x*x*x*(x*(x*6-15)+10); };
const progress = (t,a,b) => ease((t-a)/(b-a));
const mix = (a,b,p) => a+(b-a)*p;
const bezier = (a,b,c,d,p) => (1-p)**3*a+3*(1-p)**2*p*b+3*(1-p)*p*p*c+p**3*d;
const curve = (a,b,c,d,p) => [bezier(a[0],b[0],c[0],d[0],p),bezier(a[1],b[1],c[1],d[1],p)];
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const text = (x,y,value,size=28,color=C.ink,weight=500,extra='') => `<text x="${x}" y="${y}" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" ${extra}>${escape(value)}</text>`;
const centered = (x,y,value,size=28,color=C.ink,weight=500) => text(x,y,value,size,color,weight,'text-anchor="middle"');
const letters = 'ABCDEFGHIJ';
const agents = [[369,310],[369,420],[369,530],[369,640]];
const queue = [[649,357],[817,357],[649,444],[817,444]];
const project = [733,666];
const check = (x,y,color=C.blue) => `<path d="M-8 0L-2 6L10-8" transform="translate(${x} ${y})" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;

// Display letters identify recorded work items, not queue replacement-job IDs.
export function sceneAt(seconds) {
  return stateAt(storyTime(seconds));
}
function stateAt(t) {
  const rows=[{state:'Needs fix',work:'A'},{state:'Needs fix',work:'B'},{state:'Submitted',work:'C'},{state:'Submitted',work:'D'}];
  if(t>=2.2) for(let i=0;i<2;i++) rows[i]={state:t<2.9?'Fixing':t<3.6?'Submitting':'Submitted',work:letters[i]};
  if(t>=2.2) for(let i=2;i<4;i++) rows[i]={state:'Ready',work:null};
  if(t>=3.8) for(let i=2;i<4;i++) rows[i]={state:t<10.4?'Building':t<11.2?'Updating':t<12.4?'Submitting':'Submitted',work:letters[i+2]};
  if(t>=12.7) for(let i=0;i<2;i++) rows[i]={state:'New draft',work:letters[i+6]};
  if(t>=18.7) for(let i=2;i<4;i++) rows[i]={state:'New draft',work:letters[i+6]};
  const checking=t>=3.6&&t<7.1?['A','B']:t>=12.4&&t<15.3?['E','F']:[];
  const approval=(t>=.9&&t<1.4)||(t>=7.1&&t<8.6)||(t>=15.3&&t<17.1);
  const added=t>=18.4?['C','D','A','B','E','F']:t>=10?['C','D','A','B']:t>=2.2?['C','D']:[];
  for(const row of rows) {
    row.activity=['Building','New draft'].includes(row.state)?'Next task':
      row.state==='Submitting'?'Sending':row.state;
    if(row.state==='Submitted') {
      if(['C','D'].includes(row.work)) row.activity=t<1.4?'Passed':'Applying';
      else {
        const [apply,land]=['A','B'].includes(row.work)?[8.6,10]:[17.1,18.4];
        row.activity=t<apply?'In checks':t<land?'Applying':'Ready';
      }
    }
  }
  return {t,rows,checking,approval,added,message:PRIMARY_MESSAGES[t<3.8?0:1]};
}

function card(pos,id,{state='work',opacity=1,writing=1,draft=false}={}) {
  const color=state==='fix'?C.amber:state==='pass'?C.green:C.blue;
  let svg=`<g data-work="${id}" opacity="${opacity}" transform="translate(${pos[0]} ${pos[1]})"><rect x="-55" y="-31" width="110" height="62" rx="12" fill="${state==='fix'?C.amberBg:'#fff'}" stroke="${color}" stroke-width="2.5" ${draft?'stroke-dasharray="7 4"':''}/>`;
  svg+=centered(-29,11,id,32,color,600);
  svg+=`<path d="M-7-19V19" stroke="${color}" opacity=".22"/>`;
  if(state==='pass') svg+=check(24,2,color);
  else if(state==='fix') svg+=centered(25,11,'!',31,color,600);
  else for(let i=0;i<3;i++) svg+=`<path d="M6 ${-13+i*13}H${6+(i%2?22:36)*clamp(writing*3-i)}" stroke="${color}" stroke-width="3" stroke-linecap="round" opacity=".65"/>`;
  return svg+'</g>';
}

function travel(from,to,p,bend=0) {
  const direction=Math.sign(to[0]-from[0])||1;
  return curve(from,[from[0]+direction*100,from[1]+bend],[to[0]-direction*100,to[1]+bend],to,p);
}

function dynamic(t, {labels=true, cards=true}={}) {
  const s=stateAt(t);
  let svg='';
  if(labels) {
  for(let i=0;i<4;i++) {
    const row=s.rows[i], y=agents[i][1];
    const active=['Fixing','Building','New draft'].includes(row.state);
    const color=row.state==='Needs fix'||row.state==='Fixing'?C.amber:row.activity==='Passed'?C.green:active?C.blue:C.muted;
    svg+=text(117,y+20,row.activity,36,color,500);
    if(active) {
      const p=(t/1.8+i*.23)%1;
      svg+=`<path d="M119 ${y+32}H${137+117*p}" stroke="${color}" stroke-width="3" stroke-linecap="round" opacity=".45"/>`;
    }
  }
  const status=s.checking.length?'Checking together':s.approval?'Approve · recheck':t<.9?'Return for fix':t>=18.4?'Work continues':'Apply passing work';
  svg+=centered(733,305,status,30,s.approval?C.blue:C.ink,500);
  if(s.checking.length||s.approval) {
    const p=(t%1.4)/1.4;
    svg+=`<path d="M${576+p*313} 327V482" stroke="${C.blue}" stroke-width="3" opacity=".17"/>`;
  }
  svg+=text(578,628,`${s.added.length} changes added`,30,C.green,500);
  [['C','D'],['A','B'],['E','F']].filter(pair=>pair.every(id=>s.added.includes(id))).forEach((pair,i)=>{
    const x=626+i*105;
    svg+=`<g data-applied-batch="${pair.join('')}"><rect x="${x-48}" y="649" width="96" height="42" rx="10" fill="#fff" stroke="${C.green}" stroke-width="2"/>`+centered(x,679,pair.join(' + '),27,C.green,600)+'</g>';
  });
  }
  if(!cards) return svg;
  // The recorded conflicting pair returns before the first approved deployment.
  for(let i=0;i<2;i++) {
    if(t<.9) svg+=card(travel(queue[i],agents[i],progress(t,0,.9),-90),letters[i],{state:'fix'});
    else if(t<2.2) svg+=card(agents[i],letters[i],{state:'fix'});
    else if(t<2.9) svg+=card(agents[i],letters[i],{writing:progress(t,2.2,2.9)});
    else if(t<3.6) svg+=card(travel(agents[i],queue[i],progress(t,2.9,3.6)),letters[i]);
    else if(t<8.6) svg+=card(queue[i],letters[i],{state:t>=7.1?'pass':'work'});
    else if(t<10) svg+=card(travel(queue[i],[project[0]+(i-.5)*126,project[1]],progress(t,8.6,10),35),letters[i],{state:'pass',opacity:1-progress(t,9.6,10)});
  }
  for(let i=2;i<4;i++) {
    if(t<1.4) svg+=card(queue[i],letters[i],{state:'pass'});
    else if(t<2.2) svg+=card(travel(queue[i],[project[0]+(i-2.5)*126,project[1]],progress(t,1.4,2.2),35),letters[i],{state:'pass',opacity:1-progress(t,1.95,2.2)});
  }
  // These two commits are captured while A+B validation is running.
  for(let i=0;i<2;i++) {
    const id=letters[i+4];
    if(t>=3.8&&t<11.2) svg+=card(agents[i+2],id,{opacity:progress(t,3.8,4.1),writing:progress(t,3.8,6.4)});
    else if(t>=11.2&&t<12.4) svg+=card(travel(agents[i+2],queue[i],progress(t,11.2,12.4)),id);
    else if(t>=12.4&&t<17.1) svg+=card(queue[i],id,{state:t>=15.3?'pass':'work'});
    else if(t>=17.1&&t<18.4) svg+=card(travel(queue[i],[project[0]+(i-.5)*126,project[1]],progress(t,17.1,18.4),35),id,{state:'pass',opacity:1-progress(t,18.1,18.4)});
  }
  // G/H are real dirty drafts started during the next validation; I/J follow.
  for(let i=0;i<4;i++) {
    const start=i<2?12.7:18.7;
    if(t>=start) svg+=card(agents[i],letters[i+6],{draft:true,opacity:progress(t,start,start+.35),writing:progress(t,start,start+3)});
  }
  return svg;
}

export function frameSvg(t,story,{poster=false}={}) {
  if(story.length!==6) throw new Error('The scene requires the recorded following batch.');
  t=poster?5:storyTime(t);
  const labelTime=t>=23.9?0:t;
  const message=poster?PRIMARY_MESSAGES[0]:stateAt(labelTime).message;
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="800" viewBox="0 0 960 800"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1L8 5L1 9" fill="none" stroke="${C.blue}" stroke-width="1.5" stroke-linecap="round"/></marker><marker id="fix-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1L8 5L1 9" fill="none" stroke="${C.amber}" stroke-width="1.5" stroke-linecap="round"/></marker></defs><rect width="960" height="800" fill="${C.paper}"/>`;
  svg+=text(40,46,'mergetrain',29,C.blue,600);
  svg+=`<g data-processing="${PROCESSING_MODE}">`+text(920,46,'Batch · default',26,C.muted,500,'text-anchor="end"')+'</g>';
  svg+=`<g data-message="${message.id}">`;
  if(poster) svg+=text(40,111,'Passing work lands first.',52,C.green,600,'letter-spacing="-1.5"')+
    text(40,180,'Keep building during checks.',52,C.blue,600,'letter-spacing="-1.5"');
  else svg+=text(40,111,message.lines[0],64,C.ink,600,'letter-spacing="-1.5"')+
    text(40,180,message.lines[1],64,message.id==='passing-first'?C.green:C.blue,600,'letter-spacing="-1.5"');
  svg+='</g>';
  svg+=text(52,256,'AI agents',31,C.ink,600)+text(577,256,'mergetrain',31,C.blue,600);
  svg+=`<path d="M453 470C505 470 500 410 554 410" fill="none" stroke="${C.blue}" stroke-width="3" marker-end="url(#arrow)" opacity=".55"/>`;
  svg+=`<path d="M877 532V577" fill="none" stroke="${C.blue}" stroke-width="3" marker-end="url(#arrow)" opacity=".55"/>`;
  svg+=`<path d="M554 365C500 336 513 309 451 309" fill="none" stroke="${C.amber}" stroke-width="3" marker-end="url(#fix-arrow)" opacity=".55"/>`;
  svg+=text(483,351,'Fix',25,C.amber,500);
  svg+=`<path d="M690 727C600 771 169 781 139 698" fill="none" stroke="${C.blue}" stroke-width="3" marker-end="url(#arrow)" opacity=".55"/>`;
  const pos=curve([690,727],[600,771],[169,781],[139,698],(t/8)%1);
  svg+=`<circle cx="${pos[0]}" cy="${pos[1]}" r="4" fill="${C.blue}" opacity=".5"/>`;
  // Agent identities do not leave with their submitted work cards.
  for(let i=0;i<4;i++) {
    const y=agents[i][1];
    svg+=`<g data-agent="${i+1}"><rect x="40" y="${y-41}" width="413" height="89" rx="17" fill="${C.pale}" stroke="#b5c9ec" stroke-width="1.5"/><circle cx="78" cy="${y}" r="25" fill="${C.blue}"/>`+centered(78,y+9,String(i+1),27,'#fff',600)+text(117,y-13,`Agent ${i+1}`,26,C.ink,600)+'</g>';
  }
  svg+=`<rect x="555" y="271" width="355" height="263" rx="20" fill="#f0f1f2" stroke="${C.line}" stroke-width="2"/>`;
  svg+=text(577,572,'Your project',31,C.ink,600);
  svg+=`<rect x="555" y="591" width="355" height="136" rx="20" fill="#edf6f1" stroke="${C.green}" stroke-width="2"/>`;
  // Only work markers transition at the replay boundary. Agents and paths stay.
  const replay=t>=23.8;
  svg+=dynamic(labelTime,{cards:false});
  // Fade out before fading in: task labels and cards never double-expose.
  const cardTime=t>=23.9?0:t;
  const opacity=!replay?1:t<23.9?1-progress(t,23.8,23.9):progress(t,23.9,24);
  svg+=`<g opacity="${opacity}">${dynamic(cardTime,{labels:false})}</g>`;
  return svg+'</svg>';
}
