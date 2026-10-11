export const DURATION = 50;

const C = Object.freeze({bg:'#f7f7f5',paper:'#ffffff',ink:'#16191f',muted:'#586171',line:'#dce0e5',blue:'#005de8',pass:'#06734b',fail:'#b32640',decision:'#905600',passBg:'#edf7f1',failBg:'#fff0f2',decisionBg:'#fff5e5'});
const WORK = [
  {name:'#1 · Timeout',light:'#e2d7f4',dark:'#b6a0d4'},
  {name:'#2 · Health',light:'#dce8d7',dark:'#a7c1a5'},
  {name:'#3 · Retries',light:'#ffe4a6',dark:'#e6bf67'},
  {name:'#4 · Logging',light:'#d5e5ff',dark:'#83aceb'}
];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const clamp = v => Math.max(0,Math.min(1,v));
const ease = v => {v=clamp(v); return v*v*(3-2*v);};
const mix = (a,b,p) => a+(b-a)*p;
const txt = (x,y,value,size=25,color=C.ink,weight=400,extra='') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" ${extra}>${esc(value)}</text>`;
const rect = (x,y,w,h,fill=C.paper,stroke=C.line,r=14,extra='') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" ${extra}/>`;
const line = (x1,y1,x2,y2,color=C.line,width=2,extra='') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ${extra}/>`;
function defs(){
  return `<defs>${WORK.map((w,i)=>`<linearGradient id="work-${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${w.light}"/><stop offset="1" stop-color="${w.dark}"/></linearGradient>`).join('')}</defs>`;
}
function shell(body,title,description){
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-labelledby="svg-title svg-description"><title id="svg-title">${esc(title)}</title><desc id="svg-description">${esc(description)}</desc>${defs()}<rect width="1280" height="720" fill="${C.bg}"/><g font-family="Arial, Helvetica, sans-serif">${body}</g></svg>`;
}
function header(){
  return txt(48,51,'mergetrain',32,C.ink,700)+txt(237,50,'by Oddfini',23,C.muted)+txt(1228,50,'Local merge queue',25,C.ink,500,'text-anchor="end"');
}
function footer(t=null){
  const scope='Recorded CLI results · disposable local Git remote · mergetrain 3.5.0';
  return line(48,650,1232,650)+txt(48,682,scope,23,C.muted)+(t===null?txt(1232,682,'50-second demo',23,C.muted,400,'text-anchor="end"'):txt(1232,682,`${Math.floor(t).toString().padStart(2,'0')} / 50 s`,23,C.muted,400,'text-anchor="end"'))+(t===null?'':rect(48,702,1184,3,C.line,'none',1)+rect(48,702,1184*clamp(t/50),3,C.blue,'none',1));
}
function moduleShape(i,cx,cy,w=88,h=26,status=null){
  const edge=status==='fail'?C.fail:status==='pass'?C.pass:status==='decision'?C.decision:WORK[i].dark;
  let out=rect(cx-w/2,cy-h/2,w,h,`url(#work-${i})`,edge,7,'stroke-width="2"');
  out+=line(cx-w/2+10,cy-h/2+6,cx+w/2-10,cy-h/2+6,'#ffffff',1.5);
  // Repeated notches preserve identity without moving reading text.
  for(let k=0;k<=i;k++) out+=rect(cx-w/2+11+k*10,cy+h/2-8,5,3,C.ink,'none',1,'fill-opacity="0.28"');
  return out;
}
function statusIcon(x,y,kind){
  if(kind==='pass') return `<circle cx="${x}" cy="${y}" r="9" fill="${C.passBg}" stroke="${C.pass}"/><path d="M${x-4},${y} l3,3 l5,-6" fill="none" stroke="${C.pass}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  if(kind==='fail') return `<circle cx="${x}" cy="${y}" r="9" fill="${C.failBg}" stroke="${C.fail}"/>${line(x-3,y-3,x+3,y+3,C.fail,2)}${line(x+3,y-3,x-3,y+3,C.fail,2)}`;
  return `<circle cx="${x}" cy="${y}" r="7" fill="${C.decisionBg}" stroke="${C.decision}" stroke-width="2"/>`;
}
function workflow(t,{offset=0,poster=false}={}){
  const failed=poster||t>=4;
  const dismissed=!poster&&t>=26;
  const deployed=!poster&&t>=43;
  const gateColor=failed&&!dismissed?C.fail:dismissed?C.pass:C.line;
  let out=txt(56,210+offset,'Illustrative workflow',23,C.muted);
  out+=rect(600,195+offset,245,177,C.paper,gateColor,16,'stroke-width="2"');
  out+=txt(622,223+offset,'One shared check',23,C.ink,700);
  if(dismissed) out+=rect(855,233+offset,377,73,C.decisionBg,'#ead7b8',10);
  if(poster) out+=rect(855,233+offset,377,73,C.failBg,'#ebcbd1',10);
  for(let i=0;i<4;i++){
    const y=252+33*i+offset;
    const pair=i<2;
    out+=line(357,y,592,y,C.line,2);
    out+=line(852,y,947,y,pair&&failed?(dismissed?C.decision:C.fail):C.line,2);
    out+=rect(56,y-16,287,31,C.paper,C.line,7);
    out+=txt(70,y+8,WORK[i].name,23,C.ink,500);
    out+=txt(327,y+8,'PASS',23,C.pass,700,'text-anchor="end"');
    let x;
    if(poster) x=pair?717:910;
    else {
      x=mix(405,717,ease((t-1.25-i*0.12)/2.2));
      if(pair&&dismissed) x=mix(717,908,ease((t-26.5)/2));
      if(!pair&&t>=32){
        const p=t<35.5?0.2*ease((t-32)/2):t<38.5?0.2+0.25*ease((t-35.5)/2):t<40.5?0.45+0.35*ease((t-38.5)/1.6):0.8+0.2*ease((t-40.5)/1.8);
        x=mix(717,910,p);
      }
    }
    const state=pair&&failed?(dismissed?'decision':'fail'):deployed||poster&&!pair?'pass':null;
    out+=moduleShape(i,x,y,88,26,state);
    let label='',color=C.muted,kind=null;
    if(poster){label=pair?'PAIR FAIL':'RETAINED';color=pair?C.fail:C.pass;kind=pair?'fail':'pass';}
    else if(pair&&dismissed){label='DISMISSED';color=C.decision;kind='decision';}
    else if(pair&&failed){label='BLOCKED';color=C.fail;kind='fail';}
    else if(!pair&&t>=43){label='DEPLOYED';color=C.pass;kind='pass';}
    else if(!pair&&t>=40.5){label='VERIFY';color=C.blue;}
    else if(!pair&&t>=38.5){label='ATOMIC PUSH';color=C.blue;}
    else if(!pair&&t>=35.5){label='RECHECK';color=C.blue;}
    else if(!pair&&t>=32){label='APPROVED';color=C.decision;kind='decision';}
    else if(!pair&&failed){label='VALIDATED';color=C.pass;kind='pass';}
    if(label){if(kind) out+=statusIcon(971,y,kind);out+=txt(990,y+8,label,23,color,700);}
  }
  if(failed&&!dismissed){
    out+=`<path d="M827,241 V230 H860 V296 H827" fill="none" stroke="${C.fail}" stroke-width="2" transform="translate(0 ${offset})"/>`;
  }
  return out;
}
function getRecord(evidence,kind){
  const records=Array.isArray(evidence?.records)?evidence.records:[];
  const patterns={validate:/\bvalidate\s*$/,inspect:/\binspect\s+1\s+--json\s*$/,dismiss:/\bdismiss\b/,deploy:/\bdeploy\s+--expected-plan(?:\s|=)/};
  return records.find(r=>patterns[kind].test(String(r.command??'')));
}
function wrapExact(raw,columns){
  // Wrap at spaces when possible; preserve every recorded character.
  const rows=[];
  for(const sourceLine of raw.split('\n')){
    let chars=Array.from(sourceLine);
    while(chars.length>columns){
      let cut=chars.slice(0,columns).lastIndexOf(' ')+1;
      if(cut<Math.floor(columns*0.4)) cut=columns;
      rows.push(chars.slice(0,cut).join(''));
      chars=chars.slice(cut);
    }
    rows.push(chars.join(''));
  }
  return rows;
}

function receipt(evidence,kind,t,start,end,note=''){
  const record=getRecord(evidence,kind);
  const label=kind==='inspect'?'Actual CLI output · inspect 1 · selected recorded lines':kind==='deploy'?'Actual CLI output · deploy · recorded result':`Actual CLI output · ${kind}`;
  let out=rect(48,402,1184,230,'#fcfcfa',C.line,14)+txt(72,434,label,23,C.muted,500);
  if(!record||typeof record.stdout!=='string') return out+txt(72,488,'Recorded output unavailable.',28,C.muted);
  const raw=record.stdout;
  const selected=kind==='inspect' ? raw.split('\n').filter(s => /"conflict_with"|"category"/.test(s)).join('\n') : raw.replace(/\n$/, '');
  const rows=wrapExact(selected,56);
  // Five lines fit without reducing the receipt type. Longer evidence is paged intact.
  const pageCount=Math.max(1,Math.ceil(rows.length/5));
  const page=Math.min(pageCount-1,Math.floor(clamp((t-start)/(end-start))*pageCount));
  out+=`<desc>${esc(raw)}</desc><g font-family="monospace" font-size="28" fill="${C.ink}" xml:space="preserve">`;
  rows.slice(page*5,page*5+5).forEach((s,i)=>{
    const color=/blocked/.test(s)?C.fail:/dismissed/.test(s)?C.decision:/validated|deployed/.test(s)?C.pass:C.ink;
    const n=Array.from(s).length;
    out+=`<text x="72" y="${472+i*32}" fill="${color}"${n?` textLength="${n*16.4}" lengthAdjust="spacingAndGlyphs"`:''}>${esc(s)}</text>`;
  });
  out+='</g>';
  if(pageCount>1) out+=txt(1208,434,`${page+1}/${pageCount}`,23,C.muted,400,'text-anchor="end"');
  if(note&&rows.length<=3) out+=txt(72,610,note,24,C.muted);
  return out;
}
function mismatch(){
  let out=rect(48,402,1184,230,C.paper,C.line,14);
  out+=line(441,426,441,542)+line(851,426,851,542);
  out+=txt(72,438,'Agent A · #1',24,C.ink,700)+txt(72,477,'DEFAULT_TIMEOUT',28,C.muted,400,'font-family="monospace"')+txt(72,535,'30 → 10',48,C.ink,700);
  out+=txt(466,438,'Agent B · #2',24,C.ink,700)+txt(466,477,'TIMEOUT_BUDGET',28,C.muted,400,'font-family="monospace"')+txt(466,535,'30',48,C.ink,700);
  out+=txt(880,438,'Test expects equality',24,C.muted)+txt(880,511,'10 ≠ 30',52,C.fail,700);
  out+=txt(72,578,'Each branch passes its own unit tests. Git merges cleanly.',25,C.ink);
  out+=txt(72,614,'The mismatch appears when these two changes are combined.',25,C.muted);
  return out;
}
function openingPanel(){
  return rect(48,402,1184,230,C.paper,C.line,14)+txt(76,451,'Four independent pieces of work.',31,C.ink,700)+txt(76,497,'Four passing branch test runs.',28,C.pass,500)+txt(76,552,'One shared check tests their combined behavior.',28,C.ink)+txt(76,601,'Follow the paired failure—and the operator’s decision.',25,C.muted);
}
function finalPanel(){
  return rect(48,402,1184,230,C.paper,C.line,14)+txt(76,464,'Try it locally',52,C.ink,700)+rect(76,492,564,63,C.blue,'none',9)+txt(104,533,'uvx mergetrain demo',29,'#ffffff',500,'font-family="monospace"')+txt(76,601,'Local merge queue for parallel LLM agents',25,C.muted)+txt(702,507,'#3 + #4 landed',31,C.pass,700)+txt(702,551,'Push succeeded. Verify succeeded.',25,C.ink)+txt(702,596,'#1 + #2 were dismissed by the operator.',24,C.decision);
}
export function frameSvg(t,evidence){
  t=Number.isFinite(Number(t))?Math.max(0,Math.min(DURATION,Number(t))):0;
  let title,subtitle,panel;
  if(t<4){title='Each branch passes.';subtitle='The combination fails.';panel=openingPanel();}
  else if(t<10){title='One shared check fails.';subtitle='The combined result holds a pair of otherwise passing branches.';panel=receipt(evidence,'validate',t,4,10);}
  else if(t<18){title='The mismatch is between them.';subtitle='Two branches expect different timeout values.';panel=mismatch();}
  else if(t<26){title='Hold the pair. Keep compatible work.';subtitle='One failed combination. Two compatible branches.';panel=t<22?receipt(evidence,'validate',t,18,22):receipt(evidence,'inspect',t,22,26,'Job #1 identifies job #2 as its semantic conflict.');}
  else if(t<32){title='The operator dismisses the pair.';subtitle='For this demo, explicitly exclude #1 and #2; retain #3 and #4.';panel=receipt(evidence,'dismiss',t,26,32,'The retained pair is available for an approved deployment.');}
  else if(t<43){
    if(t<35.5){title='Approve the exact surviving plan.';subtitle='This disposable demo pins its authorization to that plan.';}
    else if(t<38.5){title='Recheck before the push.';subtitle='Configured checks rerun before deployment by default.';}
    else if(t<40.5){title='Push atomically to the local remote.';subtitle='Deploy the approved surviving combination to disposable Git.';}
    else {title='Verify the deployed result.';subtitle='The recorded result confirms both push and verification succeeded.';}
    panel=receipt(evidence,'deploy',t,32,43);
  } else {title='Two compatible branches landed.';subtitle='Explicit operator choice. Approved plan. Rechecked and verified.';panel=finalPanel();}
  let out=header()+txt(48,119,title,52,C.ink,700);
  out+=txt(48,t<4?174:164,subtitle,t<4?48:25,t<4?C.fail:C.muted,t<4?700:400);
  out+=workflow(t)+panel+footer(t);
  return shell(out,title,'Illustrative workflow paired with actual recorded CLI output. Four passing branches enter one shared check. A semantic conflict blocks jobs 1 and 2. The operator dismisses that pair for this demo, then authorizes the exact surviving plan. Default pre-push checks, atomic push to a disposable local Git remote, and verification precede the deployment of jobs 3 and 4.');
}
export function posterSvg(evidence){
  let out=header();
  out+=txt(48,120,'Each branch passes.',60,C.ink,700);
  out+=txt(48,184,'The combination fails.',60,C.fail,700);
  out+=txt(48,230,'Local merge queue for parallel LLM agents',27,C.muted);
  out+=workflow(18,{offset:96,poster:true});
  out+=txt(56,511,'The operator excludes #1 + #2 for this demo.',27,C.decision,700);
  out+=txt(56,547,'The retained pair is approved, rechecked, pushed and verified.',25,C.ink);
  out+=rect(48,570,1184,62,C.paper,C.line,12);
  out+=txt(72,610,'Watch the 50-second demo',28,C.blue,700);
  out+=txt(1208,609,'Try it locally · uvx mergetrain demo',26,C.ink,500,'text-anchor="end"');
  out+=footer();
  return shell(out,'Each branch passes. The combination fails.','mergetrain by Oddfini. Illustrative workflow: four passing branches enter one shared check. The shared check identifies the failure between jobs 1 and 2. The operator excludes that pair for this demo and retains jobs 3 and 4 for exact-plan approval, default pre-push recheck, atomic push to the disposable local Git remote, and verification. Watch the 50-second demo.');
}
function panel(x,y,w,h){return rect(x,y,w,h,C.paper,C.line,14);}
export function explainerSvg(evidence){
  let out=header()+txt(48,121,'Why check the combination?',54,C.ink,700);
  const left=48,right=652,width=580;
  out+=panel(left,151,width,229)+panel(right,151,width,229)+panel(left,400,width,232)+panel(right,400,width,232);
  out+=txt(72,177,'01 · Illustrative workflow',23,C.muted)+txt(676,177,'02 · One shared check',23,C.muted);
  out+=txt(72,226,'Branches pass',48,C.ink,700)+txt(676,226,'Combination fails',48,C.ink,700);
  for(let i=0;i<4;i++){
    const x=127+i*135;
    out+=moduleShape(i,x,271,92,32,'pass');
    out+=txt(x,318,`#${i+1} PASS`,23,C.pass,700,'text-anchor="middle"');
  }
  out+=txt(72,359,'Four independent unit-test runs pass.',24,C.muted);
  out+=rect(680,242,524,88,'#fcfcfa',C.fail,10);
  for(let i=0;i<4;i++)out+=moduleShape(i,740+i*132,269,78,27,i<2?'fail':null);
  out+=line(707,296,905,296,C.fail,2)+line(707,288,707,296,C.fail,2)+line(905,288,905,296,C.fail,2);
  out+=txt(698,321,'#1 + #2 · test expects equality',23,C.fail,500);
  out+=txt(676,359,'10 ≠ 30 · Git still merges cleanly.',24,C.muted);
  out+=txt(72,426,'03 · Explicit operator action',23,C.decision)+txt(676,426,'04 · Disposable local Git remote',23,C.muted);
  out+=txt(72,475,'Operator decides',48,C.ink,700)+txt(676,475,'Survivors land',48,C.ink,700);
  out+=rect(72,491,244,55,C.decisionBg,'#ead7b8',9);
  out+=moduleShape(0,129,518,84,28,'decision')+moduleShape(1,257,518,84,28,'decision');
  out+=line(331,518,359,518,C.line,2);
  out+=moduleShape(2,421,518,84,28,'pass')+moduleShape(3,549,518,84,28,'pass');
  out+=txt(72,580,'Dismiss #1 and #2 for this demo.',25,C.decision,500);
  out+=txt(72,615,'Retain the compatible pair: #3 and #4.',24,C.ink);
  out+=moduleShape(2,738,519,88,30,'pass')+moduleShape(3,864,519,88,30,'pass');
  out+=line(922,519,1000,519,C.pass,2)+`<path d="M991,513 L1000,519 L991,525" fill="none" stroke="${C.pass}" stroke-width="2"/>`;
  out+=statusIcon(1026,519,'pass')+txt(1044,527,'VERIFIED',23,C.pass,700);
  out+=txt(676,580,'Exact plan approved · default recheck',24,C.ink);
  out+=txt(676,615,'Atomic push to local remote · verified',24,C.muted);
  out+=footer();
  return shell(out,'Why check the combination?','Four-panel illustrative explainer. Separate branches pass their unit tests. Their combination fails because Agent A changes DEFAULT_TIMEOUT from 30 to 10 while Agent B adds TIMEOUT_BUDGET equal to 30; the test expects equality. Git merges cleanly. The operator explicitly dismisses jobs 1 and 2 for this demo and retains jobs 3 and 4. Authorization is bound to the exact surviving plan. Configured checks rerun before push by default. An atomic push to the disposable local Git remote and verification complete the deployment.');
}
