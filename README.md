# Projects

HyperFrames video compositions under `videos/`. Each project renders an MP4 from
an HTML composition — see that project's `CLAUDE.md` for its own notes.

## Getting footage in

Chat uploads cap out around 30 MB. Phone footage runs ~1.35 MB per second
(1080p-class HEVC at ~11 Mbps), so about 22 seconds of raw recording fills that.
For anything longer, `scripts/prep-upload.sh` shrinks or splits it first:

```bash
scripts/prep-upload.sh compress clip.mp4        # re-encode to fit under 28 MB
scripts/prep-upload.sh compress clip.mp4 15     # ...or a size you pick
scripts/prep-upload.sh split    clip.mp4        # lossless split when compressing isn't enough
scripts/prep-upload.sh join     clip-part_000.mp4 whole.mp4
```

For anything past a couple of minutes, don't try to fit the whole thing. Send a
proxy, pick the moments off it, then send only those ranges at full quality:

```bash
scripts/prep-upload.sh proxy clip.mp4                  # ~25 MB whole-clip preview
scripts/survey-footage.sh    clip-proxy.mp4            # contact sheet + talk/pause map
scripts/prep-upload.sh cut   clip.mp4 00:03:20 00:04:05
```

The proxy keeps the original's timecodes, so anything you read off it — or off
the survey — seeks correctly in the source.

## Cutting silence out

`scripts/cut-silence.sh` drops the dead air from a talking recording. Run it on
the original rather than a proxy; it re-encodes once from the source, so nothing
has to be uploaded at all:

```bash
scripts/cut-silence.sh clip.mp4                 # write clip-tight.mp4
scripts/cut-silence.sh clip.mp4 --list          # just the timecodes, render nothing
scripts/cut-silence.sh clip.mp4 --pad 0.25      # leave more air around each take
scripts/cut-silence.sh clip.mp4 --min-silence 1.0
```

`--list` prints the keep ranges as `mm:ss.s`, which is what you type into
CapCut or Premiere when the cutting has to happen in an editor instead.

`compress` also bakes rotation metadata into the pixels. Phone videos carry a
display matrix that some tools honour and others silently drop, which is how
footage ends up sideways in a render.

Files too big for chat can also be pushed to this repo directly (GitHub's own
per-file limit is 100 MB) and read from the checkout.
