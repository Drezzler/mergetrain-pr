/** Render GPT-6 Astra's code-authored scenes from captured CLI evidence. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {DURATION, frameSvg, explainerSvg, posterSvg} from '../docs/media/demo-scenes.mjs';

const require = createRequire(new URL('../docs/media/package.json', import.meta.url));
const sharp = require('sharp');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const images = path.join(repo, 'docs/images');
const evidence = JSON.parse(await fs.readFile(path.join(repo, 'docs/media/demo-evidence.json'), 'utf8'));
const fps = 24;
if (DURATION !== 50 || evidence.version !== '3.5.0') throw new Error('Review duration and evidence version before rendering.');
const runs = evidence.records;
const validation = runs.find(r => r.command.endsWith(' validate'));
const dismissal = runs.find(r => / dismiss /.test(r.command));
const deployment = runs.find(r => / deploy --expected-plan /.test(r.command));
const individual = runs.filter(r => r.branch && /unittest/.test(r.command) && r.returncode === 0);
if (individual.length !== 4 || validation?.returncode !== 1 || deployment?.returncode !== 0 ||
    !['#1 blocked:', '#2 blocked:', '#3 validated:', '#4 validated:'].every(s => validation.stdout.includes(s)) ||
    !['dismissed job 1:', 'dismissed job 2:'].every(s => dismissal?.stdout.includes(s)) ||
    !['#3 deployed (push=succeeded, verify=succeeded)', '#4 deployed (push=succeeded, verify=succeeded)'].every(s => deployment.stdout.includes(s))) {
  throw new Error('Recorded run does not prove the story. Recapture and review before rendering.');
}
await fs.mkdir(images, {recursive: true});

for (const [name, svg] of [
  ['mergetrain-explainer-still', explainerSvg(evidence)],
  ['mergetrain-demo-poster', posterSvg(evidence)],
]) {
  await fs.writeFile(path.join(images, `${name}.svg`), svg);
  await sharp(Buffer.from(svg)).png().toFile(path.join(images, `${name}.png`));
}
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>mergetrain — combined failure explained</title><style>body{margin:0;background:#f7f7f5}svg{display:block;width:100%;height:auto;max-width:1280px;margin:auto}</style>${explainerSvg(evidence)}</html>`;
await fs.writeFile(path.join(images, 'mergetrain-explainer.html'), html);

if (process.argv.includes('--stills')) {
  console.log('Rendered source SVGs, static PNGs, and explainer HTML.');
  process.exit(0);
}
const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(images, 'mergetrain-demo.mp4')], {stdio:['pipe', 'inherit', 'inherit']});
let encodeError;
ffmpeg.on('error', e => { encodeError = e; });
ffmpeg.stdin.on('error', e => { encodeError = e; });
const completion = new Promise((resolve, reject) => ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`))));
completion.catch(() => {});
for (let i = 0; i < DURATION * fps; i++) {
  if (encodeError) throw encodeError;
  const png = await sharp(Buffer.from(frameSvg(i / fps, evidence))).png().toBuffer();
  if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, 'drain');
  if (i % (fps * 10) === 0) console.log(`Rendered ${i / fps}s / ${DURATION}s`);
}
ffmpeg.stdin.end();
await completion;
console.log(`Rendered ${DURATION}s video with ${DURATION * fps} evidence-driven frames.`);

const teaser = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(images, 'mergetrain-demo.mp4'), '-t', '10', '-vf', 'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer:bayer_scale=3', '-loop', '0', path.join(images, 'mergetrain-explainer.gif')], {stdio:'inherit'});
if (teaser.error || teaser.status !== 0) throw teaser.error || new Error('FFmpeg teaser export failed.');
console.log('Rendered the 10-second preview GIF.');
