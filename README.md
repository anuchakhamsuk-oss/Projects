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

## Timing captions without transcription

Thai speech-to-text is not available here, so the words for a caption track have
to come from somewhere else. They already exist: the Content Director artifact
holds the script, per shot. Its editing tab exports a shoot manifest — copy it
into the chat with the footage, and:

```bash
scripts/cut-silence.sh raw.mp4                                  # drop the dead air
scripts/align-script.cjs raw.mp4 --manifest shoot.json --shot 1 # time the known lines
```

`align-script.cjs` does not transcribe. It finds where speech actually sits in
the audio and places the already-written lines against it, so the captions land
on real speech rather than on a guess.

## Viral Radar (TikTok)

Search TikTok by keyword through Scrape Creators, without the browser ever
holding the API key or addressing the provider.

```bash
cp .env.example .env        # then put your key in SCRAPE_CREATORS_API_KEY
set -a; . ./.env; set +a
node scripts/viral-radar/server.cjs
# http://127.0.0.1:8787
```

`.env` is gitignored. The key is read only by `scripts/viral-radar/scrape-creators.cjs`,
the single module that talks to the provider; the page calls
`/api/viral-radar/search` on its own origin and receives a normalized model
(`id`, `platform`, `creator`, `caption`, `thumbnailUrl`, `videoUrl`, `stats`,
`publishedAt`, `durationSec`, `nextCursor`) built field by field — the upstream
body is never passed through.

Bound to `127.0.0.1` deliberately: there is no authentication, so anything that
can reach the port can spend the API quota.

```bash
node --test scripts/viral-radar/test.cjs
```

The tests run on fixtures and an injected fetch — no network, no key. They cover
the data model, that the key never reaches a response (even when a fake upstream
reflects it back), that invalid input costs no upstream call, and that only one
module reads the key.

The provider's live endpoint could not be reached from the environment this was
written in, so the response mapping is a set of candidate field paths rather
than one fixed shape. If real data disagrees, point `VIRAL_RADAR_FIELD_MAP` at a
JSON file naming just the fields that are wrong — see `.env.example`.
