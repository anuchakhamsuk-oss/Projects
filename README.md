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

`compress` also bakes rotation metadata into the pixels. Phone videos carry a
display matrix that some tools honour and others silently drop, which is how
footage ends up sideways in a render.

Files too big for chat can also be pushed to this repo directly (GitHub's own
per-file limit is 100 MB) and read from the checkout.
