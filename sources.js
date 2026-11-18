// Data layer for the BT search panel.
//
// The Web page can only reach endpoints that answer with CORS headers, so every
// upstream request runs here in the Host process and the page receives the
// normalized result through the plugin's own same-origin route.
//
// Two sources:
//   * animes — Anime Garden public API (dmhy / Mikan / Moe / ANi aggregate)
//   * clm    — 磁力猫 (cilimao.app v3.0), mirrored on clm17.vip and clm9.in
//
// 磁力猫 notes, verified against the live site:
//   * search: GET /search?word=<base64(keyword)>&sort=time&p=<page>, 12 items per page
//   * the site sits behind a click gate: POST the same URL with `act=challenge`
//     answers {"code":1} and the session cookie then passes
//   * the list links to /information/<32-char id>, and that id is the base32
//     encoding of the info hash — so one list request yields every magnet link

const ANIMES_API = 'https://api.animes.garden/resources';
const CLM_HOSTS = ['clm17.vip', 'clm9.in'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SOURCE_TIMEOUT_MS = 9000;
const CACHE_TTL_MS = 60 * 1000;
const CACHE_LIMIT = 40;
const TYPES = ['动画', '漫画', '音乐', '日剧', 'RAW', '合集', '特摄', '游戏'];

export const SOURCE_IDS = ['animes', 'clm'];

const cache = new Map();
const clm = { host: null, cookie: '' };

const ITEM_RE =
  /href="\/information\/([a-z0-9]{32})"[^>]*class="SearchListTitle_result_title">([\s\S]*?)<\/a>[\s\S]*?<div class="Search_list_info">([\s\S]*?)<\/div>/g;
const SIZE_RE = /文件大小：\s*([\d.]+\s*[KMGTP]?B)/;
const DATE_RE = /创建时间：\s*(\d{4}-\d{2}-\d{2})/;
const FORMAT_RE = /文件格式：\s*(\.\w+)/;
const FILES_RE = /Search_result_type[^>]*>\s*(?:<i[^>]*>\s*<\/i>)?\s*(\d+)/;

// 磁力猫是 12 条/页的服务端分页站点：总数在「找到…相关结果N个」里，
// 尾页链接实测指向 p=80，即一次搜索最多可翻 80 页 / 960 条。
const CLM_PAGE_SIZE = 12;
const CLM_DEFAULT_PAGES = 5;            // 旧参数 pages 的默认值（向后兼容）
const CLM_MAX_PAGES_PER_REQUEST = 10;
const CLM_MAX_PAGE = 80;
const CLM_PARALLEL = 4;                 // 第 1 页之后的并发数（第 1 页要串行过门）
const CLM_TOTAL_RE = /相关结果\s*(\d+)\s*个/;
const CLM_DEFAULT_LIMIT = 20;           // 每页条数（新参数 limit）默认值
const CLM_MAX_LIMIT = CLM_MAX_PAGES_PER_REQUEST * CLM_PAGE_SIZE;  // 单次最多返回 120 条
// 站点排序参数：time=时间、length=文件大小；名称没有服务端排序，由前端页内排
const CLM_SORT_MAP = { date: 'time', size: 'length', name: 'time' };

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cachePut(key, value) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '');
}

function decodeEntities(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', hellip: '…', middot: '·',
  };
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const num = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : match;
    }
    const hit = named[code.toLowerCase()];
    return hit === undefined ? match : hit;
  });
}

function textOf(html) {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

export function fmtSize(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
}

function parseSize(text) {
  const m = /([\d.]+)\s*([KMGTP]?B)/i.exec(String(text || ''));
  if (!m) return null;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 };
  return Math.round(parseFloat(m[1]) * (mult[m[2].toUpperCase()] || 1));
}

function guessType(title) {
  const t = String(title || '').toLowerCase();
  if (TYPES.includes(title)) return title;
  const videoish = /1080p|720p|2160p|4k|s\d{2}e\d{2}|\.mp4|\.mkv|\.iso|blu-?ray|bdrip|web-?rip|remux/.test(t);
  if (/漫画|comic|manga/.test(t)) return '漫画';
  if (/音乐|flac|mp3|ost|album/.test(t)) return '音乐';
  if (/合集|batch|complete|全集/.test(t)) return '合集';
  if (/日剧|真人|drama/.test(t)) return '日剧';
  if (/\braw\b/.test(t)) return 'RAW';
  if (/特摄|ultraman|rider/.test(t)) return '特摄';
  // 「Game of Thrones」这类片名不能被判成游戏：有视频信号时按视频算。
  if (/游戏|switch/.test(t) || (/\bgame\b/.test(t) && !videoish)) return '游戏';
  if (/动画|anime|bdrip|webrip|1080p|720p|2160p|\.mp4|\.mkv/.test(t)) return '动画';
  return '其他';
}

function magnetOf(infoHash, name) {
  if (!infoHash) return null;
  const base = 'magnet:?xt=urn:btih:' + infoHash;
  return name ? base + '&dn=' + encodeURIComponent(name) : base;
}

function infoHashOf(magnet) {
  const m = /btih:([0-9a-zA-Z]+)/.exec(String(magnet || ''));
  return m ? m[1].toLowerCase() : null;
}

// 32 base32 characters decode to the 20-byte info hash.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32ToHex(token) {
  if (!/^[a-z0-9]{32}$/.test(String(token || ''))) return null;
  let bits = '';
  for (const ch of token.toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null;
    bits += idx.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0');
  }
  return hex.length === 40 ? hex.toLowerCase() : null;
}

// Tokens that describe the encode rather than the work: broad mode must not
// search for "2160p" alone just because it is the longest word in the query.
const GENERIC_TOKEN =
  /^(?:\d{3,4}[pi]|\d{3,4}x\d{3,4}|x26[45]|h26[45]|hevc|avc|10bit|8bit|4k|uhd|web|webrip|web-dl|bluray|blu-ray|bdrip|dvdrip|hdrip|remux|hdr|hdr10|\bdv\b|dolby|ddp?|aac|ac3|dts|flac|truehd|atmos|iso|mkv|mp4|avi|m2ts|chd|yts|internal|proper|repack|v\d)$/i;

export function broadKeyword(q) {
  const text = String(q || '').trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return text;
  const useful = tokens.filter((t) => !GENERIC_TOKEN.test(t) && !/^\d+$/.test(t));
  if (!useful.length) return text;
  return useful.reduce((a, b) => (b.length > a.length ? b : a), useful[0]);
}

// ---------------------------------------------------------------------------
// Anime Garden
// ---------------------------------------------------------------------------

export async function searchAnimeGarden(q, type) {
  let url = ANIMES_API + '?search=' + encodeURIComponent(q) + '&limit=50';
  if (type) url += '&types=' + encodeURIComponent(type);
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const data = await response.json();
  const rows = (data && data.resources) || [];
  return rows.map((r) => ({
    id: 'animes:' + (r.id == null ? r.title : r.id),
    title: r.title || '',
    source: 'animes',
    type: r.type || '其他',
    size: typeof r.size === 'number' ? r.size : null,
    createdAt: r.createdAt || null,
    magnet: r.magnet || null,
    torrent: r.torrent || null,
    href: r.href || null,
    publisher: (r.publisher && r.publisher.name) || '',
    seeders: null,
    leechers: null,
    infoHash: infoHashOf(r.magnet),
    fileCount: null,
    format: null,
  }));
}

// ---------------------------------------------------------------------------
// 磁力猫 (cilimao v3.0)
// ---------------------------------------------------------------------------

function rememberCookie(list) {
  for (const raw of list || []) {
    const pair = String(raw).split(';')[0].trim();
    if (!pair) continue;
    if (/^server_name_session=/i.test(pair)) {
      clm.cookie = pair;
      return;
    }
    if (!clm.cookie) clm.cookie = pair;
  }
}

async function clmRequest(url, init) {
  const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (clm.cookie) headers.Cookie = clm.cookie;
  if (init && init.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(url, {
    method: (init && init.method) || 'GET',
    body: init && init.body,
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  const jar = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  rememberCookie(jar);
  const body = await response.text();
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return body;
}

async function clmPassGate(url) {
  const body = await clmRequest(url, { method: 'POST', body: 'act=challenge' });
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('验证返回非 JSON：' + body.slice(0, 80));
  }
  if (Number(parsed && parsed.code) !== 1) {
    throw new Error('验证未通过：' + body.slice(0, 80));
  }
}

async function clmFetch(path) {
  const hosts = (clm.host ? [clm.host] : []).concat(CLM_HOSTS.filter((h) => h !== clm.host));
  let lastError = null;
  for (const host of hosts) {
    try {
      const url = 'https://' + host + path;
      let html = await clmRequest(url);
      if (html.includes('challenge-c')) {
        await clmPassGate(url);
        html = await clmRequest(url);
      }
      if (html.includes('challenge-c')) throw new Error('验证未通过');
      clm.host = host;
      return { host, html };
    } catch (error) {
      lastError = error;
      clm.cookie = '';
    }
  }
  throw new Error('磁力猫镜像均不可用：' + (lastError && lastError.message ? lastError.message : lastError));
}

function msgOf(error) {
  return error && error.message ? error.message : String(error);
}

// 并发上限 map：第 1 页之后的磁力猫页面并行抓取，避免一页页串行等待。
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  };
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, () => worker()));
  return out;
}

function clmTotalOf(html) {
  const m = CLM_TOTAL_RE.exec(html);
  return m ? Number(m[1]) : null;
}

function clmMaxPageOf(html) {
  const hrefRe = /href="([^"]*?\/search\?[^"]*?)"/g;
  const pRe = /[?&](?:amp;)?p=(\d+)/g;
  let max = 0;
  let href = hrefRe.exec(html);
  while (href) {
    pRe.lastIndex = 0;
    let p = pRe.exec(href[1]);
    while (p) {
      const n = Number(p[1]);
      if (Number.isFinite(n) && n > max) max = n;
      p = pRe.exec(href[1]);
    }
    href = hrefRe.exec(html);
  }
  return max ? Math.min(CLM_MAX_PAGE, max) : null;
}

function parseClmPage(html, host) {
  const results = [];
  // ITEM_RE 带 /g 且有共享 lastIndex，多页解析时重建实例避免互相干扰。
  const re = new RegExp(ITEM_RE.source, ITEM_RE.flags);
  let m = re.exec(html);
  while (m) {
    const id = m[1];
    const title = textOf(m[2]);
    const rawInfo = m[3];
    const info = textOf(rawInfo);
    const infoHash = base32ToHex(id);
    const size = SIZE_RE.exec(info);
    const date = DATE_RE.exec(info);
    const format = FORMAT_RE.exec(info);
    const files = FILES_RE.exec(rawInfo);
    if (title) {
      results.push({
        id: 'clm:' + id,
        title,
        source: 'clm',
        type: guessType(title),
        size: size ? parseSize(size[1]) : null,
        createdAt: date ? date[1] + 'T00:00:00Z' : null,
        magnet: magnetOf(infoHash, title),
        torrent: null,
        href: 'https://' + host + '/information/' + id,
        publisher: '',
        seeders: null,
        leechers: null,
        infoHash,
        fileCount: files ? Number(files[1]) : null,
        format: format ? format[1] : null,
      });
    }
    m = re.exec(html);
  }
  return { items: results, total: clmTotalOf(html), maxPage: clmMaxPageOf(html) };
}

// 按 offset/limit 取窗口：把「第几条」换算成站点页码，只抓需要的站点页再切片。
// 第 1 页必须串行（顺带过验证门、拿总数/页码上限），其余页最多 4 路并发；
// 单页失败记进 pageErrors，不影响窗口里其它页。
export async function searchClmWindow(q, mode = 'broad', offset = 0, limit = CLM_DEFAULT_LIMIT, sort = 'date') {
  const keyword = mode === 'broad' ? broadKeyword(q) : String(q || '').trim();
  if (!keyword) {
    return { items: [], total: null, maxPage: null, offset: 0, limit, page: 1, pages: 0,
      pageErrors: ['没有可用的搜索词'] };
  }
  const word = encodeURIComponent(Buffer.from(keyword, 'utf8').toString('base64'));
  const siteSort = CLM_SORT_MAP[sort] || 'time';
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Math.min(CLM_MAX_LIMIT, Number(limit) || CLM_DEFAULT_LIMIT));
  let start = Math.floor(off / CLM_PAGE_SIZE) + 1;
  let end = Math.floor((off + lim - 1) / CLM_PAGE_SIZE) + 1;
  start = Math.max(1, Math.min(CLM_MAX_PAGE, start));
  end = Math.max(start, Math.min(CLM_MAX_PAGE, end));
  if (end - start + 1 > CLM_MAX_PAGES_PER_REQUEST) {
    end = start + CLM_MAX_PAGES_PER_REQUEST - 1;
  }

  const urlOf = (p) => '/search?word=' + word + '&sort=' + siteSort + '&p=' + p;

  const head = await clmFetch(urlOf(start));
  const first = parseClmPage(head.html, head.host);

  let last = end;
  if (first.maxPage) last = Math.min(last, first.maxPage);
  const wanted = [];
  for (let p = start + 1; p <= last; p += 1) wanted.push(p);

  const pageErrors = [];
  const chunks = [first.items];
  if (wanted.length) {
    const got = await mapLimit(wanted, CLM_PARALLEL, async (p) => {
      try {
        const res = await clmFetch(urlOf(p));
        return { p, items: parseClmPage(res.html, res.host).items };
      } catch (error) {
        return { p, error };
      }
    });
    for (const entry of got) {
      if (entry.error) pageErrors.push('第 ' + entry.p + ' 页获取失败：' + msgOf(entry.error));
      else chunks.push(entry.items);
    }
  }

  const items = [];
  for (const chunk of chunks) items.push(...chunk);

  const skip = Math.max(0, off - (start - 1) * CLM_PAGE_SIZE);
  return {
    items: items.slice(skip, skip + lim),
    total: first.total,
    maxPage: first.maxPage,
    offset: off,
    limit: lim,
    page: start,
    pages: end - start + 1,
    pageErrors,
  };
}

// 旧接口兼容：page/pages（1 基站点页，12 条/页）换算成 offset/limit 再取窗口。
export async function searchClm(q, mode = 'broad', page = 1, pages = 1) {
  const start = Math.max(1, Math.min(CLM_MAX_PAGE, Number(page) || 1));
  const count = Math.max(1, Math.min(CLM_MAX_PAGES_PER_REQUEST, Number(pages) || 1));
  return searchClmWindow(q, mode, (start - 1) * CLM_PAGE_SIZE, count * CLM_PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

function runSource(name, q, type, mode, offset, limit, sort) {
  if (name === 'animes') return searchAnimeGarden(q, type);
  if (name === 'clm') return searchClmWindow(q, mode, offset, limit, sort);
  throw new Error('未知来源 ' + name);
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const row of list) {
    // 两个来源的 info hash 大小写不同，去重键必须归一化，否则同一种子会出现两次。
    const hash = row.infoHash ? String(row.infoHash).toLowerCase() : '';
    const key = hash || (String(row.title || '').toLowerCase() + '|' + row.size);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export async function searchAll({ q, source = 'all', type = '', mode = 'broad', offset, limit, sort = 'date', page, pages }) {
  const keyword = String(q || '').trim().slice(0, 200);
  if (!keyword) {
    return { results: [], errors: [{ source: source || 'all', message: '请输入搜索关键词' }] };
  }
  const sortId = Object.prototype.hasOwnProperty.call(CLM_SORT_MAP, sort) ? sort : 'date';
  let names;
  if (source === 'all') {
    names = SOURCE_IDS.slice();
  } else if (SOURCE_IDS.includes(source)) {
    names = [source];
  } else {
    return { results: [], errors: [{ source, message: '未知来源' }] };
  }

  // 旧调用方用 page/pages（1 基站点页 = 12 条/页）；新调用方用 offset/limit（条数窗口）。
  const legacy = offset == null && limit == null && (page != null || pages != null);
  let off;
  let lim;
  if (legacy) {
    const pageNo = Math.max(1, Math.min(CLM_MAX_PAGE, Number(page) || 1));
    const pageCount = Math.max(1, Math.min(CLM_MAX_PAGES_PER_REQUEST, Number(pages) || CLM_DEFAULT_PAGES));
    off = (pageNo - 1) * CLM_PAGE_SIZE;
    lim = pageCount * CLM_PAGE_SIZE;
    // 老语义：翻页只对磁力猫有意义，第 2 页起不再重复请求动漫花园
    if (source === 'all' && pageNo > 1) names = ['clm'];
  } else {
    off = Math.max(0, Number(offset) || 0);
    lim = Math.max(1, Math.min(CLM_MAX_LIMIT, Number(limit) || CLM_DEFAULT_LIMIT));
  }

  const cacheKey = [source, keyword, type, mode, sortId, off, lim].join('|');
  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  const settled = await Promise.allSettled(
    names.map((name) => runSource(name, keyword, type, mode, off, lim, sortId)),
  );
  const results = [];
  const errors = [];
  let total = null;
  let maxPage = null;
  let clmPage = null;
  let clmPages = null;
  settled.forEach((outcome, i) => {
    const name = names[i];
    if (outcome.status === 'rejected') {
      const reason = outcome.reason;
      errors.push({
        source: name,
        message: reason && reason.message ? reason.message : String(reason),
      });
      return;
    }
    const value = outcome.value;
    if (name === 'clm') {
      results.push(...((value && value.items) || []));
      total = value && value.total != null ? value.total : null;
      maxPage = value && value.maxPage != null ? value.maxPage : null;
      clmPage = value && value.page != null ? value.page : null;
      clmPages = value && value.pages != null ? value.pages : null;
      for (const message of (value && value.pageErrors) || []) {
        errors.push({ source: 'clm', message });
      }
      return;
    }
    results.push(...(value || []));
  });

  let rows = results;
  if (type) rows = rows.filter((row) => row.type === type);
  if (mode === 'precise') {
    const tokens = keyword.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length) {
      rows = rows.filter((row) => {
        const title = String(row.title || '').toLowerCase();
        return tokens.every((token) => title.includes(token));
      });
    }
  }

  const payload = {
    results: dedupe(rows), errors, total, maxPage,
    offset: off, limit: lim, returned: rows.length,
    page: clmPage, pages: clmPages,
  };
  cachePut(cacheKey, payload);
  return payload;
}
