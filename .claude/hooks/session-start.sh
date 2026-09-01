#!/bin/bash
# Prepares a Claude Code on the web container to author and render the
# HyperFrames video projects under videos/.
#
# Deliberately not `set -e`: one flaky network step should degrade the
# session, not block it from starting.
set -uo pipefail

# Local machines already have their own toolchain — web containers start bare.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Follow whatever the projects pin, so a future upgrade does not strand this hook.
HF_VERSION="$(grep -ho 'hyperframes@[0-9][0-9.]*' "${CLAUDE_PROJECT_DIR:-.}"/videos/*/package.json 2>/dev/null \
  | head -1 | cut -d@ -f2)"
HF_VERSION="${HF_VERSION:-latest}"

log() { echo "[session-start] $*"; }

# 1. FFmpeg — hyperframes cannot encode or probe media without it.
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  log "ffmpeg already present"
else
  log "installing ffmpeg…"
  if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
  # apt-get update first: the shipped package index can be stale enough to 404.
  if $SUDO apt-get update -qq >/dev/null 2>&1 && \
     $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null 2>&1; then
    log "ffmpeg installed"
  else
    log "WARNING: ffmpeg install failed — lint/check still work, render will not"
  fi
fi

# 2. HyperFrames agent skills (/hyperframes, /motion-graphics, /media-use, …).
#    Installed before the session starts, so they are loaded from turn one.
log "syncing HyperFrames skills…"
if npx --yes "hyperframes@${HF_VERSION}" skills update >/dev/null 2>&1; then
  log "skills ready: $(ls ~/.claude/skills 2>/dev/null | grep -c . ) installed"
else
  log "WARNING: skills update failed — run 'npx hyperframes skills update' by hand"
fi

# 3. Warm the pinned CLI and the headless Chrome it renders with, so the
#    first render is not paying for a cold download.
log "warming CLI + headless browser…"
npx --yes "hyperframes@${HF_VERSION}" doctor >/dev/null 2>&1 || true

log "ready — cd videos/<project> && npx hyperframes render"
