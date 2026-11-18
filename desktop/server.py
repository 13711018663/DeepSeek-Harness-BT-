#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BT搜索本地聚合服务。

只依赖 Python 标准库：
  * 在 127.0.0.1 上提供静态页面（index.html）
  * 提供 /api/search 聚合多个 BT 资源数据源

服务端抓取上游，因此不受浏览器跨域限制。只监听回环地址，不对外暴露。
"""

import base64
import http.cookiejar
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
import webbrowser
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from html import unescape as html_unescape

# 冻结（PyInstaller）时资源从 _MEIPASS 读取，日志写到 exe 同目录；开发态用脚本同目录
_IS_FROZEN = bool(getattr(sys, 'frozen', False))
if _IS_FROZEN:
    ROOT = getattr(sys, '_MEIPASS', '')
    _EXE_DIR = os.path.dirname(os.path.abspath(sys.executable))
    LOG_FILE = os.path.join(_EXE_DIR, 'error.log')
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
    LOG_FILE = os.path.join(ROOT, 'error.log')
INDEX_FILE = os.path.join(ROOT, 'index.html')
TIMEOUT = 8
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

TYPE_ENUM = ['动画', '漫画', '音乐', '日剧', 'RAW', '合集', '特摄', '游戏', '其他']

# 心跳：页面每 5s ping 一次；浏览器关闭后一段时间自动退出，避免留下隐藏常驻进程
_PING_STATE = {'seen': False, 'last': time.time()}
_PING_TIMEOUT = 90

# 进程内结果缓存：(source,q,typ,mode) -> (expire_ts, payload)
_CACHE = {}
_CACHE_TTL = 120
_CACHE_LOCK = threading.Lock()


def cache_get(key):
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
        if hit:
            _CACHE.pop(key, None)
        return None


def cache_put(key, payload):
    with _CACHE_LOCK:
        _CACHE[key] = (time.time() + _CACHE_TTL, payload)


def fatal(msg):
    """致命错误：写日志并弹窗（windowed 模式下无控制台），然后退出。"""
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as fh:
            fh.write('%s  %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg))
    except OSError:
        pass
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, msg, 'BT搜索', 0x10)  # MB_ICONERROR
    except Exception:
        pass
    os._exit(1)


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------

def fetch(url, headers=None, prefer_curl=False):
    """抓取 URL，返回 bytes。超时/HTTP 错误会抛异常。

    默认先用 urllib；TLS 握手失败（部分站点对 Python 的 OpenSSL 指纹不友好）时，
    若系统有 curl.exe 则回退到 curl。prefer_curl=True 时直接走 curl，
    用于已知 urllib 必然失败的主机（如 BTDig），省掉一次无用超时。
    """
    hdrs = {'User-Agent': USER_AGENT, 'Accept': '*/*'}
    if headers:
        hdrs.update(headers)
    if prefer_curl:
        return _curl_fetch(url, hdrs)
    req = urllib.request.Request(url, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.read()
    except urllib.error.URLError as exc:
        if 'handshake' not in str(exc).lower() and 'ssl' not in str(exc).lower():
            raise
        return _curl_fetch(url, hdrs)


def _curl_fetch(url, hdrs):
    curl = shutil.which('curl.exe') or shutil.which('curl')
    if not curl:
        raise RuntimeError('TLS 握手失败，且系统未提供 curl 回退')
    cmd = [curl, '-s', '-L', '--max-time', str(TIMEOUT), '-A', hdrs['User-Agent']]
    for k, v in hdrs.items():
        if k.lower() == 'user-agent':
            continue
        cmd += ['-H', '%s: %s' % (k, v)]
    cmd.append(url)
    kwargs = {}
    if os.name == 'nt':
        # 窗口化应用（无控制台）spawn console 程序时，必须显式隐藏，
        # 否则每次搜索都会弹出一个命令提示符窗口。
        kwargs['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0x08000000)
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = subprocess.SW_HIDE
        kwargs['startupinfo'] = si
    proc = subprocess.run(cmd, capture_output=True, timeout=TIMEOUT + 5,
                          check=False, **kwargs)
    if proc.returncode != 0:
        raise RuntimeError('curl 抓取失败（exit %d）' % proc.returncode)
    return proc.stdout


def fetch_json(url):
    return json.loads(fetch(url).decode('utf-8', 'ignore'))


def magnet_of(info_hash, name=''):
    if not info_hash:
        return None
    m = 'magnet:?xt=urn:btih:' + str(info_hash)
    if name:
        m += '&dn=' + urllib.parse.quote(str(name))
    return m


def item(source, title, **kw):
    """构造统一结果条目。"""
    return {
        'id': kw.get('id') or (source + ':' + str(abs(hash(title)) & 0xFFFFFFFF)),
        'title': (title or '').strip(),
        'source': source,
        'type': kw.get('type') or '其他',
        'size': kw.get('size') if isinstance(kw.get('size'), int) else _int_or_none(kw.get('size')),
        'createdAt': kw.get('createdAt'),
        'magnet': kw.get('magnet'),
        'torrent': kw.get('torrent'),
        'href': kw.get('href'),
        'seeders': kw.get('seeders'),
        'leechers': kw.get('leechers'),
        'publisher': kw.get('publisher') or '',
        'infoHash': kw.get('infoHash'),
        'fileCount': kw.get('fileCount'),
        'format': kw.get('format'),
    }


def _int_or_none(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _iso_from_unix(v):
    n = _int_or_none(v)
    if not n:
        return None
    try:
        return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(n))
    except (OverflowError, OSError, ValueError):
        return None


# --------------------------------------------------------------------------
# 各数据源适配器
# --------------------------------------------------------------------------

def src_animes(q, typ, page, mode='broad'):
    # 精确/广泛统一用 search 取回候选，再由 search() 的通用后置过滤做 AND（精准）
    url = ('https://api.animes.garden/resources?search=%s&limit=50&page=%d'
           % (urllib.parse.quote(q), page))
    if typ:
        url += '&types=' + urllib.parse.quote(typ)
    data = fetch_json(url)
    out = []
    for r in data.get('resources') or []:
        pub = r.get('publisher') or {}
        out.append(item(
            'animes', r.get('title'),
            id='animes:' + str(r.get('id')),
            type=r.get('type') or '其他',
            size=r.get('size'),
            createdAt=r.get('createdAt'),
            magnet=r.get('magnet'),
            href=r.get('href'),
            publisher=pub.get('name') or '',
            infoHash=_info_hash_of(r.get('magnet')),
        ))
    return out


def src_tpb(q, typ, page, mode='broad'):
    url = 'https://apibay.org/q.php?q=%s&cat=0' % urllib.parse.quote(q)
    data = fetch_json(url)
    if not isinstance(data, list):
        return []
    out = []
    for r in data:
        if str(r.get('id')) == '0':
            continue  # 无结果占位
        name = r.get('name') or ''
        info_hash = r.get('info_hash') or ''
        out.append(item(
            'tpb', name,
            id='tpb:' + str(r.get('id')),
            type=_tpb_type(r.get('category')),
            size=r.get('size'),
            createdAt=_iso_from_unix(r.get('added')),
            magnet=magnet_of(info_hash, name),
            href='https://thepiratebay.org/description.php?id=' + str(r.get('id')),
            seeders=_int_or_none(r.get('seeders')),
            leechers=_int_or_none(r.get('leechers')),
            publisher=r.get('username') or '',
            infoHash=info_hash,
        ))
    return out


def src_nyaa(q, typ, page, mode='broad'):
    url = 'https://nyaa.si/?page=rss&q=%s&c=0_0&f=0' % urllib.parse.quote(q)
    raw = fetch(url).decode('utf-8', 'ignore')
    root = ET.fromstring(raw)
    ns = '{https://nyaa.si/xmlns/nyaa}'
    out = []
    for el in root.iter('item'):
        title = el.findtext('title') or ''
        guid = el.findtext('guid') or ''
        hash_v = el.findtext(ns + 'infoHash') or ''
        cat = el.findtext(ns + 'categoryId') or ''
        out.append(item(
            'nyaa', title,
            id='nyaa:' + (guid.rsplit('/', 1)[-1] or title),
            type=_nyaa_type(cat),
            createdAt=_rfc822_to_iso(el.findtext('pubDate')),
            magnet=magnet_of(hash_v, title) if hash_v else None,
            torrent=(el.findtext('link') or None),
            href=guid or None,
            seeders=_int_or_none(el.findtext(ns + 'seeders')),
            leechers=_int_or_none(el.findtext(ns + 'leechers')),
            infoHash=hash_v or None,
        ))
    return out


def src_dmhy(q, typ, page, mode='broad'):
    url = ('https://www.dmhy.org/topics/rss/rss.xml?keyword=%s'
           % urllib.parse.quote(q))
    raw = fetch(url).decode('utf-8', 'ignore')
    root = ET.fromstring(raw)
    out = []
    for el in root.iter('item'):
        title = el.findtext('title') or ''
        link = el.findtext('link') or ''
        guid = el.findtext('guid') or ''
        enclosure = el.find('enclosure')
        torrent = enclosure.get('url') if enclosure is not None else None
        out.append(item(
            'dmhy', title,
            id='dmhy:' + (guid.rsplit('/', 1)[-1] or title),
            type=_guess_type_from_title(title),
            createdAt=_rfc822_to_iso(el.findtext('pubDate')),
            torrent=torrent,
            href=link or None,
            infoHash=_info_hash_of(torrent),
        ))
    return out


def src_eztv(q, typ, page, mode='broad'):
    # EZTV API 不支持关键词检索：取最新列表后本地过滤
    url = 'https://eztvx.to/api/get-torrents?limit=100&page=1'
    data = fetch_json(url)
    ql = q.lower()
    out = []
    for t in data.get('torrents') or []:
        title = t.get('title') or t.get('filename') or ''
        if ql not in title.lower():
            continue
        out.append(item(
            'eztv', title,
            id='eztv:' + str(t.get('id')),
            type='日剧',
            size=t.get('size_bytes'),
            createdAt=_iso_from_unix(t.get('date_released_unix')),
            magnet=t.get('magnet_url'),
            href='https://eztvx.to/ep/%s/' % t.get('id'),
            seeders=_int_or_none(t.get('seeds')),
            leechers=_int_or_none(t.get('peers')),
            infoHash=t.get('hash'),
        ))
    return out


def src_btdig(q, typ, page, mode='broad'):
    url = 'https://btdig.com/search?q=%s&p=%d' % (urllib.parse.quote(q), page - 1)
    raw = fetch(url, prefer_curl=True).decode('utf-8', 'ignore')
    low = raw.lower()
    if 'too many requests' in low or 'rate limit' in low:
        return None, 'BTDig 触发限流（429），请稍后重试'
    out = []
    for block in re.split(r'<div class="one_result"', raw)[1:]:
        # 标题锚点：相对或绝对 URL 均可
        href_m = re.search(
            r'<a[^>]+href="((?:https?://btdig\.com)?/[^"]*)"[^>]*>(.*?)</a>',
            block, re.S)
        mag_m = re.search(r'href="(magnet:\?xt=urn:btih:[^"]+)"', block)
        size_m = re.search(r'<span class="torrent_size"[^>]*>(.*?)</span>',
                           block, re.S)
        if not mag_m:
            continue
        title = _strip_tags(href_m.group(2)) if href_m else ''
        if not title:
            continue
        size_txt = _strip_tags(size_m.group(1)) if size_m else ''
        magnet = html_unescape(mag_m.group(1))
        detail = None
        if href_m:
            href = href_m.group(1)
            detail = href if href.startswith('http') else 'https://btdig.com' + href
        out.append(item(
            'btdig', title,
            id='btdig:' + (detail or title),
            type=_guess_type_from_title(title),
            size=_parse_size(size_txt),
            magnet=magnet,
            href=detail,
            infoHash=_info_hash_of(magnet),
        ))
    return out


# 磁力猫（cilimao.app v3.0 的镜像站，clm17.vip / clm9.in 共用同一索引）
#   * 搜索：GET /search?word=<base64(关键词)>&sort=time&p=<页码>
#   * 站点有"点击访问"验证门：POST 同一 URL，body=act=challenge，返回 {"code":1} 后放行
#   * 列表页 /information/<id> 里的 32 位 id 就是 infohash 的 base32，
#     因此一次列表请求即可解析出全部磁力链接，无需逐条打开详情页
CLM_HOSTS = ['clm17.vip', 'clm9.in']
CLM_STATE = {'host': None, 'opener': None, 'lock': threading.Lock()}
CLM_ITEM_RE = re.compile(
    r'href="/information/([a-z0-9]{32})"[^>]*class="SearchListTitle_result_title">(.*?)</a>'
    r'.*?<div class="Search_list_info">(.*?)</div>', re.S)
CLM_SIZE_RE = re.compile(r'文件大小：\s*([\d.]+\s*[KMGTP]?B)')
CLM_DATE_RE = re.compile(r'创建时间：\s*(\d{4}-\d{2}-\d{2})')
CLM_FMT_RE = re.compile(r'文件格式：\s*(\.\w+)')
CLM_FILES_RE = re.compile(
    r'Search_result_type[^>]*>\s*(?:<i[^>]*>\s*</i>)?\s*(\d+)')
# 编码规格词（2160p / x265 / web-dl…）：广泛模式不能因为它是"最长分词"就去搜它
CLM_GENERIC_RE = re.compile(
    r'^(?:\d{3,4}[pi]|\d{3,4}x\d{3,4}|x26[45]|h26[45]|hevc|avc|10bit|8bit|4k|uhd|web|webrip|'
    r'web-dl|bluray|blu-ray|bdrip|dvdrip|hdrip|remux|hdr|hdr10|dv|dolby|ddp?|aac|ac3|dts|flac|'
    r'truehd|atmos|iso|mkv|mp4|avi|m2ts|chd|yts|internal|proper|repack|v\d)$', re.I)

# 磁力猫是 12 条/页的服务端分页站点（实测：总数在「找到…相关结果N个」里，
# 尾页链接指向 p=80，即一次搜索最多可翻 80 页 / 960 条）。
CLM_PAGE_SIZE = 12
CLM_DEFAULT_PAGES = 5            # 旧参数 pages 的默认值
CLM_MAX_PAGES_PER_REQUEST = 10   # 单次请求最多抓 10 页
CLM_MAX_PAGE = 80                # 站点页码上限（实测 p=80 为最后一页）
CLM_PARALLEL = 4                 # 第 1 页之后的并发数（第 1 页要串行过验证门）
CLM_DEFAULT_LIMIT = 20           # 新参数 limit 的默认值（每页条数）
CLM_MAX_LIMIT = CLM_MAX_PAGES_PER_REQUEST * CLM_PAGE_SIZE   # 单次最多返回 120 条
# 站点排序参数：time=时间、length=文件大小；名称/做种数没有服务端排序，由前端在页内排
CLM_SORT_MAP = {'time': 'time', 'size': 'length', 'name': 'time', 'seeders': 'time'}
CLM_TOTAL_RE = re.compile(r'相关结果\s*(\d+)\s*个')
CLM_SEARCH_HREF_RE = re.compile(r'href="([^"]*?/search\?[^"]*?)"')
CLM_P_RE = re.compile(r'[?&](?:amp;)?p=(\d+)')


def _clm_broad_keyword(q):
    """广泛模式：剔除规格词后取最长的有效分词（站点是 AND 语义，无法真 OR）。"""
    text = q.strip()
    tokens = [t for t in re.split(r'\s+', text) if t]
    if len(tokens) < 2:
        return text
    useful = [t for t in tokens if not CLM_GENERIC_RE.match(t) and not t.isdigit()]
    return max(useful, key=len) if useful else text


def _clm_session():
    """带 cookie 的会话（验证门的放行状态保存在 cookie 里）。"""
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def _clm_open(opener, url, data=None):
    headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    if data is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        headers['X-Requested-With'] = 'XMLHttpRequest'
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method='POST' if data is not None else 'GET')
    with opener.open(req, timeout=TIMEOUT) as resp:
        return resp.read().decode('utf-8', 'ignore')


def _clm_pass_gate(opener, url):
    body = _clm_open(opener, url, data=b'act=challenge')
    try:
        code = int((json.loads(body) or {}).get('code'))
    except (TypeError, ValueError, AttributeError):
        raise RuntimeError('验证返回非 JSON：%s' % body[:80])
    if code != 1:
        raise RuntimeError('验证未通过：%s' % body[:80])


def _clm_fetch(path):
    """带过门与镜像回退的 GET，返回 (host, html)。"""
    cached = CLM_STATE['host']
    hosts = ([cached] if cached else []) + [h for h in CLM_HOSTS if h != cached]
    last = None
    for host in hosts:
        try:
            opener = CLM_STATE['opener'] or _clm_session()
            url = 'https://%s%s' % (host, path)
            html = _clm_open(opener, url)
            if 'challenge-c' in html:
                _clm_pass_gate(opener, url)
                html = _clm_open(opener, url)
            if 'challenge-c' in html:
                raise RuntimeError('验证未通过')
            CLM_STATE['host'] = host
            CLM_STATE['opener'] = opener
            return host, html
        except Exception as exc:  # noqa: BLE001 - 换下一个镜像
            last = exc
            CLM_STATE['opener'] = None  # cookie 与域名绑定，换镜像重建会话
    raise RuntimeError('磁力猫镜像均不可用：%s' % last)


def _clm_hash_of(token):
    """列表项 32 位 ID → infohash（base32，20 字节）。"""
    if not token:
        return None
    try:
        pad = '=' * ((8 - len(token) % 8) % 8)
        return base64.b32decode(token.upper() + pad).hex().lower()
    except Exception:  # noqa: BLE001
        return None


def _clm_total_of(html):
    """「找到关键词相关结果4318个」里的总数。"""
    m = CLM_TOTAL_RE.search(html)
    return int(m.group(1)) if m else None


def _clm_max_page_of(html):
    """页码上限：所有 /search?...p=N 链接里的最大值（实测尾页指向 p=80）。"""
    pages = []
    for href in CLM_SEARCH_HREF_RE.findall(html):
        for raw in CLM_P_RE.findall(href):
            try:
                pages.append(int(raw))
            except ValueError:
                continue
    if not pages:
        return None
    return min(CLM_MAX_PAGE, max(pages))


def _clm_parse_page(html, host):
    """解析一页列表，返回 (items, total, maxPage)。"""
    out = []
    for rid, raw_title, raw_info in CLM_ITEM_RE.findall(html):
        title = html_unescape(_strip_tags(raw_title)).strip()
        if not title:
            continue
        info = ' '.join(_strip_tags(raw_info).split())
        info_hash = _clm_hash_of(rid)
        size_m = CLM_SIZE_RE.search(info)
        date_m = CLM_DATE_RE.search(info)
        fmt_m = CLM_FMT_RE.search(info)
        files_m = CLM_FILES_RE.search(raw_info)
        out.append(item(
            'clm', title,
            id='clm:' + rid,
            type=_guess_type_from_title(title),
            size=_parse_size(size_m.group(1)) if size_m else None,
            createdAt=(date_m.group(1) + 'T00:00:00Z') if date_m else None,
            magnet=magnet_of(info_hash, title) if info_hash else None,
            href='https://%s/information/%s' % (host, rid),
            infoHash=info_hash,
            fileCount=_int_or_none(files_m.group(1)) if files_m else None,
            format=fmt_m.group(1) if fmt_m else None,
        ))
    return out, _clm_total_of(html), _clm_max_page_of(html)


def src_clm_window(q, mode='broad', offset=0, limit=CLM_DEFAULT_LIMIT, sort='time'):
    """按 offset/limit 取窗口：把「第几条」换算成站点页码，只抓需要的站点页再切片。

    第 1 页必须串行（顺带过验证门、拿总数/页码上限），其余页最多 4 路并发；
    单页失败记进 pageErrors，不影响窗口里其它页。
    """
    # 服务端搜索是 AND 语义：精准模式发整句，广泛模式发剔除规格词后的最长分词
    keyword = _clm_broad_keyword(q) if mode == 'broad' else q.strip()
    if not keyword:
        return {'items': [], 'total': None, 'maxPage': None, 'offset': 0,
                'limit': limit, 'page': 1, 'pages': 0,
                'pageErrors': ['没有可用的搜索词']}
    word = urllib.parse.quote(
        base64.b64encode(keyword.encode('utf-8')).decode('ascii'))
    sort_key = CLM_SORT_MAP.get(sort, 'time')

    def page_url(p):
        return '/search?word=%s&sort=%s&p=%d' % (word, sort_key, p)

    off = max(0, _int_or_none(offset) or 0)
    lim = max(1, min(CLM_MAX_LIMIT, _int_or_none(limit) or CLM_DEFAULT_LIMIT))
    start = off // CLM_PAGE_SIZE + 1
    end = (off + lim - 1) // CLM_PAGE_SIZE + 1
    start = max(1, min(CLM_MAX_PAGE, start))
    end = max(start, min(CLM_MAX_PAGE, end))
    if end - start + 1 > CLM_MAX_PAGES_PER_REQUEST:
        end = start + CLM_MAX_PAGES_PER_REQUEST - 1

    host, html = _clm_fetch(page_url(start))
    first_items, total, max_page = _clm_parse_page(html, host)

    chunks = [first_items]
    page_errors = []
    last = end
    if max_page:
        last = min(last, max_page)
    rest = list(range(start + 1, last + 1))
    if rest:
        def grab(p):
            try:
                page_host, page_html = _clm_fetch(page_url(p))
                return p, page_host, page_html, None
            except Exception as exc:  # noqa: BLE001 - 单页失败不影响整体
                return p, host, None, exc

        with ThreadPoolExecutor(max_workers=min(CLM_PARALLEL, len(rest))) as pool:
            for p, page_host, page_html, exc in pool.map(grab, rest):
                if exc is not None:
                    page_errors.append('第 %d 页获取失败：%s' % (p, exc))
                    continue
                chunks.append(_clm_parse_page(page_html, page_host)[0])

    items = []
    for chunk in chunks:
        items.extend(chunk)

    skip = off - (start - 1) * CLM_PAGE_SIZE
    if skip < 0:
        skip = 0
    window = items[skip:skip + lim]
    return {'items': window, 'total': total, 'maxPage': max_page,
            'offset': off, 'limit': lim, 'page': start,
            'pages': end - start + 1, 'pageErrors': page_errors}


# --------------------------------------------------------------------------
# 辅助映射
# --------------------------------------------------------------------------

def _info_hash_of(magnet):
    if not magnet:
        return None
    m = re.search(r'btih:([0-9a-zA-Z]+)', magnet)
    return m.group(1).lower() if m else None


def _rfc822_to_iso(v):
    if not v:
        return None
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(v)
        return dt.strftime('%Y-%m-%dT%H:%M:%SZ')
    except Exception:
        return None


def _tpb_type(cat):
    c = str(cat)
    if c.startswith('1'):
        return '音乐'
    if c.startswith('2'):
        return '日剧'
    if c.startswith('3'):
        return '游戏'
    if c.startswith('4'):
        return '其他'
    if c.startswith('5'):
        return '其他'
    if c.startswith('6'):
        return '游戏'
    if c.startswith('7'):
        return '其他'
    return '其他'


def _nyaa_type(cat):
    c = str(cat)
    if c.startswith('1_'):
        return '动画'
    if c.startswith('2_'):
        return '音乐'
    if c.startswith('3_'):
        return '漫画'
    if c.startswith('4_'):
        return '日剧'
    if c.startswith('5_'):
        return '其他'
    if c.startswith('6_'):
        return '其他'
    return '其他'


def _guess_type_from_title(title):
    t = (title or '').lower()
    if any(k in t for k in ('漫画', 'comic', 'manga')):
        return '漫画'
    if any(k in t for k in ('音乐', 'flac', 'mp3', 'op', 'ed', 'ost', 'album')):
        return '音乐'
    if any(k in t for k in ('合集', 'batch', 'complete', '全')):
        return '合集'
    if any(k in t for k in ('日剧', '真人', 'tv', 'drama')):
        return '日剧'
    if any(k in t for k in ('raw')):
        return 'RAW'
    if any(k in t for k in ('特摄', 'ultraman', 'rider')):
        return '特摄'
    if any(k in t for k in ('游戏', 'game', 'pc', 'switch')):
        return '游戏'
    if any(k in t for k in ('动画', 'anime', 'bdrip', 'webrip', '1080p', '720p', 'mp4', 'mkv')):
        return '动画'
    return '其他'


def _parse_size(txt):
    if not txt:
        return None
    m = re.search(r'([\d.]+)\s*([KMGTP]?B)', txt, re.I)
    if not m:
        return None
    num = float(m.group(1))
    unit = m.group(2).upper()
    mult = {'B': 1, 'KB': 1024, 'MB': 1024 ** 2, 'GB': 1024 ** 3,
            'TB': 1024 ** 4, 'PB': 1024 ** 5}.get(unit, 1)
    return int(num * mult)


def _strip_tags(s):
    return re.sub(r'<[^>]+>', '', s or '').replace('&amp;', '&').strip()


# --------------------------------------------------------------------------
# 聚合
# --------------------------------------------------------------------------

def src_clm(q, typ, page, mode='broad', pages=CLM_DEFAULT_PAGES):
    """旧接口兼容：page/pages（1 基站点页）换算成 offset/limit 再取窗口。"""
    start = max(1, min(CLM_MAX_PAGE, _int_or_none(page) or 1))
    count = max(1, min(CLM_MAX_PAGES_PER_REQUEST,
                       _int_or_none(pages) or CLM_DEFAULT_PAGES))
    return src_clm_window(q, mode, (start - 1) * CLM_PAGE_SIZE,
                          count * CLM_PAGE_SIZE)


SOURCES = {
    'animes': src_animes,
    'clm': src_clm,
    'tpb': src_tpb,
    'nyaa': src_nyaa,
    'dmhy': src_dmhy,
    'eztv': src_eztv,
    'btdig': src_btdig,
}


def search(q, source, typ, mode='broad', offset=0, limit=CLM_DEFAULT_LIMIT,
           sort='time'):
    # 这里再夹一次，保证直接调用 search() 时 offset/limit 也安全（HTTP 层同样会夹）
    offset = max(0, _int_or_none(offset) or 0)
    limit = max(1, min(CLM_MAX_LIMIT, _int_or_none(limit) or CLM_DEFAULT_LIMIT))
    if not q:
        return {'results': [], 'errors': [{'source': source or 'all',
                                           'message': '请输入搜索关键词'}],
                'total': None, 'maxPage': None, 'offset': offset,
                'limit': limit, 'returned': 0}
    if source == 'all':
        names = list(SOURCES)
    elif source in SOURCES:
        names = [source]
    else:
        return {'results': [],
                'errors': [{'source': source, 'message': '未知来源'}],
                'total': None, 'maxPage': None, 'offset': offset,
                'limit': limit, 'returned': 0}

    results = []
    errors = []
    # 磁力猫的元数据（总数 / 页码上限 / 实际抓取的站点页）：其它源没有这些字段
    clm_meta = {'total': None, 'maxPage': None, 'page': None, 'pages': None}
    lock = threading.Lock()

    def run(name):
        try:
            if name == 'clm':
                out = src_clm_window(q, mode, offset, limit, sort)
            else:
                out = SOURCES[name](q, typ, 1, mode)
            # 磁力猫返回 {items, total, maxPage, ...}，其余源返回 list
            if isinstance(out, dict):
                with lock:
                    results.extend(out.get('items') or [])
                    clm_meta['total'] = out.get('total')
                    clm_meta['maxPage'] = out.get('maxPage')
                    clm_meta['page'] = out.get('page')
                    clm_meta['pages'] = out.get('pages')
                    for msg in out.get('pageErrors') or []:
                        errors.append({'source': name, 'message': msg})
                return
            if isinstance(out, tuple):
                msg = out[1] if len(out) > 1 else '未知错误'
                with lock:
                    errors.append({'source': name, 'message': msg})
                return
            with lock:
                results.extend(out or [])
        except Exception as exc:  # noqa: BLE001 - 单源失败不影响整体
            with lock:
                errors.append({'source': name, 'message': '%s: %s'
                               % (type(exc).__name__, exc)})

    threads = [threading.Thread(target=run, args=(n,), daemon=True) for n in names]
    for t in threads:
        t.start()
    deadline = time.time() + TIMEOUT + 5
    for t in threads:
        remaining = max(0.1, deadline - time.time())
        t.join(remaining)

    # 类型过滤（对未在服务端过滤的源生效）
    if typ:
        results = [r for r in results if r.get('type') == typ]

    # 精准模式：标题需命中全部分词（AND）
    if mode == 'precise':
        tokens = [t for t in re.split(r'\s+', q.strip()) if t]
        if tokens:
            lowered = [t.lower() for t in tokens]
            results = [r for r in results
                       if all(tok in (r.get('title') or '').lower()
                              for tok in lowered)]

    # 去重：优先 info hash（大小写归一），其次标题+大小
    seen = set()
    merged = []
    for r in results:
        raw_hash = r.get('infoHash')
        key = raw_hash.lower() if raw_hash else ((r.get('title') or '').lower(),
                                                r.get('size'))
        if key in seen:
            continue
        seen.add(key)
        merged.append(r)

    return {'results': merged, 'errors': errors,
            'total': clm_meta['total'], 'maxPage': clm_meta['maxPage'],
            'offset': offset, 'limit': limit, 'returned': len(merged),
            'page': clm_meta['page'], 'pages': clm_meta['pages']}


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'BTProxy/1.0'

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 约定
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path in ('/', '/index.html'):
                return self._static()
            if path == '/api/search':
                return self._api(parsed.query)
            if path == '/api/ping':
                _PING_STATE['seen'] = True
                _PING_STATE['last'] = time.time()
                return self._json({'ok': True})
            if path == '/api/health':
                return self._json({'ok': True})
            self.send_error(404, 'Not Found')
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            try:
                self._json({'error': '%s: %s' % (type(exc).__name__, exc)}, 500)
            except Exception:
                pass

    def _static(self):
        try:
            with open(INDEX_FILE, 'rb') as fh:
                body = fh.read()
        except OSError as exc:
            self.send_error(500, 'index.html 读取失败: %s' % exc)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _api(self, query):
        qs = urllib.parse.parse_qs(query)
        q = (qs.get('q', [''])[0] or '').strip()[:200]
        source = (qs.get('source', ['all'])[0] or 'all').strip()
        typ = (qs.get('type', [''])[0] or '').strip()
        mode = (qs.get('mode', ['broad'])[0] or 'broad').strip()
        if mode not in ('broad', 'precise'):
            mode = 'broad'
        sort = (qs.get('sort', ['time'])[0] or 'time').strip()
        if sort not in CLM_SORT_MAP:
            sort = 'time'
        try:
            offset = max(0, int(qs.get('offset', ['0'])[0]))
        except (TypeError, ValueError):
            offset = 0
        try:
            limit = int(qs.get('limit', [str(CLM_DEFAULT_LIMIT)])[0])
        except (TypeError, ValueError):
            limit = CLM_DEFAULT_LIMIT
        limit = max(1, min(CLM_MAX_LIMIT, limit))
        # 向后兼容：老调用方用 page/pages（1 基站点页 = 12 条/页）
        if 'offset' not in qs and 'limit' not in qs and ('page' in qs or 'pages' in qs):
            try:
                page = max(1, min(CLM_MAX_PAGE, int(qs.get('page', ['1'])[0])))
            except (TypeError, ValueError):
                page = 1
            try:
                pages = max(1, min(CLM_MAX_PAGES_PER_REQUEST,
                                   int(qs.get('pages', [str(CLM_DEFAULT_PAGES)])[0])))
            except (TypeError, ValueError):
                pages = CLM_DEFAULT_PAGES
            offset = (page - 1) * CLM_PAGE_SIZE
            limit = min(CLM_MAX_LIMIT, pages * CLM_PAGE_SIZE)
        cache_key = (source, q, typ, mode, sort, offset, limit)
        payload = cache_get(cache_key)
        if payload is None:
            payload = search(q, source, typ, mode, offset, limit, sort)
            cache_put(cache_key, payload)
        self._json(payload)

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 静默，避免控制台噪音
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    # 关闭 SO_REUSEADDR：Windows 下该标志允许两个进程同时绑定同一端口，
    # 会破坏“端口被占则顺延”的回退逻辑。
    allow_reuse_address = False


def main():
    no_browser = '--no-browser' in sys.argv

    if not os.path.exists(INDEX_FILE):
        fatal('缺少页面资源 index.html，程序无法启动。\n请重新下载完整的客户端。')

    httpd = None
    port = 0
    for candidate in range(17650, 17690):
        try:
            httpd = Server(('127.0.0.1', candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if httpd is None:
        fatal('17700 端口区间被占用，无法启动本地服务。\n请关闭占用端口的程序后重试。')

    url = 'http://127.0.0.1:%d/' % port
    if not no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    def watchdog():
        while True:
            time.sleep(5)
            if (_PING_STATE['seen']
                    and time.time() - _PING_STATE['last'] > _PING_TIMEOUT):
                os._exit(0)

    threading.Thread(target=watchdog, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
