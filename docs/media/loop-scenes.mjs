// A condensed illustration of recorded CLI results, not a product UI recording.
export const WIDTH = 960;
export const HEIGHT = 800;
export const DURATION = 18;
export function readStory(evidence) {
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

const C = {paper:'#f7f7f5', ink:'#16191f', muted:'#626b76', line:'#cbd0d7', blue:'#005de8', pale:'#edf3ff', amber:'#a84c24', amberBg:'#fff5ed', green:'#237457'};
const clamp = x => Math.max(0,Math.min(1,x));
const ease = x => { x=clamp(x); return x*x*x*(x*(x*6-15)+10); };
const progress = (t,a,b) => ease((t-a)/(b-a));
const mix = (a,b,p) => a+(b-a)*p;
const bezier = (a,b,c,d,p) => (1-p)**3*a+3*(1-p)**2*p*b+3*(1-p)*p*p*c+p**3*d;
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const text = (x,y,value,size=36,color=C.ink,weight=500,extra='') => `<text x="${x}" y="${y}" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" ${extra}>${escape(value)}</text>`;
const centered = (x,y,value,size=36,color=C.ink,weight=500) => text(x,y,value,size,color,weight,'text-anchor="middle"');
const check = (x,y,color=C.blue,s=1) => `<path d="M-11 0 L-3 8 L13 -10" transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
const person = (x,y,color=C.ink) => `<g transform="translate(${x} ${y})" fill="none" stroke="${color}" stroke-width="3"><circle cy="-8" r="8"/><path d="M-15 18C-15-2 15-2 15 18" stroke-linecap="round"/></g>`;
function card(job,x,y,t,angle=0,scale=1) {
  const conflict=job.needsRepair&&t>=3.5&&t<10.25;
  const applied=job.needsRepair?t>=15.8:t>=8.3;
  const color=conflict?C.amber:applied?C.green:C.blue;
  return `<g transform="translate(${x} ${y}) rotate(${angle}) scale(${scale})"><rect x="-61" y="-42" width="122" height="84" rx="13" fill="${conflict?C.amberBg:'#fff'}" stroke="${color}" stroke-width="2.2"/>`+
    text(-31,12,String(job.id),40,C.ink,600)+
    (conflict?text(29,10,'!',30,C.amber,700,'text-anchor="middle"'):check(27,0,color,.85))+'</g>';
}

export function frameSvg(t,story,{poster=false}={}) {
  t=Math.max(0,Math.min(DURATION,t));
  // A short dissolve repeats the recorded run without a blank frame or a cut.
  // It is a replay boundary, not evidence of an additional batch.
  if (!poster && t>=17.1) {
    const p=progress(t,17.1,DURATION);
    const body=value=>value.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="800" viewBox="0 0 960 800"><rect width="960" height="800" fill="${C.paper}"/><g>${body(frameSvg(16.8,story))}</g><g opacity="${p}">${body(frameSvg(0,story))}</g><rect x="0" y="215" width="960" height="49" fill="${C.paper}"/>${text(48,251,'Four changes. All pass.',36,C.muted,400)}</svg>`;
  }
  const hold=progress(t,4.75,5.55), first=progress(t,7.5,8.3);
  const back=progress(t,10.4,11.65), last=progress(t,14.8,15.8);
  const final=t>=15.8, returning=t>=8.3, approved=t>=5.6;
  const caption=poster?'Fix. Resubmit. Keep building.':t<1.6?'Four changes. All pass.':t<3.5?'Checking together.':t<4.75?'Two changes conflict.':t<5.6?'Back to the AI agents.':t<6.5?'You approve the other two.':t<7.5?'Checking once more.':t<8.3?'Two changes move ahead.':t<10.4?'AI revises the pair.':t<11.65?'Revised. Submitted again.':t<12.8?'Checked with applied work.':t<13.6?'You approve the revised work.':t<14.8?'Checking once more.':t<15.8?'Applying revised work.':'All four changes applied.';
  const alpha=1;
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="800" viewBox="0 0 960 800"><defs><marker id="return-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L8 5L1 9" fill="none" stroke="${C.blue}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker></defs><rect width="960" height="800" fill="${C.paper}"/>`;
  svg+=text(48,52,'mergetrain',29,C.blue,600);
  svg+=text(48,123,'Keep building.',65,C.ink,600,'letter-spacing="-1.8"');
  svg+=text(48,190,'Check work together.',65,C.ink,600,'letter-spacing="-1.8"');
  svg+=`<g opacity="${alpha}">`+text(48,251,caption,36,C.muted,400);
  [144,368,592,816].forEach((x,i)=>{
    const end=[282,414,546,678][i];
    svg+=`<path d="M${x} 345 C${x} 360 ${end} 347 ${end} 402" fill="none" stroke="${C.line}" stroke-width="2" opacity="${.8*(1-progress(t,2.55,2.9))}"/>`;
  });
  svg+=`<rect x="196" y="370" width="568" height="148" rx="24" fill="${t<3.5?C.pale:'#f0f1f2'}" stroke="${t<3.5?C.blue:C.line}" stroke-width="2"/>`;
  const checking=(t>=6.5&&t<8.3)||(t>=13.6&&t<15.8);
  svg+=`<g opacity="${progress(t,2.5,2.7)}">`+centered(480,358,checking?'Check again':'Check together',31,C.muted)+'</g>';
  if(final||(t>=8.3&&t<11)) svg+=check(333,448,C.green,1.1)+text(365,461,'Checks passed',39,C.ink,500);
  svg+=`<path d="M348 518 C348 558 248 548 248 594" fill="none" stroke="${t>=3.5?C.amber:C.line}" stroke-width="2.5" opacity="${returning?.18:.55}"/>`;
  svg+=`<path d="M612 518L612 550" fill="none" stroke="${approved?C.blue:C.line}" stroke-width="2.5" opacity=".7"/>`;
  svg+=`<rect x="88" y="594" width="320" height="126" rx="22" fill="${hold>0&&t<10.25?C.amberBg:'none'}" stroke="${returning?C.blue:hold>0?C.amber:C.line}" stroke-width="2" opacity="${hold>0?1:.55}"/>`;
  svg+=`<rect x="552" y="550" width="320" height="172" rx="22" fill="${first>=1?'#edf6f1':'none'}" stroke="${first>=1?C.green:C.line}" stroke-width="2" opacity="${approved?1:.55}"/>`;
  svg+=centered(248,765,'AI agents',37,returning?C.blue:C.muted,500);
  svg+=centered(712,765,'Your project',37,first>=1?C.green:C.muted,500);
  if(returning) {
    svg+=`<path d="M160 594 C60 553 64 442 196 442" fill="none" stroke="${C.blue}" stroke-width="3.5" marker-end="url(#return-arrow)" opacity="${t<12.8?1:.35}"/>`;
    if(t>=11.65) svg+=centered(248,665,'Keep working',30,C.muted,400);
  }
  if((t>=5.6&&t<6.5)||(t>=12.8&&t<13.6)) svg+=`<circle cx="480" cy="556" r="29" fill="${C.paper}"/>`+person(477,553,C.blue)+check(518,552,C.blue,.8);
  for(let i=0;i<story.length;i++) {
    const job=story[i], initial=[144,368,592,816][i], center=[282,414,546,678][i];
    const g=progress(t,1.6+i*.04,2.4+i*.04);
    let x=mix(initial,center,g), y=mix(315,449,g), angle=mix([-4,3,-3,4][i],0,g);
    if(job.needsRepair) {
      x=mix(x,[180,316][i],hold); y=mix(y,657,hold);
      if(back>0) { x=bezier(248,130,130,348,back)+[-66,66][i]; y=bezier(657,625,465,449,back); }
      x=mix(x,[644,780][i],last); y=mix(y,595,last);
    } else { x=mix(x,[644,780][i-2],first); y=mix(y,mix(636,679,last),first); }
    svg+=card(job,x,y,t,angle,1-.1*(job.needsRepair?last:first));
  }
  const scans=[[2.65,3.35,218,742],[6.6,7.35,486,738],[11.75,12.65,218,480],[13.65,14.65,218,480]];
  for(const [a,b,left,right] of scans) if(t>=a&&t<b) {
    const x=mix(left,right,progress(t,a,b));
    svg+=`<path d="M${x} 403V493" stroke="${C.blue}" stroke-width="3" opacity=".65"/>`;
  }
  if(t>=3.5&&t<4.75) {
    svg+=`<path d="M240 492V501H456V492" fill="none" stroke="${C.amber}" stroke-width="2.5"/>`;
    svg+=`<rect x="270" y="532" width="156" height="42" rx="12" fill="${C.paper}"/>`+centered(348,563,'Conflict',34,C.amber,600);
  }
  return svg+'</g></svg>';
}
