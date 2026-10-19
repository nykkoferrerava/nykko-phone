"""Compares voice-over candidates with measurements instead of ears:
pitch movement (semitone spread of the voiced frames: flat reads as bored), loudness dynamics,
pace, brightness, and whether a speech recogniser hears the words that were meant.

  .venv/bin/python audio/analyze_vo.py .cache/vo-candidates  > audio/vo-candidates.md
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

def f0_track(x, sr, fmin=70, fmax=400, hop=0.01, win=0.04):
    n, h = int(win * sr), int(hop * sr)
    out = []
    for i in range(0, len(x) - n, h):
        fr = x[i:i + n] * np.hanning(n)
        if np.sqrt(np.mean(fr ** 2)) < 0.02:
            continue
        ac = np.correlate(fr, fr, 'full')[n - 1:]
        lo, hi = int(sr / fmax), int(sr / fmin)
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] / (ac[0] + 1e-9) > 0.45:
            out.append(sr / k)
    return np.array(out)

def measure(files, words):
    x = np.concatenate([sf.read(f)[0] for f in files])
    sr = sf.info(files[0]).samplerate
    f0 = f0_track(x, sr)
    st = 12 * np.log2(f0 / np.median(f0))
    frame = int(0.05 * sr)
    rms = np.array([np.sqrt(np.mean(x[i:i + frame] ** 2)) for i in range(0, len(x) - frame, frame)])
    db = 20 * np.log10(rms[rms > 1e-3])
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    dur = len(x) / sr
    return {
        'duration_s': round(dur, 2),
        'median_f0_hz': round(float(np.median(f0)), 1),
        'pitch_spread_st': round(float(np.percentile(st, 90) - np.percentile(st, 10)), 2),
        'pitch_sd_st': round(float(np.std(st)), 2),
        'loudness_range_db': round(float(np.percentile(db, 95) - np.percentile(db, 20)), 1),
        'words_per_s': round(words / dur, 2),
        'centroid_hz': round(float(np.sum(freqs * spec) / np.sum(spec)), 0),
    }

def heard(path):
    try:
        r = subprocess.run(['node_modules/.bin/hyperframes', 'transcribe', str(path), '--engine', 'parakeet', '--json', '-d', '.cache/vo'],
                           capture_output=True, text=True, timeout=600)
        j = json.loads(r.stdout.strip().split('\n')[-1])
        words = json.loads(Path(j['transcriptPath']).read_text())
        return ' '.join(w['text'] for w in words)
    except Exception as e:  # noqa: BLE001
        return f'(transcription failed: {e})'

def main():
    d = Path(sys.argv[1])
    voices = sorted({p.name.split('-')[0] for p in d.glob('*-L01.wav')})
    words = len('Payday. Gone by Tuesday? Meet Pitaka.'.split())
    rows = []
    for v in voices:
        files = [d / f'{v}-L01.wav', d / f'{v}-L02.wav']
        m = measure(files, words)
        m['heard'] = ' / '.join(heard(f) for f in files)
        rows.append((v, m))
    keys = ['duration_s', 'median_f0_hz', 'pitch_spread_st', 'pitch_sd_st', 'loudness_range_db', 'words_per_s', 'centroid_hz', 'heard']
    print('| voice | ' + ' | '.join(keys) + ' |')
    print('|' + '---|' * (len(keys) + 1))
    for v, m in rows:
        print(f'| {v} | ' + ' | '.join(str(m[k]) for k in keys) + ' |')

main()
