#!/bin/bash
# Prepare a video for upload into a Claude Code chat.
#
# The chat upload ceiling sits around 30 MB, and phone footage runs ~1.35 MB per
# second (1080p-class HEVC at ~11 Mbps), so roughly 22 seconds of raw recording
# fills it. This script gets a longer clip under the ceiling.
#
#   ./prep-upload.sh proxy    in.mp4              # whole clip, tiny, for surveying
#   ./prep-upload.sh cut      in.mp4 START END     # lossless extract of one range
#   ./prep-upload.sh compress in.mp4 [target_MB]   # re-encode to fit (default 28)
#   ./prep-upload.sh split    in.mp4 [chunk_MB]    # lossless split when compressing isn't enough
#   ./prep-upload.sh join     part_000.mp4 out.mp4 # rejoin split parts
#
# For anything long, send a proxy first: a 10-minute recording is ~825 MB raw but
# ~25 MB as a proxy, so it fits one upload. Pick the moments off that, then send
# just those ranges with `cut` at full quality.
#
# compress bakes any rotation metadata into the pixels. Phone videos carry a
# display matrix that some tools honour and others drop; leaving it in the
# container is how footage ends up sideways in a render.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
command -v ffmpeg >/dev/null || die "ffmpeg not found"
command -v ffprobe >/dev/null || die "ffprobe not found"

# Rotation metadata -> the filter that bakes it into the pixels.
rotation_filter() {
  local rot
  rot=$(ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation \
        -of default=nw=1:nk=1 "$1" 2>/dev/null | head -1)
  case "${rot:-0}" in
    -90|270) echo "transpose=2" ;;
    90|-270)  echo "transpose=1" ;;
    180|-180) echo "transpose=1,transpose=1" ;;
    *)        echo "" ;;
  esac
}

duration_of() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }

cmd_compress() {
  local in="$1" target_mb="${2:-28}" out dur vf audio_kbps video_kbps
  [ -f "$in" ] || die "no such file: $in"
  out="${in%.*}-upload.mp4"
  dur=$(duration_of "$in")
  [ -n "$dur" ] || die "could not read duration"

  audio_kbps=128
  # Budget 94% of the target so container overhead and rate wobble stay inside it.
  video_kbps=$(python3 -c "
d=float('$dur'); t=float('$target_mb')
print(max(300, int((t*8192*0.94)/d) - $audio_kbps))
")
  vf=$(rotation_filter "$in")
  echo "duration ${dur}s -> video ${video_kbps}k + audio ${audio_kbps}k (target ${target_mb} MB)"
  [ -n "$vf" ] && echo "baking rotation: $vf"

  # Two passes: a single-pass CRF can overshoot a hard size ceiling.
  ffmpeg -y -i "$in" ${vf:+-vf "$vf"} -c:v libx264 -preset medium \
    -b:v "${video_kbps}k" -maxrate "$((video_kbps*3/2))k" -bufsize "$((video_kbps*2))k" \
    -pass 1 -an -f mp4 -metadata:s:v rotate=0 /dev/null -loglevel error
  ffmpeg -y -i "$in" ${vf:+-vf "$vf"} -c:v libx264 -preset medium \
    -b:v "${video_kbps}k" -maxrate "$((video_kbps*3/2))k" -bufsize "$((video_kbps*2))k" \
    -pass 2 -c:a aac -b:a "${audio_kbps}k" -movflags +faststart \
    -metadata:s:v rotate=0 "$out" -loglevel error
  rm -f ffmpeg2pass-0.log ffmpeg2pass-0.log.mbtree

  echo "wrote $out ($(( $(stat -c%s "$out") / 1048576 )) MB)"
}

cmd_proxy() {
  local in="$1" target_mb="${2:-24}" out dur vf kbps
  [ -f "$in" ] || die "no such file: $in"
  out="${in%.*}-proxy.mp4"
  dur=$(duration_of "$in")

  # Audio stays at 128k STEREO on purpose. The video here is only meant to be
  # looked at, but the audio is what speech/pause timing is read from, and a
  # mono downmix at a low rate fills the quiet moments with coding noise —
  # measured on this project's own footage, mono lost 3 of 11 real pauses while
  # 128k stereo kept all 11. Audio is a few MB either way; video absorbs the cut.
  kbps=$(python3 -c "
d=float('$dur'); t=float('$target_mb')
print(max(120, int((t*8192*0.92)/d) - 128))
")
  vf=$(rotation_filter "$in")
  vf="${vf:+$vf,}scale=-2:480"
  echo "proxy: ${dur}s at ${kbps}k video + 128k stereo audio (target ${target_mb} MB)"
  ffmpeg -y -i "$in" -vf "$vf" -c:v libx264 -preset veryfast -b:v "${kbps}k" \
    -maxrate "$((kbps*3/2))k" -bufsize "$((kbps*3))k" -r 15 \
    -c:a aac -b:a 128k -ac 2 -movflags +faststart -metadata:s:v rotate=0 \
    "$out" -loglevel error
  echo "wrote $out ($(( $(stat -c%s "$out") / 1048576 )) MB) — timecodes match the original"
}

cmd_cut() {
  local in="$1" start="$2" end="$3" out="${4:-}"
  [ -f "$in" ] || die "no such file: $in"
  [ -n "${end:-}" ] || die "usage: cut in.mp4 START END [out.mp4]  (e.g. cut clip.mp4 00:03:20 00:04:05)"
  out="${out:-${in%.*}-cut.mp4}"
  # Seek before -i so the copy starts at the nearest keyframe at or before START.
  ffmpeg -y -ss "$start" -to "$end" -i "$in" -c copy -movflags +faststart "$out" -loglevel error
  echo "wrote $out ($(( $(stat -c%s "$out") / 1048576 )) MB, $(duration_of "$out")s)"
  echo "note: -c copy cuts on keyframes, so the start can land up to ~2s early. Re-cut with"
  echo "      compress if you need the range frame-exact."
}

cmd_split() {
  local in="$1" chunk_mb="${2:-28}" dur size chunk_secs base
  [ -f "$in" ] || die "no such file: $in"
  dur=$(duration_of "$in"); size=$(stat -c%s "$in")
  # Split by time, derived from the file's own average byte rate.
  chunk_secs=$(python3 -c "
print(max(1, int(float('$dur') * ($chunk_mb*1048576) / $size)))
")
  base="${in%.*}-part"
  echo "splitting into ~${chunk_secs}s parts (~${chunk_mb} MB each)"
  # -c copy keeps it lossless; cuts land on keyframes so parts vary slightly.
  ffmpeg -y -i "$in" -c copy -map 0 -f segment -segment_time "$chunk_secs" \
    -reset_timestamps 1 "${base}_%03d.mp4" -loglevel error
  ls -la "${base}"_*.mp4 | awk '{printf "%s  %d MB\n", $9, $5/1048576}'
}

cmd_join() {
  local first="$1" out="${2:-joined.mp4}" list
  [ -f "$first" ] || die "no such file: $first"
  list=$(mktemp)
  # Every part matching the first one's stem, in order.
  for f in "${first%_*}"_*.mp4; do printf "file '%s'\n" "$(readlink -f "$f")" >> "$list"; done
  echo "joining $(wc -l < "$list") parts"
  ffmpeg -y -f concat -safe 0 -i "$list" -c copy -movflags +faststart "$out" -loglevel error
  rm -f "$list"
  echo "wrote $out ($(( $(stat -c%s "$out") / 1048576 )) MB, $(duration_of "$out")s)"
}

case "${1:-}" in
  proxy)    shift; cmd_proxy "$@" ;;
  cut)      shift; cmd_cut "$@" ;;
  compress) shift; cmd_compress "$@" ;;
  split)    shift; cmd_split "$@" ;;
  join)     shift; cmd_join "$@" ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
