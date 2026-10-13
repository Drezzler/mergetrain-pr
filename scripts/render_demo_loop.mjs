import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {DURATION, WIDTH, HEIGHT, readStory, frameSvg} from '../docs/media/loop-scenes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../docs/media/package.json', import.meta.url));
const sharp = require('sharp');
const evidenceBytes = await fs.readFile(path.join(root, 'docs/media/demo-evidence.json'));
const evidence = JSON.parse(evidenceBytes);
const story = readStory(evidence);
const images = path.join(root, 'docs/images');
const base = path.join(images, 'mergetrain-loop');
const fps = 24;
await fs.mkdir(images, {recursive: true});
const poster = frameSvg(10, story);
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
const gif = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `${base}.mp4`, '-vf', 'fps=10,scale=720:600:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=none', '-loop', '0', `${base}.gif`], {stdio: 'inherit'});
if (gif.error || gif.status !== 0) throw gif.error || new Error('GIF export failed.');
const hashes = {};
for (const ext of ['.mp4', '.gif', '-poster.png', '-poster.svg']) {
  const bytes = await fs.readFile(base + ext);
  hashes[`mergetrain-loop${ext}`] = {bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
}
await fs.writeFile(path.join(root, 'docs/media/loop-production.json'), JSON.stringify({
  duration_seconds: DURATION, width: WIDTH, height: HEIGHT, frames_per_second: fps,
  audio: false, gif: {width: 720, height: 600, frames_per_second: 10},
  method: 'Code-authored summary of recorded CLI results. No invented product UI or terminal output. Time is condensed; this is not a performance benchmark.',
  design: 'Selected cobalt direction, four fixed work items, short captions, no narration.',
  source_commit: evidence.source_commit, runtime_version: evidence.version, scope: evidence.scope,
  operator_actions: 'The recorded walkthrough scripts explicit pair dismissal and exact-plan approval before the default recheck and verified push to a disposable local bare remote.',
  evidence_sha256: createHash('sha256').update(evidenceBytes).digest('hex'),
  rows: story, assets: hashes,
}, null, 2) + '\n');
console.log(JSON.stringify(hashes, null, 2));
