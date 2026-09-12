#!/usr/bin/env node
/**
 * Align a script you already have to the speech in a recording.
 *
 *   node scripts/align-script.cjs <media> <lines.txt> [-o out.json]
 *   node scripts/align-script.cjs <media> --manifest shoot.json --shot 3
 *
 * Nothing here transcribes. The words come from the script that was written
 * before the shoot; this only works out WHEN each of them is said, by finding
 * where speech actually sits in the audio and dividing that time between the
 * lines in proportion to their length.
 *
 * That matters because Thai speech-to-text is not available in this
 * environment, which otherwise forces the words to be typed in by hand before
 * captions can be timed.
 *
 * The result is approximate: it lands lines on real speech and keeps them off
 * the pauses, but it does not know which syllable is which. For caption-sized
 * chunks that reads as in sync; do not treat it as word-level truth.
 */
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function die(msg){ console.error('error: ' + msg); process.exit(1); }

function ffprobeDuration(file){
  const out = execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', file], {encoding:'utf8'});
  const d = parseFloat(out.trim());
  if(!isFinite(d)) die('could not read duration of ' + file);
  return d;
}

/**
 * ffmpeg writes volumedetect/silencedetect results to STDERR and still exits 0,
 * so execFileSync — which returns stdout — hands back an empty string on the
 * successful runs this tool depends on. spawnSync exposes stderr either way.
 */
function ffmpegStderr(args){
  const r = spawnSync('ffmpeg', args, {encoding:'utf8', maxBuffer: 64 * 1024 * 1024});
  return (r.stderr || '').toString();
}

function meanVolume(file){
  const out = ffmpegStderr(['-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = out.match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? parseFloat(m[1]) : -20;
}

/**
 * Pull the audio out once, small and mono, so the threshold sweep below can run
 * a dozen passes over it without re-decoding the video every time.
 */
function extractAudio(file){
  const tmp = path.join(require('os').tmpdir(), 'align_' + process.pid + '.wav');
  ffmpegStderr(['-y','-i', file, '-vn', '-ac','1', '-ar','16000', '-c:a','pcm_s16le', tmp]);
  if(!fs.existsSync(tmp)) die('could not extract audio from ' + file);
  return tmp;
}

function detectSilences(file, thresholdDb, minGap){
  const out = ffmpegStderr(['-i', file, '-af', `silencedetect=noise=${thresholdDb}dB:d=${minGap}`, '-f','null','-']);
  const silences = [];
  let pending = null;
  for(const line of out.split('\n')){
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if(s){ pending = parseFloat(s[1]); continue; }
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if(e && pending !== null){ silences.push([pending, parseFloat(e[1])]); pending = null; }
  }
  if(pending !== null) silences.push([pending, Infinity]);
  return silences;
}

function silencesToSegments(silences, duration){
  const segments = [];
  let cursor = 0;
  for(const [start, rawEnd] of silences){
    const end = Math.min(rawEnd, duration);
    if(start - cursor > 0.08) segments.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if(duration - cursor > 0.08) segments.push([cursor, duration]);
  return segments;
}

/**
 * Find the sensitivity that actually splits THIS recording.
 *
 * A single fixed threshold cannot do it: the useful setting depends on the room,
 * the mic, and how fast the person talks. Measured on this project's own
 * footage, `floor - 8` at a 0.18s gap detected no silence at all and collapsed
 * the whole clip into one segment, which makes the alignment below a plain even
 * division — the failure this function exists to prevent.
 *
 * So sweep, and keep the setting whose segment count lands nearest the number of
 * lines being placed: N lines are normally separated by about N-1 pauses. Ties
 * go to the least sensitive setting, since over-segmenting chops words in half.
 */
function speechSegments(file, duration, lineCount){
  const floor = meanVolume(file);
  const candidates = [];
  for(const drop of [2, 3, 4, 5, 6, 8, 10]){
    for(const gap of [0.08, 0.12, 0.18, 0.25]){
      const thresh = Math.round(floor - drop);
      const segments = silencesToSegments(detectSilences(file, thresh, gap), duration);
      const speech = segments.reduce((s,[a,b]) => s + (b - a), 0);
      // Reject the degenerate ends: nothing detected, or so much cut that the
      // words themselves are being treated as silence.
      if(segments.length < 2) continue;
      if(speech < duration * 0.25) continue;
      candidates.push({ segments, thresh, gap, speech, fit: Math.abs(segments.length - lineCount) });
    }
  }
  if(candidates.length === 0){
    // Continuous speech with no usable pause: one segment, and the alignment
    // below degrades to a proportional split. Reported so it is never silent.
    const thresh = Math.round(floor - 4);
    return { segments: [[0, duration]], threshold: thresh, floor, fallback: true };
  }
  candidates.sort((a, b) => a.fit - b.fit || a.segments.length - b.segments.length);
  const best = candidates[0];
  return { segments: best.segments, threshold: best.thresh, gap: best.gap, floor, fallback: false };
}

// Thai has no spaces between words, so a word count would read every line as
// one token. Characters track speaking time far better across both scripts.
function weightOf(line){
  return Math.max(1, line.replace(/\s+/g, '').length);
}

/**
 * Walk the speech segments in order, handing each line the share of speaking
 * time its length earns. Lines therefore never start inside a pause, and a long
 * line cannot be squeezed into a short burst just because the two happen to be
 * adjacent.
 */
function alignLines(lines, segments){
  // When the sweep found exactly as many speech bursts as there are lines, the
  // bursts ARE the lines: take them directly. Length-proportional splitting is a
  // model of speaking time, and a bad one whenever delivery is uneven — on this
  // project's own test clip it put the middle lines up to 2.4s off, because a
  // short line drawled slowly and a long one said quickly both get the time
  // their character count claims rather than the time they actually took.
  if(segments.length === lines.length){
    return lines.map((text, i) => ({
      text,
      start: Number(segments[i][0].toFixed(3)),
      end: Number(segments[i][1].toFixed(3)),
    }));
  }
  const speechTotal = segments.reduce((s, [a, b]) => s + (b - a), 0);
  if(speechTotal <= 0) die('no speech found — check the audio track');
  const weightTotal = lines.reduce((s, l) => s + weightOf(l), 0);

  const out = [];
  let segIdx = 0;
  let posInSeg = segments[0][0];

  for(const line of lines){
    const want = (weightOf(line) / weightTotal) * speechTotal;
    const start = posInSeg;
    let remaining = want;
    let end = posInSeg;

    while(remaining > 0 && segIdx < segments.length){
      const segEnd = segments[segIdx][1];
      const available = segEnd - posInSeg;
      if(available > remaining){
        posInSeg += remaining;
        end = posInSeg;
        remaining = 0;
      }else{
        remaining -= available;
        end = segEnd;
        segIdx++;
        if(segIdx < segments.length) posInSeg = segments[segIdx][0];
      }
    }
    out.push({ text: line, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) });
  }
  return out;
}

function linesFromManifest(file, shotNumber){
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if(!Array.isArray(manifest.shots)) die('manifest has no shots array');
  if(shotNumber == null){
    // Whole piece: every spoken line, in shot order.
    return manifest.shots.reduce((acc, s) => acc.concat(s.lines || []), []);
  }
  const shot = manifest.shots.find(s => Number(s.number) === Number(shotNumber));
  if(!shot) die('no shot #' + shotNumber + ' in manifest');
  return shot.lines || [];
}

function main(){
  const argv = process.argv.slice(2);
  if(argv.length < 2) die('usage: align-script.cjs <media> <lines.txt | --manifest file.json [--shot N]> [-o out.json]');

  const media = argv[0];
  if(!fs.existsSync(media)) die('no such file: ' + media);

  let lines = null, outFile = null, shotNumber = null, manifestFile = null;
  for(let i = 1; i < argv.length; i++){
    const a = argv[i];
    if(a === '-o' || a === '--out') outFile = argv[++i];
    else if(a === '--manifest') manifestFile = argv[++i];
    else if(a === '--shot') shotNumber = argv[++i];
    else if(!manifestFile && lines === null){
      if(!fs.existsSync(a)) die('no such file: ' + a);
      lines = fs.readFileSync(a, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    }
  }
  if(manifestFile) lines = linesFromManifest(manifestFile, shotNumber);
  if(!lines || lines.length === 0) die('no script lines given');

  const duration = ffprobeDuration(media);
  const audio = extractAudio(media);
  let detected;
  try{ detected = speechSegments(audio, duration, lines.length); }
  finally{ try{ fs.unlinkSync(audio); }catch(e){ /* temp file already gone */ } }
  const { segments, threshold, floor, gap, fallback } = detected;
  const timed = alignLines(lines, segments);

  const result = {
    media: path.basename(media),
    durationSec: Number(duration.toFixed(3)),
    noiseFloorDb: floor,
    silenceThresholdDb: threshold,
    silenceGapSec: gap || null,
    continuousSpeech: !!fallback,
    speechSegments: segments.map(([a, b]) => [Number(a.toFixed(3)), Number(b.toFixed(3))]),
    lines: timed,
  };

  const json = JSON.stringify(result, null, 2);
  if(outFile){ fs.writeFileSync(outFile, json + '\n'); }

  console.error(`${lines.length} lines over ${segments.length} speech segments ` +
    `(floor ${floor}dB, threshold ${threshold}dB${gap ? ', gap ' + gap + 's' : ''}, ${duration.toFixed(1)}s)`);
  if(fallback) console.error('  note: no usable pauses found — lines split proportionally across the whole clip');
  for(const l of timed){
    console.error(`  ${l.start.toFixed(2).padStart(6)}s → ${l.end.toFixed(2).padStart(6)}s  ${l.text}`);
  }
  if(outFile) console.error('wrote ' + outFile);
  else console.log(json);
}

main();
