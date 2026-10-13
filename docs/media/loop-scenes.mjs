// A condensed illustration of archived CLI results, not a product UI recording.
export const WIDTH = 960;
export const HEIGHT = 800;
export const DURATION = 12;
export function readStory(evidence) {
  const records = evidence.records;
  const validation = records.find(r => r.command.endsWith(' validate'));
  const dismissal = records.find(r => / dismiss /.test(r.command));
  const deployment = records.find(r => / deploy --expected-plan /.test(r.command));
  const names = ['faster-timeout', 'health-check', 'add-retries', 'request-logging'];
  const labels = ['Faster timeout', 'Health check', 'Retries', 'Request logs'];
  if (validation?.returncode !== 1 || dismissal?.returncode !== 0 || deployment?.returncode !== 0)
    throw new Error('The recorded run does not prove the demo outcome.');
  return names.map((name, index) => {
    const branch = `agent/${name}`, id = index + 1, held = id < 3;
    const individual = records.find(r => r.branch === branch && /unittest/.test(r.command));
    const validationLine = `#${id} ${held ? 'blocked' : 'validated'}: ${branch}`;
    const outcomeLine = held ? `dismissed job ${id}: ${branch}` :
      `#${id} deployed (push=succeeded, verify=succeeded): ${branch}`;
    if (individual?.returncode !== 0 || !validation.stdout.includes(validationLine) ||
        !(held ? dismissal : deployment).stdout.includes(outcomeLine))
      throw new Error(`Missing recorded proof for ${branch}.`);
    return {id, branch, label: labels[index], held, validationLine, outcomeLine};
  });
}

const C = {paper:'#f7f7f5', ink:'#16191f', muted:'#626b76', line:'#cbd0d7', blue:'#005de8', pale:'#edf3ff', amber:'#a84c24', amberBg:'#fff5ed', green:'#237457'};
const clamp = x => Math.max(0,Math.min(1,x));
const ease = x => { x=clamp(x); return x*x*x*(x*(x*6-15)+10); };
const progress = (t,a,b) => ease((t-a)/(b-a));
const mix = (a,b,p) => a+(b-a)*p;
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const text = (x,y,value,size=36,color=C.ink,weight=500,extra='') => `<text x="${x}" y="${y}" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" ${extra}>${escape(value)}</text>`;
const centered = (x,y,value,size=36,color=C.ink,weight=500) => text(x,y,value,size,color,weight,'text-anchor="middle"');
const check = (x,y,color=C.blue,s=1) => `<path d="M-11 0 L-3 8 L13 -10" transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
const person = (x,y,color=C.ink) => `<g transform="translate(${x} ${y})" fill="none" stroke="${color}" stroke-width="3"><circle cy="-8" r="8"/><path d="M-15 18C-15-2 15-2 15 18" stroke-linecap="round"/></g>`;

function card(job,x,y,t,angle=0) {
  const conflict=job.held&&t>=3.55, applied=!job.held&&t>=9.65;
  const color=conflict?C.amber:applied?C.green:C.blue;
  const fill=conflict?C.amberBg:'#fff';
  return `<g transform="translate(${x} ${y}) rotate(${angle})"><rect x="-61" y="-42" width="122" height="84" rx="13" fill="${fill}" stroke="${color}" stroke-width="2.2"/>`+
    text(-31,12,String(job.id),40,C.ink,600)+
    (conflict?text(29,10,'!',30,C.amber,700,'text-anchor="middle"'):check(27,0,color,.85))+'</g>';
}

export function frameSvg(t,story) {
  t=Math.max(0,Math.min(DURATION,t));
  const issue=progress(t,3.35,3.6);
  const hold=progress(t,5.2,6), applied=progress(t,8.65,9.65);
  const final=t>=9.65, approval=t>=6.4, afterChoice=t>=4.9;
  const caption=t<1.6?'Four changes. All pass.':t<3.55?'Checking together.':t<4.9?'Two changes conflict.':t<6.4?'You hold the conflicting pair.':t<7.35?'You approve the other two.':t<8.65?'Checking once more.':t<9.65?'Applying approved work.':'Two changes applied.';
  const alpha=Math.min(progress(t,0,.25),1-progress(t,11.75,12));
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="800" viewBox="0 0 960 800"><defs><clipPath id="check-area"><rect x="196" y="370" width="568" height="148" rx="24"/></clipPath></defs><rect width="960" height="800" fill="${C.paper}"/>`;
  svg+=text(48,52,'mergetrain',29,C.blue,600);
  svg+=text(48,123,'Parallel work.',65,C.ink,600,'letter-spacing="-1.8"');
  svg+=text(48,190,'Checked together.',65,C.ink,600,'letter-spacing="-1.8"');
  svg+=`<g opacity="${alpha}">`;
  svg+=text(48,251,caption,36,C.muted,400);
  // One fixed scene: individual work arrives at the shared check.
  [144,368,592,816].forEach((x,i)=>{
    const end=[282,414,546,678][i];
    svg+=`<path d="M${x} 333 C${x} 355 ${end} 347 ${end} 402" fill="none" stroke="${C.line}" stroke-width="2" opacity="${.8*(1-progress(t,2.55,2.9))}"/>`;
  });
  svg+=`<rect x="196" y="370" width="568" height="148" rx="24" fill="${t<3.5?C.pale:'#f0f1f2'}" stroke="${t<3.5?C.blue:C.line}" stroke-width="2"/>`;
  svg+=`<g opacity="${progress(t,2.5,2.7)}">`+centered(480,358,final?'Checked together':t>=7.35?'Check again':'Check together',31,C.muted)+'</g>';
  if(final){
    svg+=`<g opacity="${progress(t,9.65,9.95)}">`+check(333,448,C.green,1.1)+text(365,461,'Checks passed',39,C.ink,500)+'</g>';
  }
  // The lower destinations stay in place, so the work's route stays legible.
  svg+=`<path d="M348 518 C348 558 248 548 248 594" fill="none" stroke="${issue?C.amber:C.line}" stroke-width="2.5" opacity="${issue?.6:.35}"/>`;
  svg+=`<path d="M612 518 C612 558 712 548 712 594" fill="none" stroke="${approval?C.blue:C.line}" stroke-width="2.5" opacity="${approval?.8:.35}"/>`;
  svg+=`<rect x="88" y="594" width="320" height="126" rx="22" fill="${hold>0?C.amberBg:'none'}" stroke="${hold>0?C.amber:C.line}" stroke-width="2" opacity="${hold>0?1:.55}"/>`;
  svg+=`<rect x="552" y="594" width="320" height="126" rx="22" fill="${final?'#edf6f1':'none'}" stroke="${final?C.green:C.line}" stroke-width="2" opacity="${approval?1:.55}"/>`;
  svg+=centered(248,765,hold>=1?'2 held':'Hold',37,hold>=1?C.amber:C.muted,500);
  svg+=centered(712,765,final?'2 applied':'Your project',37,final?C.green:C.muted,500);
  // Before either branch leaves the check, show the operator's choice.
  if(afterChoice&&t<7.35){
    svg+=`<circle cx="480" cy="556" r="28" fill="${C.paper}"/>`;
    svg+=person(480,553,approval?C.blue:C.ink);
    if(approval) svg+=check(520,552,C.blue,.8);
  }
  for(let i=0;i<story.length;i++){
    const job=story[i], initial=[144,368,592,816][i], center=[282,414,546,678][i];
    const g=progress(t,1.6+i*.04,2.4+i*.04);
    let x=mix(initial,center,g),y=mix(303,449,g),angle=mix([-4,3,-3,4][i],0,g);
    if(job.held){ x=mix(x,[180,316][i],hold); y=mix(y,657,hold); }
    else { x=mix(x,[644,780][i-2],applied); y=mix(y,657,applied); }
    svg+=card(job,x,y,t,angle);
  }
  if(t>=2.65&&t<3.4){
    const x=mix(218,742,progress(t,2.65,3.4));
    svg+=`<g clip-path="url(#check-area)"><rect x="${x-10}" y="376" width="20" height="136" fill="${C.blue}" opacity=".08"/><path d="M${x} 384V504" stroke="${C.blue}" stroke-width="3" opacity=".8"/></g>`;
  }
  if(t>=7.35&&t<8.5){
    const x=mix(486,738,progress(t,7.35,8.5));
    svg+=`<path d="M${x} 403V493" stroke="${C.blue}" stroke-width="3" opacity=".8"/>`;
  }
  if(t>=3.55&&t<4.9){
    svg+=`<path d="M240 492V501H456V492" fill="none" stroke="${C.amber}" stroke-width="2.5"/>`;
    svg+=`<rect x="270" y="532" width="156" height="42" rx="12" fill="${C.paper}"/>`;
    svg+=centered(348,563,'Conflict',34,C.amber,600);
  }
  return svg+'</g></svg>';
}
