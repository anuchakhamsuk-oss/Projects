'use strict';
/**
 * Upstream response -> the one data model the UI is written against.
 *
 * The provider's exact field names could not be confirmed while this was built
 * (their API and docs are both unreachable from the authoring environment), so
 * every field is read through a LIST of candidate paths rather than one. The
 * first path that yields a value wins. Two families are covered: TikTok's own
 * wire names (aweme_id, statistics.digg_count, author.unique_id …) and the
 * plainer names a wrapper usually exposes (id, likes, handle …).
 *
 * When real data disagrees, fix it in config, not here: point
 * VIRAL_RADAR_FIELD_MAP at a JSON file naming only the fields that are wrong.
 */

const fs = require('fs');
const path = require('path');

/** Default candidate paths, most-specific first. */
const FIELD_MAP = {
  // Where the array of results lives in the response body.
  items: ['aweme_list', 'search_item_list', 'videos', 'items', 'results', 'data.videos', 'data.items', 'data'],
  // The pagination token to send back as `cursor`.
  cursor: ['max_cursor', 'next_cursor', 'nextCursor', 'cursor', 'data.max_cursor', 'data.cursor', 'pagination.next_cursor'],
  // Some shapes wrap each row (e.g. {aweme_info: {...}}); unwrap before reading.
  itemRoot: ['aweme_info', 'item', 'video_info'],

  id: ['aweme_id', 'id', 'video_id', 'item_id'],
  caption: ['desc', 'caption', 'title', 'description', 'text'],
  creatorHandle: ['author.unique_id', 'author.uniqueId', 'author.handle', 'author.username', 'creator.handle', 'creator.username', 'unique_id', 'username'],
  creatorName: ['author.nickname', 'author.nickName', 'author.name', 'creator.name', 'creator.nickname', 'nickname'],
  thumbnailUrl: ['video.cover.url_list', 'video.cover', 'video.origin_cover.url_list', 'cover', 'thumbnail', 'thumbnail_url', 'thumbnailUrl', 'image_url'],
  videoUrl: ['share_url', 'url', 'video_url', 'videoUrl', 'link', 'web_video_url'],
  views: ['statistics.play_count', 'stats.playCount', 'play_count', 'views', 'view_count', 'viewCount'],
  likes: ['statistics.digg_count', 'stats.diggCount', 'digg_count', 'likes', 'like_count', 'likeCount'],
  comments: ['statistics.comment_count', 'stats.commentCount', 'comment_count', 'comments', 'commentCount'],
  shares: ['statistics.share_count', 'stats.shareCount', 'share_count', 'shares', 'shareCount'],
  publishedAt: ['create_time', 'createTime', 'created_at', 'published_at', 'publishedAt', 'timestamp'],
  duration: ['video.duration', 'duration', 'video_duration', 'durationMs'],
};

/** Merge a user-supplied map over the defaults. Only named fields are replaced. */
function loadFieldMap(env = process.env, readFile = fs.readFileSync){
  const file = env.VIRAL_RADAR_FIELD_MAP;
  if(!file) return FIELD_MAP;
  const resolved = path.resolve(file);
  const override = JSON.parse(readFile(resolved, 'utf8'));
  const merged = Object.assign({}, FIELD_MAP);
  for(const [key, value] of Object.entries(override)){
    if(!Array.isArray(value)) throw new Error(`field map "${key}" must be an array of paths`);
    merged[key] = value;
  }
  return merged;
}

function getPath(obj, dotted){
  let cur = obj;
  for(const part of dotted.split('.')){
    if(cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** First candidate path that yields something meaningful. */
function pick(obj, paths){
  if(!obj) return undefined;
  for(const p of paths || []){
    const v = getPath(obj, p);
    if(v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Covers `"https://…"`, `["https://…", …]` and `{url_list: [...]}`. */
function firstUrl(value){
  if(typeof value === 'string') return value;
  if(Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  if(value && typeof value === 'object'){
    if(Array.isArray(value.url_list)) return value.url_list[0];
    if(typeof value.url === 'string') return value.url;
  }
  return undefined;
}

function toInt(value){
  if(typeof value === 'number' && isFinite(value)) return Math.round(value);
  if(typeof value === 'string'){
    const n = Number(value.replace(/[, ]/g, ''));
    if(isFinite(n)) return Math.round(n);
  }
  return 0;
}

/**
 * Unix seconds, unix milliseconds and ISO strings all appear in the wild. Tell
 * seconds from milliseconds by magnitude: a seconds-based timestamp for any
 * plausible video is ~1e9, a millisecond one ~1e12.
 */
function toIso(value){
  if(value == null || value === '') return null;
  if(typeof value === 'number' || /^\d+$/.test(String(value))){
    const n = Number(value);
    const ms = n > 1e11 ? n : n * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Same magnitude trick: a clip is seconds, not 15000 of them. */
function toSeconds(value){
  const n = toInt(value);
  if(n <= 0) return 0;
  return n > 1000 ? Math.round(n / 1000) : n;
}

/** Locate the results array without assuming one wrapper shape. */
function extractItems(body, map){
  const found = pick(body, map.items);
  if(Array.isArray(found)) return found;
  // A bare array response is legal too.
  if(Array.isArray(body)) return body;
  return [];
}

function normalizeItem(raw, map){
  // Unwrap a row container like {aweme_info: {...}} when present.
  const inner = pick(raw, map.itemRoot);
  const item = inner && typeof inner === 'object' ? inner : raw;

  const id = pick(item, map.id);
  const videoUrl = firstUrl(pick(item, map.videoUrl)) || null;
  const handle = pick(item, map.creatorHandle) || null;

  return {
    id: id != null ? String(id) : null,
    platform: 'tiktok',
    creator: {
      handle: handle != null ? String(handle) : null,
      name: pick(item, map.creatorName) != null ? String(pick(item, map.creatorName)) : null,
    },
    caption: pick(item, map.caption) != null ? String(pick(item, map.caption)) : '',
    thumbnailUrl: firstUrl(pick(item, map.thumbnailUrl)) || null,
    // Fall back to the canonical public URL when the row omits a link.
    videoUrl: videoUrl || (handle && id ? `https://www.tiktok.com/@${handle}/video/${id}` : null),
    stats: {
      views: toInt(pick(item, map.views)),
      likes: toInt(pick(item, map.likes)),
      comments: toInt(pick(item, map.comments)),
      shares: toInt(pick(item, map.shares)),
    },
    publishedAt: toIso(pick(item, map.publishedAt)),
    durationSec: toSeconds(pick(item, map.duration)),
  };
}

/**
 * Build the response the UI consumes. Nothing from the upstream body is spread
 * into the result — every field is copied out by name — so an upstream change
 * cannot push unexpected data (or anything sensitive) through to the client.
 */
function normalizeSearchResponse(body, opts = {}){
  const map = opts.fieldMap || FIELD_MAP;
  const limit = opts.limit;

  const rows = extractItems(body, map);
  let items = rows
    .filter(r => r && typeof r === 'object')
    .map(r => normalizeItem(r, map))
    // A row with neither an id nor a link cannot be opened or de-duplicated.
    .filter(it => it.id || it.videoUrl);

  if(typeof limit === 'number' && limit > 0) items = items.slice(0, limit);

  const rawCursor = pick(body, map.cursor);
  const nextCursor = rawCursor == null || rawCursor === '' ? null : String(rawCursor);

  return { items, nextCursor };
}

module.exports = {
  FIELD_MAP,
  loadFieldMap,
  normalizeSearchResponse,
  normalizeItem,
  // exported for tests
  _internal: { pick, firstUrl, toInt, toIso, toSeconds, extractItems },
};
