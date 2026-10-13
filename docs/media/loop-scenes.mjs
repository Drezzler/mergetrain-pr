// A condensed illustration of archived CLI results, not a product UI recording.
export const WIDTH = 960;
export const HEIGHT = 800;
export const DURATION = 12;
const blue = '#005de8', ink = '#122c58', paper = '#ffffff';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x, y, value, size = 38, fill = ink, weight = 600, extra = '') =>
  `<text x="${x}" y="${y}" fill="${fill}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}" ${extra}>${escape(value)}</text>`;

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

const phases = [
  ['Four changes, one check.', 'Each passes on its own.', 'MERGETRAIN CHECKS THEM TOGETHER'],
  ['Two changes conflict.', 'The shared check catches it.', 'THE CONFLICTING PAIR STAYS OUT'],
  ['You choose what goes in.', 'Hold the pair. Approve the rest.', 'YOU APPROVE THE TWO CHECKED CHANGES'],
  ['Two changes applied.', 'Checked again. Push verified.', '2 HELD  ·  2 APPLIED AFTER APPROVAL'],
];

export function frameSvg(time, story) {
  const phase = time < 2.5 ? 0 : time < 5.5 ? 1 : time < 8.5 ? 2 : 3;
  const [headline, subtitle, footer] = phases[phase];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="960" height="800" fill="${blue}"/>`;
  svg += text(48, 58, 'mergetrain', 32, paper, 700);
  svg += text(912, 58, 'RECORDED DEMO · 12 SEC', 23, '#dceaff', 500, 'text-anchor="end"');
  svg += text(48, 140, headline, 63, paper, 700);
  svg += text(48, 190, subtitle, 34, paper, 400);
  story.forEach((job, i) => {
    const y = 232 + i * 108;
    const conflict = job.held && phase > 0;
    const applied = !job.held && phase === 3;
    const status = phase === 0 ? 'Pass' : conflict ? (phase === 1 ? 'Conflict' : 'Held') : applied ? 'Applied' : 'Checked';
    const color = conflict ? '#a82b2b' : applied ? '#176548' : ink;
    svg += `<rect x="48" y="${y}" width="864" height="92" rx="12" fill="${conflict ? '#fff0ec' : paper}"/>`;
    svg += `<circle cx="88" cy="${y + 46}" r="19" fill="${conflict ? '#a82b2b' : applied ? '#176548' : '#e8effa'}"/>`;
    svg += text(88, y + 54, conflict ? '!' : applied ? '✓' : job.id, 25, conflict || applied ? paper : ink, 700, 'text-anchor="middle"');
    svg += text(126, y + 61, job.label, 43, ink, 600);
    svg += text(878, y + 59, status, 35, color, 700, 'text-anchor="end"');
  });
  svg += text(480, 725, footer, 29, paper, 700, 'text-anchor="middle"');
  for (let i = 0; i < 4; i++) {
    svg += `<rect x="${48 + i * 220}" y="763" width="204" height="5" rx="2" fill="${i <= phase ? paper : '#4082e7'}"/>`;
  }
  return svg + '</svg>';
}
