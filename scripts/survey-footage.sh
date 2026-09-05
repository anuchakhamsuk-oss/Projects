#!/bin/bash
# Map a long recording so you can pick what to cut, without watching all of it.
#
#   ./survey-footage.sh clip.mp4 [outdir]
#
# Writes a timecoded contact sheet plus a talk/pause map. Run it on a proxy —
# it only reads structure, so proxy quality is fine and it stays fast.
set -euo pipefail
in="${1:?usage: survey-footage.sh clip.mp4 [outdir]}"
out="${2:-survey}"
mkdir -p "$out"

dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")
printf 'clip: %s  (%.0fs / %.1f min)\n\n' "$in" "$dur" "$(python3 -c "print($dur/60)")"

# Contact sheet: one frame per interval, labelled with its timecode so a tile
# can be read straight back as a seek point.
interval=$(python3 -c "print(max(2, int($dur/48)))")
ffmpeg -y -i "$in" -vf "fps=1/$interval,scale=200:-2,\
drawtext=text='%{pts\\:hms}':x=4:y=4:fontsize=14:fontcolor=yellow:box=1:boxcolor=black@0.6,\
tile=8x6" "$out/sheet_%02d.jpg" -loglevel error
echo "contact sheet: $out/sheet_*.jpg (one frame per ${interval}s, timecode burned in)"

# Talk/pause map. The threshold follows the clip's own noise floor: a fixed dB
# value finds nothing on a re-encoded proxy, whose coding noise sits well above
# where the original's silence did.
mean=$(ffmpeg -i "$in" -af volumedetect -f null - 2>&1 \
  | sed -n 's/.*mean_volume: *\(-\?[0-9.]*\).*/\1/p' | head -1)
thresh=$(python3 -c "print(int(min(-18, float('$mean') - 8)))")
echo "noise floor ${mean}dB -> pause threshold ${thresh}dB"
echo
echo "talking segments (pauses >0.6s split them):"
ffmpeg -i "$in" -af "silencedetect=noise=${thresh}dB:d=0.6" -f null - 2>&1 \
| awk -v total="$dur" '
  # silence_start: <t>            -> a pause begins, so talking ran up to here
  # silence_end: <t> | silence_duration: <d>  -> talking resumes at $(NF-3)
  /silence_start/ { st=$NF+0; if (st-prev > 1.5) printf "  %6.1fs -> %6.1fs  (%4.1fs talking)\n", prev, st, st-prev }
  /silence_end/   { prev=$(NF-3)+0 }
  END { if (total-prev > 1.5) printf "  %6.1fs -> %6.1fs  (%4.1fs talking)\n", prev, total, total-prev }
' | head -40

# Scene changes catch reframing, walking, a new setup — the visual joins.
echo
echo "scene changes:"
ffmpeg -i "$in" -filter:v "select='gt(scene,0.4)',showinfo" -f null - 2>&1 \
| grep -o 'pts_time:[0-9.]*' | cut -d: -f2 \
| awk '{printf "  %.1fs\n", $1}' | head -20
