window.__ModuleLoader__.load({
  id: 'dsh-plugin-bt-search',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useRef = React.useRef;

    // ------------------------------------------------------------------
    // 模块级：常量、主题色与内存缓存（factory 只执行一次）
    // ------------------------------------------------------------------
    // Host 侧同源聚合路由（插件 index.js 注册）。浏览器无法直连磁力猫这类
    // 没有 CORS 头 的站点，所以上游请求都交给 Host 进程。
    const HOST_API = '/plugins/dsh-plugin-bt-search/search';
    // Host 未就绪时的兜底：动漫花园接口允许跨域，可直接从浏览器访问。
    const ANIMES_API = 'https://api.animes.garden/resources';

    const TYPES = ['动画', '漫画', '音乐', '日剧', 'RAW', '合集', '特摄', '游戏'];
    const SOURCES = [['all', '全部'], ['animes', '动漫花园'], ['clm', '磁力猫']];
    const SOURCE_LABEL = {
      animes: '动漫花园', clm: '磁力猫',
      dmhy: '动漫花园', mikan: '蜜柑计划', moe: '萌番组', ani: 'ANi'
    };

    // 主题变量（每个都带浅色兜底值，token 缺失时外观不变）
    const C = {
      layer: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      layer2: 'var(--dsw-alias-bg-layer-2, #f9f9f9)',
      border: 'var(--dsw-alias-border-l1, #e3e6ea)',
      borderStrong: 'var(--dsw-alias-border-l2, #cccccc)',
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      muted: 'var(--dsw-alias-label-secondary, #6b7280)',
      brand: 'var(--dsw-alias-brand-primary, #247bbf)',
      idle: 'var(--dsw-alias-state-idle-primary, #999999)',
      err: 'var(--dsw-alias-state-error-primary, #b42318)',
      warn: 'var(--dsw-alias-state-warn-primary, #8a5a00)',
      star: '#f5a623'
    };

    const CACHE = new Map();
    const CACHE_TTL = 60 * 1000;
    const TIMEOUT_MS = 12000;

    function load(key) {
      try { return JSON.parse(localStorage.getItem(key) || '[]'); }
      catch (e) { return []; }
    }
    function save(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); }
      catch (e) { /* 忽略写入失败 */ }
    }

    function fmtSize(bytes) {
      if (bytes == null || isNaN(bytes)) return '未知大小';
      const u = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      let n = Number(bytes);
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function timeOf(v) {
      const t = new Date(v || 0).getTime();
      return isNaN(t) ? 0 : t;
    }
    // 磁力猫的时间是「日期 + UTC 零点」，直接按本地时区显示日期才不会被看成差一天。
    function fmtDate(iso) {
      if (!iso) return '未知时间';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function copyText(text) {
      function fallback() {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (e) { /* 忽略 */ }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(fallback);
      } else {
        fallback();
      }
    }

    function infoHashOf(magnet) {
      const m = /btih:([0-9a-zA-Z]+)/.exec(String(magnet || ''));
      return m ? m[1].toLowerCase() : null;
    }

    // 收藏键：优先 infohash（跨来源同一种子视为同一条），退回标题。
    function favKey(r) {
      const hash = r && (r.infoHash || infoHashOf(r.magnet));
      if (hash) return 'h:' + String(hash).toLowerCase();
      return 't:' + String((r && r.title) || '');
    }

    function mapAnimeGarden(rows) {
      return (rows || []).map((r) => ({
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
        infoHash: infoHashOf(r.magnet),
        fileCount: null,
        format: null
      }));
    }

    function buildNotice(fallbackNote, errors) {
      const parts = [];
      if (fallbackNote) parts.push(fallbackNote);
      if (errors && errors.length) {
        parts.push('部分来源不可用：' + errors.map((e) =>
          (SOURCE_LABEL[e.source] || e.source) + '：' + e.message).join('；'));
      }
      return parts.join(' ');
    }

    // ------------------------------------------------------------------
    // 面板组件
    // ------------------------------------------------------------------
    function BtSearchPanel() {
      const [query, setQuery] = useState('');
      const [results, setResults] = useState([]);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [hasSearched, setHasSearched] = useState(false);
      const [type, setType] = useState('all');
      const [source, setSource] = useState('all');
      const [sort, setSort] = useState('date');
      const [mode, setMode] = useState('broad');
      const [tab, setTab] = useState('search');
      const [history, setHistory] = useState(() => load('bt-search-history'));
      const [favorites, setFavorites] = useState(() => load('bt-search-favorites'));

      const reqSeq = useRef(0);
      const ctrlRef = useRef(null);

      const saveHistory = (kw) => {
        const updated = [kw].concat(history.filter((x) => x !== kw)).slice(0, 20);
        setHistory(updated);
        save('bt-search-history', updated);
      };

      const isFav = (r) => {
        const key = favKey(r);
        return favorites.some((f) => favKey(f) === key);
      };

      const toggleFavorite = (r) => {
        const key = favKey(r);
        let updated;
        if (favorites.some((f) => favKey(f) === key)) {
          updated = favorites.filter((f) => favKey(f) !== key);
        } else {
          updated = [{
            id: r.id, title: r.title, type: r.type, size: r.size,
            createdAt: r.createdAt, source: r.source, magnet: r.magnet,
            href: r.href, publisher: r.publisher, infoHash: r.infoHash,
            fileCount: r.fileCount, format: r.format
          }].concat(favorites);
        }
        setFavorites(updated);
        save('bt-search-favorites', updated);
      };

      const fetchHost = async (kw, src, md, signal) => {
        // type 不参与请求：类型筛选在前端即时生效，切换筛选不必重新抓取。
        const url = HOST_API + '?q=' + encodeURIComponent(kw)
          + '&source=' + encodeURIComponent(src)
          + '&mode=' + encodeURIComponent(md);
        const resp = await fetch(url, { signal, headers: { Accept: 'application/json' } });
        let data = null;
        try { data = await resp.json(); } catch (e) { data = null; }
        if (!resp.ok) {
          const first = data && data.errors && data.errors[0];
          throw new Error((first && first.message) || ('HTTP ' + resp.status));
        }
        if (!data || !Array.isArray(data.results)) throw new Error('返回格式异常');
        return data;
      };

      const fetchDirect = async (kw, md, signal) => {
        const url = ANIMES_API + '?search=' + encodeURIComponent(kw) + '&limit=50';
        const resp = await fetch(url, { signal });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        let rows = mapAnimeGarden((data && data.resources) || []);
        if (md === 'precise') {
          // Host 侧负责精准过滤；回退到直连时要在本地补上同样的 AND 过滤。
          const tokens = kw.toLowerCase().split(/\s+/).filter(Boolean);
          rows = rows.filter((r) => {
            const title = String(r.title || '').toLowerCase();
            return tokens.every((t) => title.indexOf(t) >= 0);
          });
        }
        return { results: rows, errors: [] };
      };

      const runSearch = async (kwArg, overrides) => {
        const kw = String(kwArg == null ? query : kwArg).trim();
        if (!kw) { setError('请输入搜索关键词'); return; }

        // 显式传参：setState 之后同一轮事件里读到的仍是旧闭包值。
        const useSource = (overrides && overrides.source) || source;
        const useMode = (overrides && overrides.mode) || mode;

        saveHistory(kw);
        setQuery(kw);
        setError('');
        setNotice('');
        setTab('search');
        setHasSearched(true);

        const cacheKey = [useMode, useSource, kw].join('|');
        const hit = CACHE.get(cacheKey);
        if (hit && Date.now() - hit.t < CACHE_TTL) {
          setResults(hit.results);
          setNotice(hit.notice || '');
          return;
        }

        if (ctrlRef.current) {
          try { ctrlRef.current.abort(); } catch (e) { /* 忽略 */ }
        }
        const seq = reqSeq.current + 1;
        reqSeq.current = seq;
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        ctrlRef.current = ctrl;
        let timedOut = false;
        const timer = ctrl ? setTimeout(() => {
          timedOut = true;
          try { ctrl.abort(); } catch (e) { /* 忽略 */ }
        }, TIMEOUT_MS) : null;

        setLoading(true);
        try {
          let data = null;
          let fallbackNote = '';
          try {
            data = await fetchHost(kw, useSource, useMode, ctrl ? ctrl.signal : undefined);
          } catch (hostError) {
            if (hostError && hostError.name === 'AbortError') throw hostError;
            if (useSource === 'clm') throw hostError;
            data = await fetchDirect(kw, useMode, ctrl ? ctrl.signal : undefined);
            fallbackNote = useSource === 'animes'
              ? 'Host 代理未就绪，改为直接查询动漫花园。'
              : 'Host 代理未就绪，本次只查询了动漫花园，磁力猫不可用。';
          }
          if (seq !== reqSeq.current) return;  // 已有更新的请求，丢弃这批结果

          const text = buildNotice(fallbackNote, (data.errors || []).filter(Boolean));
          CACHE.set(cacheKey, { t: Date.now(), results: data.results || [], notice: text });
          setResults(data.results || []);
          setNotice(text);
        } catch (e) {
          if (seq !== reqSeq.current) return;
          if (e && e.name === 'AbortError') {
            if (timedOut) {
              setResults([]);
              setError('搜索超时，请稍后重试');
            }
            return;
          }
          setResults([]);
          setError('搜索失败：' + (e && e.message ? e.message : String(e)));
        } finally {
          if (timer) clearTimeout(timer);
          if (seq === reqSeq.current) setLoading(false);
        }
      };

      const goHome = () => {
        if (ctrlRef.current) {
          try { ctrlRef.current.abort(); } catch (e) { /* 忽略 */ }
        }
        reqSeq.current += 1;
        setQuery('');
        setResults([]);
        setError('');
        setNotice('');
        setHasSearched(false);
        setLoading(false);
        setType('all');
        setSource('all');
        setSort('date');
        setMode('broad');
        setTab('search');
      };

      // 过滤 + 排序
      const shown = results
        .filter((r) => type === 'all' || r.type === type)
        .slice()
        .sort((a, b) => {
          if (sort === 'size') return (Number(b.size) || 0) - (Number(a.size) || 0);
          if (sort === 'name') return String(a.title || '').localeCompare(String(b.title || ''));
          return timeOf(b.createdAt) - timeOf(a.createdAt);
        });

      const chip = (label, active, onClick, disabled, title) => h('button', {
        onClick,
        disabled: !!disabled,
        title,
        style: {
          padding: '5px 12px', borderRadius: 999, fontSize: 12,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          border: '1px solid ' + (active ? C.brand : C.borderStrong),
          background: active ? C.brand : C.layer,
          color: active ? '#fff' : C.text
        }
      }, label);

      const card = (r, key) => h('div', {
        key,
        style: { padding: 12, marginBottom: 8, border: '1px solid ' + C.border, borderRadius: 8, background: C.layer2 }
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 } },
          h('div', { style: { fontWeight: 'bold', fontSize: 13, wordBreak: 'break-word', color: C.text } }, r.title),
          h('button', {
            onClick: () => toggleFavorite(r),
            title: isFav(r) ? '取消收藏' : '收藏',
            'aria-pressed': isFav(r) ? 'true' : 'false',
            style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: isFav(r) ? C.star : C.idle }
          }, isFav(r) ? '★' : '☆')
        ),
        h('div', { style: { fontSize: 12, color: C.muted, margin: '6px 0' } },
          [r.type || '其他', fmtSize(r.size), '发布 ' + fmtDate(r.createdAt),
            r.fileCount != null ? r.fileCount + ' 个文件' : null,
            r.format || null,
            '来源 ' + (SOURCE_LABEL[r.source] || r.source || '未知')].filter(Boolean).join(' · ')
        ),
        r.publisher && h('div', { style: { fontSize: 12, color: C.muted, marginBottom: 6 }, title: r.publisher }, r.publisher),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          r.magnet && h('a', {
            href: r.magnet, title: '交给系统默认下载器（迅雷 / BitComet）',
            style: { color: C.brand, textDecoration: 'none', fontSize: 13 }
          }, '磁力链接'),
          r.magnet && h('button', {
            onClick: () => copyText(r.magnet),
            title: '复制磁力链接',
            style: { padding: '0 10px', borderRadius: 6, border: '1px solid ' + C.borderStrong, background: C.layer, cursor: 'pointer', fontSize: 12, color: C.brand }
          }, '复制磁力'),
          r.href && h('a', { href: r.href, target: '_blank', rel: 'noopener', style: { color: C.brand, textDecoration: 'none', fontSize: 13 } }, '详情页')
        )
      );

      const homePanel = h('div', { style: { padding: 16 } },
        h('div', { style: { marginBottom: 10, fontSize: 13, color: C.muted } }, '最近搜索'),
        history.length === 0
          ? h('div', { style: { color: C.idle, fontSize: 13 } }, '还没有搜索记录，试试上方搜索框。')
          : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              history.slice(0, 8).map((kw, i) => h('button', {
                key: i,
                onClick: () => runSearch(kw),
                style: { padding: '5px 12px', borderRadius: 999, border: '1px solid ' + C.borderStrong, background: C.layer, color: C.text, cursor: 'pointer', fontSize: 12 }
              }, kw))
            ),
        h('div', { style: { marginTop: 14, fontSize: 13, color: C.muted } },
          '收藏：' + favorites.length + ' 个（切换到「收藏」查看）')
      );

      return h('div', { style: { padding: 16, height: '100%', overflow: 'auto', color: C.text } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
          h('h2', { style: { margin: 0, fontSize: 18, color: C.text } }, 'BT资源搜索'),
          h('button', {
            onClick: goHome,
            title: '清空关键词与筛选，回到最近搜索',
            style: { padding: '6px 12px', borderRadius: 6, border: '1px solid ' + C.borderStrong, background: C.layer, color: C.text, cursor: 'pointer', fontSize: 12 }
          }, '← 返回主页')
        ),

        h('div', { style: { display: 'flex', gap: 6, marginBottom: 12 } },
          [['search', '搜索'], ['history', '历史'], ['favorites', '收藏']].map(([k, label]) =>
            h('button', {
              key: k,
              onClick: () => setTab(k),
              style: {
                padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                border: '1px solid ' + (tab === k ? C.brand : C.borderStrong),
                background: tab === k ? C.brand : C.layer,
                color: tab === k ? '#fff' : C.text
              }
            }, label)
          )
        ),

        tab === 'search' && h('div', {},
          h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
            h('input', {
              value: query,
              onChange: (e) => setQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') runSearch(); },
              placeholder: '输入关键词，多个词用空格分隔',
              style: {
                flex: 1, padding: 9, borderRadius: 8, fontSize: 14,
                border: '1px solid ' + C.borderStrong, background: C.layer, color: C.text
              }
            }),
            h('button', {
              onClick: () => runSearch(),
              disabled: loading,
              style: {
                padding: '9px 18px', borderRadius: 8, border: 'none', fontSize: 14,
                background: C.brand, color: '#fff',
                cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1
              }
            }, '搜索')
          ),

          h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 4 } }, '改「来源 / 搜索方式」会重新搜索，改「类型 / 排序」只筛当前结果'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 } },
            h('span', { style: { fontSize: 12, color: C.muted } }, '来源：'),
            SOURCES.map(([v, label]) =>
              chip(label, source === v, () => {
                setSource(v);
                if (hasSearched || query.trim()) runSearch(undefined, { source: v });
              }, loading)
            )
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 } },
            h('span', { style: { fontSize: 12, color: C.muted } }, '类型：'),
            [['all', '全部']].concat(TYPES.map((t) => [t, t])).map(([v, label]) =>
              chip(label, type === v, () => setType(v))
            ),
            h('span', { style: { fontSize: 11, color: C.idle } }, '（磁力猫的类型按标题推断，可能不全）')
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 } },
            h('span', { style: { fontSize: 12, color: C.muted } }, '排序：'),
            [['date', '时间'], ['size', '大小'], ['name', '名称']].map(([v, label]) =>
              chip(label, sort === v, () => setSort(v))
            )
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12 } },
            h('span', { style: { fontSize: 12, color: C.muted } }, '搜索方式：'),
            chip('广泛', mode === 'broad', () => {
              setMode('broad');
              if (hasSearched || query.trim()) runSearch(undefined, { mode: 'broad' });
            }, loading, '任一关键词命中即返回；磁力猫为 AND 语义，只发最长的一个有效关键词'),
            chip('精准', mode === 'precise', () => {
              setMode('precise');
              if (hasSearched || query.trim()) runSearch(undefined, { mode: 'precise' });
            }, loading, '标题必须同时包含全部关键词')
          ),

          notice && h('div', {
            style: { marginBottom: 10, padding: '8px 12px', borderRadius: 8, background: C.layer2, border: '1px solid ' + C.border, color: C.warn, fontSize: 12 }
          }, notice),

          error && h('div', {
            style: { marginBottom: 10, padding: '8px 12px', borderRadius: 8, background: C.layer2, border: '1px solid ' + C.err, color: C.err, fontSize: 12 }
          }, error),

          loading && h('div', { style: { textAlign: 'center', padding: 20, color: C.muted } }, '搜索中…'),

          !loading && !error && !hasSearched && homePanel,

          !loading && !error && hasSearched && results.length === 0 && h('div', {
            style: { textAlign: 'center', padding: 24, color: C.muted, fontSize: 13 }
          }, '没有找到「' + query + '」相关的资源。可换个关键词、切到「全部」来源，或把搜索方式改成「广泛」。'),

          !loading && results.length > 0 && h('div', {},
            h('div', { style: { fontSize: 12, color: C.muted, marginBottom: 8 } },
              '共 ' + results.length + ' 条，当前筛选 ' + shown.length + ' 条'),
            shown.map((r, i) => card(r, (r.id || 'idx') + '-' + i)),
            shown.length === 0 && h('div', { style: { textAlign: 'center', padding: 20, color: C.muted } }, '当前类型筛选下没有结果，可切回「全部」。')
          )
        ),

        tab === 'history' && h('div', {},
          h('h3', { style: { margin: '0 0 8px', fontSize: 15, color: C.text } }, '搜索历史'),
          history.length === 0 && h('div', { style: { color: C.idle, padding: 20, textAlign: 'center' } }, '暂无搜索历史'),
          history.map((kw, i) =>
            h('div', {
              key: i,
              onClick: () => { setTab('search'); runSearch(kw); },
              style: { padding: '8px 12px', marginBottom: 4, border: '1px solid ' + C.border, borderRadius: 6, cursor: 'pointer', background: C.layer2, fontSize: 13, color: C.text }
            }, kw)
          ),
          history.length > 0 && h('button', {
            onClick: () => { setHistory([]); save('bt-search-history', []); },
            style: { marginTop: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid ' + C.borderStrong, background: C.layer, color: C.text, cursor: 'pointer', fontSize: 12 }
          }, '清空历史')
        ),

        tab === 'favorites' && h('div', {},
          h('h3', { style: { margin: '0 0 8px', fontSize: 15, color: C.text } }, '收藏'),
          favorites.length === 0 && h('div', { style: { color: C.idle, padding: 20, textAlign: 'center' } }, '暂无收藏，点击结果卡片上的 ☆ 收藏资源。'),
          favorites.map((r, i) => card(r, 'fav-' + (r.id || i)))
        )
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          id: 'bt-search', order: 5, label: 'BT搜索',
        }, BtSearchPanel));
      },
    };
  },
});
