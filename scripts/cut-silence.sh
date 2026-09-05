#!/bin/bash
# Cut the silence out of a recording, keeping only the parts where someone talks.
#
#   ./cut-silence.sh in.mp4                    # write in-tight.mp4
#   ./cut-silence.sh in.mp4 out.mp4            # ...under a name you pick
#   ./cut-silence.sh in.mp4 --list             # print the keep ranges, render nothing
#   ./cut-silence.sh in.mp4 --pad 0.25         # leave more air around each take
#   ./cut-silence.sh in.mp4 --min-silence 1.0  # only cut pauses longer than this
#
# Run it on the ORIGINAL file, not a proxy: it re-encodes once from the source,
# so the output is as sharp as the input. An 8-minute talking recording usually
# lands around 5 minutes.
#
# --list prints timecodes as mm:ss.s, which is what you type into a normal
# editor's timeline. Use it when the cutting has to happen in CapCut or Premiere
# rather than here — the numbers are the same either way.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
command -v ffmpeg >/dev/null || die "ffmpeg not found"
command -v ffprobe >/dev/null || die "ffprobe not found"
command -v python3 >/dev/null || die "python3 not found"

in=""; out=""; pad=0.15; min_silence=0.6; min_keep=0.4; list_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list)        list_only=1; shift ;;
    --pad)         pad="${2:?--pad needs a value}"; shift 2 ;;
    --min-silence) min_silence="${2:?--min-silence needs a value}"; shift 2 ;;
    --min-keep)    min_keep="${2:?--min-keep needs a value}"; shift 2 ;;
    -*)            die "unknown option: $1" ;;
    *)             if [ -z "$in" ]; then in="$1"; else out="$1"; fi; shift ;;
  esac
done
[ -n "$in" ] || die "usage: cut-silence.sh in.mp4 [out.mp4] [--list] [--pad S] [--min-silence S]"
[ -f "$in" ] || die "no such file: $in"
out="${out:-${in%.*}-tight.mp4}"

dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")

# Rotation metadata -> the filter that bakes it into the pixels. Same reasoning
# as prep-upload.sh: some tools honour the display matrix and others drop it,
# and this script re-encodes anyway, so settle it here.
rot=$(ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation \
      -of default=nw=1:nk=1 "$in" 2>/dev/null | head -1)
case "${rot:-0}" in
  -90|270)  rotfilter="transpose=2," ;;
  90|-270)  rotfilter="transpose=1," ;;
  180|-180) rotfilter="transpose=1,transpose=1," ;;
  *)        rotfilter="" ;;
esac

# The threshold follows the clip's own noise floor rather than a fixed dB. Room
# tone differs per recording, and a fixed value either finds no silence in a
# noisy room or eats quiet speech in a treated one.
mean=$(ffmpeg -i "$in" -af volumedetect -f null - 2>&1 \
  | sed -n 's/.*mean_volume: *\(-\?[0-9.]*\).*/\1/p' | head -1)
[ -n "$mean" ] || die "could not read an audio level from $in (does it have an audio track?)"
thresh=$(python3 -c "print(int(min(-18, float('$mean') - 8)))")
echo "noise floor ${mean}dB -> silence below ${thresh}dB for more than ${min_silence}s"

silences=$(ffmpeg -i "$in" -af "silencedetect=noise=${thresh}dB:d=${min_silence}" -f null - 2>&1 \
  | sed -n 's/.*silence_\(start\|end\): *\(-\?[0-9.]*\).*/\1 \2/p')

# Invert the silences into keep ranges, pad each one, then merge any that the
# padding pushed into each other. Padding matters: silencedetect marks the point
# where the level crosses the threshold, which is already a few frames into the
# speaker's first consonant.
ranges=$(printf '%s\n' "$silences" | python3 -c "
import sys
dur, pad, min_keep = float('$dur'), float('$pad'), float('$min_keep')

sil, start = [], None
for line in sys.stdin:
    parts = line.split()
    if len(parts) != 2:
        continue
    kind, t = parts[0], float(parts[1])
    if kind == 'start':
        start = t
    elif start is not None:
        sil.append((start, t))
        start = None
# A clip that fades out at the end leaves a silence_start with no silence_end.
if start is not None:
    sil.append((start, dur))

keep, prev = [], 0.0
for s, e in sil:
    if s > prev:
        keep.append((prev, s))
    prev = e
if dur > prev:
    keep.append((prev, dur))

padded = []
for s, e in keep:
    s, e = max(0.0, s - pad), min(dur, e + pad)
    if padded and s <= padded[-1][1]:
        padded[-1][1] = e
    else:
        padded.append([s, e])

# Sub-second keeps are almost always a cough, a chair creak, or one clipped
# syllable of room noise — cutting to them reads as a stutter.
for s, e in padded:
    if e - s >= min_keep:
        print(f'{s:.3f} {e:.3f}')
")

[ -n "$ranges" ] || die "found nothing to keep — try a longer --min-silence"

printf '%s\n' "$ranges" | python3 -c "
import sys
tc = lambda t: f'{int(t//60):02d}:{t%60:04.1f}'
rows = [tuple(map(float, l.split())) for l in sys.stdin if l.strip()]
kept = sum(e - s for s, e in rows)
dur = float('$dur')
print()
print(f'{len(rows)} segments to keep:')
for i, (s, e) in enumerate(rows, 1):
    print(f'  {i:3d}.  {tc(s)} -> {tc(e)}   ({e-s:5.1f}s)')
print()
print(f'{tc(dur)} in, {tc(kept)} out — {dur-kept:.0f}s of silence removed ({100*(1-kept/dur):.0f}%)')
"

[ "$list_only" -eq 1 ] && { echo; echo "(--list: nothing rendered)"; exit 0; }

# One re-encode straight from the source. select/aselect keep only the chosen
# ranges and the setpts pair closes the gaps, so this is frame-exact — unlike a
# stream copy, which can only cut on keyframes.
expr=$(printf '%s\n' "$ranges" | awk '{printf "%sbetween(t,%s,%s)", (NR>1?"+":""), $1, $2}')
echo
echo "rendering $out ..."
ffmpeg -y -i "$in" \
  -vf "${rotfilter}select='${expr}',setpts=N/FRAME_RATE/TB" \
  -af "aselect='${expr}',asetpts=N/SR/TB" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart -metadata:s:v rotate=0 \
  "$out" -loglevel error
echo "wrote $out ($(( $(stat -c%s "$out") / 1048576 )) MB, $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")s)"
