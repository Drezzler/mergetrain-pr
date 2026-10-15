import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {DURATION, WIDTH, HEIGHT, PROCESSING_MODE, TIMELINE, readStory, frameSvg} from '../docs/media/loop-scenes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../docs/media/package.json', import.meta.url));
const sharp = require('sharp');
const evidenceBytes = await fs.readFile(path.join(root, 'docs/media/cycle-evidence.json'));
const evidence = JSON.parse(evidenceBytes);
const story = readStory(evidence);
const images = path.join(root, 'docs/images');
const base = path.join(images, 'mergetrain-loop');
const fps = 24;
await fs.mkdir(images, {recursive: true});
const poster = frameSvg(10.3, story, {poster:true});
await fs.writeFile(`${base}-poster.svg`, poster);
await sharp(Buffer.from(poster)).png().toFile(`${base}-poster.png`);
if (process.argv.includes('--stills')) process.exit(0);

const encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0', '-an', '-vf', 'scale=out_color_matrix=bt709', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', '3.1', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${base}.mp4`], {stdio: ['pipe', 'inherit', 'inherit']});
let failure;
encoder.on('error', e => { failure = e; });
encoder.stdin.on('error', e => { failure = e; });
const completion = new Promise((resolve, reject) => encoder.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`))));
completion.catch(() => {});
for (let frame = 0; frame < DURATION * fps; frame++) {
  if (failure) throw failure;
  const png = await sharp(Buffer.from(frameSvg(frame / fps, story))).png().toBuffer();
  if (!encoder.stdin.write(png)) await once(encoder.stdin, 'drain');
}
encoder.stdin.end();
await completion;
const gif = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `${base}.mp4`, '-vf', 'fps=20,scale=720:600:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none', '-loop', '0', `${base}.gif`], {stdio: 'inherit'});
if (gif.error || gif.status !== 0) throw gif.error || new Error('GIF export failed.');
const hashes = {};
for (const ext of ['.mp4', '.gif', '-poster.png', '-poster.svg']) {
  const bytes = await fs.readFile(base + ext);
  hashes[`mergetrain-loop${ext}`] = {bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
}
await fs.writeFile(path.join(root, 'docs/media/loop-production.json'), JSON.stringify({
  processing_mode: PROCESSING_MODE, timeline: TIMELINE,
  duration_seconds: DURATION, width: WIDTH, height: HEIGHT, frames_per_second: fps,
  audio: false, gif: {width: 720, height: 600, frames_per_second: 20},
  method: 'Code-authored summary of recorded CLI results. No invented product UI or terminal output. Time is condensed; this is not a performance benchmark.',
  design: 'Four agent identities stay visible. A persistent Batch · default label identifies the mode. Work A-D returns or moves ahead; E-F appears at 3 seconds while A-B is checked. G-H starts during E-F validation, and I-J follows deployment. Letters track recorded work across repair and replacement jobs; dashed cards are unsubmitted drafts. Applied work remains visible. Only work markers transition at replay; agents and paths do not dissolve.',
  source_commit: evidence.source_commit, runtime_version: evidence.version, scope: evidence.scope,
  operator_actions: 'The capture scripts agent-authored changes and operator approvals for three deployments to a disposable local bare remote. Two fixture gate barriers prove next-batch commits and following drafts overlap validation; elapsed time is not a speed claim. The four agent lanes are illustrative roles, not recorded AI process identities. Four final drafts are neither submitted nor validated. Mergetrain does not launch an AI agent or author changes.',
  evidence_sha256: createHash('sha256').update(evidenceBytes).digest('hex'),
  rows: story, drafts: evidence.proof.following_drafts.map(d=>({...d,visualId:'ABCDEFGHIJ'[d.item-1]})),
  first_overlap_seconds: 3, assets: hashes,
}, null, 2) + '\n');
// Returning visitors must not combine the new story with an older cached file.
for (const relative of ['README.md', 'site/index.html']) {
  const filename = path.join(root, relative);
  const source = await fs.readFile(filename, 'utf8');
  await fs.writeFile(filename, source.replace(/(mergetrain-loop(?:\.gif|\.mp4|-poster\.png))(?:\?v=[a-f0-9]+)?/g,
    (_, name) => name + '?v=' + hashes[name].sha256.slice(0, 12)));
}
console.log(JSON.stringify(hashes, null, 2));
