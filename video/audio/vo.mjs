// Voice-over with HyperFrames' local Kokoro TTS (nothing leaves this machine).
//
//   node audio/vo.mjs candidates   three voices read the first two lines → .cache/vo-candidates/
//   node audio/vo.mjs              one file per line in the chosen voice → audio/vo/L01.wav …,
//                                  then word timings (local Parakeet ASR) → audio/vo/timings.json
//
// The voice and speed live in audio/vo-lines.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIDEO = fileURLToPath(new URL('..', import.meta.url));
const cfg = JSON.parse(readFileSync(path.join(VIDEO, 'audio/vo-lines.json'), 'utf8'));
const env = { ...process.env, PATH: `${path.join(VIDEO, '.venv/bin')}:${process.env.PATH}`, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' };
const hf = (args, opts = {}) => execFileSync(path.join(VIDEO, 'node_modules/.bin/hyperframes'), args, { env, encoding: 'utf8', cwd: VIDEO, maxBuffer: 64 << 20, ...opts });
const duration = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());

function tts(text, voice, speed, out) {
  const r = JSON.parse(hf(['tts', text, '--voice', voice, '--speed', String(speed), '-o', out, '--json']).trim().split('\n').pop());
  if (!r.ok) throw new Error(`tts failed for ${out}`);
  return r;
}
// Trims the leading and trailing silence Kokoro leaves, keeping 40 ms, and writes 48 kHz mono.
function trim(inp, out) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', inp, '-af',
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.04,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse',
    '-ar', '48000', '-ac', '1', out]);
}

const mode = process.argv[2] || 'final';
if (mode === 'candidates') {
  const dir = path.join(VIDEO, '.cache/vo-candidates');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const voices = (process.argv[3] || 'af_heart,af_bella,am_puck').split(',');
  const lines = cfg.lines.slice(0, 2);
  for (const v of voices) {
    for (const l of lines) {
      const raw = path.join(dir, `${v}-${l.id}.raw.wav`);
      tts(l.tts, v, cfg.speed, raw);
      trim(raw, path.join(dir, `${v}-${l.id}.wav`));
    }
    console.log(v, lines.map((l) => `${l.id} ${duration(path.join(dir, `${v}-${l.id}.wav`)).toFixed(2)} s`).join(', '));
  }
} else {
  const dir = path.join(VIDEO, 'audio/vo');
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(VIDEO, '.cache/vo');
  mkdirSync(tmp, { recursive: true });
  const out = { voice: cfg.voice, speed: cfg.speed, engine: 'Kokoro-82M (local, via hyperframes tts)', lines: [] };
  for (const l of cfg.lines) {
    const raw = path.join(tmp, `${l.id}.raw.wav`);
    const file = path.join(dir, `${l.id}.wav`);
    if (!existsSync(file) || process.env.VO_FORCE) { tts(l.tts, cfg.voice, cfg.speed, raw); trim(raw, file); }
    // Word timings from the local Parakeet model, mapped onto the caption's words.
    const json = hf(['transcribe', file, '--engine', 'parakeet', '--json', '-d', tmp], { stdio: ['ignore', 'pipe', 'ignore'] });
    let words = [];
    try { const r = JSON.parse(json.trim().split('\n').pop()); words = JSON.parse(readFileSync(r.transcriptPath, 'utf8')); } catch { words = []; }
    out.lines.push({ ...l, file: `audio/vo/${l.id}.wav`, duration: +duration(file).toFixed(3), heard: words.map((w) => w.text).join(' '), asrWords: words.map((w) => ({ text: w.text, start: +w.start.toFixed(3), end: +w.end.toFixed(3) })) });
    console.log(l.id, out.lines.at(-1).duration.toFixed(2), 's |', out.lines.at(-1).heard);
  }
  writeFileSync(path.join(dir, 'timings.json'), JSON.stringify(out, null, 2));
}
