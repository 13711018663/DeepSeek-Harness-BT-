window.__ModuleLoader__.load({
  id: 'dsh-plugin-bt-search',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;

    // ------------------------------------------------------------------
    // 模块级：常量与内存缓存（factory 只执行一次，跨组件挂载持久）
    // ------------------------------------------------------------------
    const API = 'https://api.animes.garden/resources';
    const CACHE = new Map();
    const CACHE_TTL = 60 * 1000;
    const TIMEOUT_MS = 10000;
    const TYPES = ['动画', '漫画', '音乐', '日剧', 'RAW', '合集', '特摄', '游戏'];
    const PROVIDER_LABEL = { dmhy: '动漫花园', mikan: '蜜柑计划', moe: '萌番组', ani: 'ANi' };

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

    // ------------------------------------------------------------------
    // 面板组件
    // ------------------------------------------------------------------
    function BtSearchPanel() {
      const [query, setQuery] = useState('');
      const [results, setResults] = useState([]);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [type, setType] = useState('all');
      const [sort, setSort] = useState('date');
      const [mode, setMode] = useState('broad');
      const [tab, setTab] = useState('search');
      const [history, setHistory] = useState(() => load('bt-search-history'));
      const [favorites, setFavorites] = useState(() => load('bt-search-favorites'));

      const saveHistory = (kw) => {
        const updated = [kw].concat(history.filter((x) => x !== kw)).slice(0, 20);
        setHistory(updated);
        save('bt-search-history', updated);
      };

      const toggleFavorite = (r) => {
        let updated;
        if (favorites.some((f) => f.title === r.title)) {
          updated = favorites.filter((f) => f.title !== r.title);
        } else {
          updated = [{ title: r.title, type: r.type, size: r.size, createdAt: r.createdAt, provider: r.provider, magnet: r.magnet, href: r.href, publisher: r.publisher }].concat(favorites);
        }
        setFavorites(updated);
        save('bt-search-favorites', updated);
      };

      const isFav = (r) => favorites.some((f) => f.title === r.title);

      const runSearch = async () => {
        const kw = query.trim();
        if (!kw) return;
        saveHistory(kw);
        setError('');
        setTab('search');

        const cacheKey = mode + '|' + type + '|' + kw;
        const hit = CACHE.get(cacheKey);
        if (hit && Date.now() - hit.t < CACHE_TTL) {
          setResults(hit.data);
          return;
        }

        setLoading(true);
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
        try {
          let url = API + '?search=' + encodeURIComponent(kw) + '&limit=50';
          if (type !== 'all') url += '&types=' + encodeURIComponent(type);
          const resp = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const data = await resp.json();
          let list = (data && data.resources) || [];
          if (mode === 'precise') {
            const tokens = kw.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
            list = list.filter((r) => tokens.every((t) => String(r.title || '').toLowerCase().indexOf(t) >= 0));
          }
          CACHE.set(cacheKey, { t: Date.now(), data: list });
          setResults(list);
        } catch (e) {
          setResults([]);
          setError(e && e.name === 'AbortError'
            ? '搜索超时，请稍后重试'
            : '搜索失败：' + (e && e.message ? e.message : String(e)));
        } finally {
          if (timer) clearTimeout(timer);
          setLoading(false);
        }
      };

      const goHome = () => {
        setQuery('');
        setResults([]);
        setError('');
        setType('all');
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
          return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
        });

      const chip = (label, active, onClick) => h('button', {
        onClick,
        style: {
          padding: '5px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
          border: '1px solid ' + (active ? '#247bbf' : '#ccc'),
          background: active ? '#247bbf' : '#fff',
          color: active ? '#fff' : '#333'
        }
      }, label);

      const card = (r, key) => h('div', {
        key,
        style: { padding: 12, marginBottom: 8, border: '1px solid #eee', borderRadius: 8, background: '#f9f9f9' }
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 } },
          h('div', { style: { fontWeight: 'bold', fontSize: 13, wordBreak: 'break-all' } }, r.title),
          h('button', {
            onClick: () => toggleFavorite(r),
            style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: isFav(r) ? '#f5a623' : '#ccc' }
          }, isFav(r) ? '★' : '☆')
        ),
        h('div', { style: { fontSize: 12, color: '#666', margin: '6px 0' } },
          [r.type || '其他', fmtSize(r.size), '发布 ' + fmtDate(r.createdAt),
            '来源 ' + (PROVIDER_LABEL[r.provider] || r.provider || '未知'),
            r.publisher ? r.publisher : null].filter(Boolean).join(' · ')
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          r.magnet && h('a', { href: r.magnet, style: { color: '#247bbf', textDecoration: 'none', fontSize: 13 } }, '磁力链接'),
          r.magnet && h('button', {
            onClick: () => copyText(r.magnet),
            style: { padding: '0 10px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: 12, color: '#247bbf' }
          }, '复制磁力'),
          r.href && h('a', { href: r.href, target: '_blank', rel: 'noopener', style: { color: '#247bbf', textDecoration: 'none', fontSize: 13 } }, '详情页')
        )
      );

      return h('div', { style: { padding: 16, height: '100%', overflow: 'auto' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
          h('h2', { style: { margin: 0, fontSize: 18 } }, 'BT资源搜索'),
          h('button', {
            onClick: goHome,
            style: { padding: '6px 12px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: 12 }
          }, '← 返回主页')
        ),

        h('div', { style: { display: 'flex', gap: 6, marginBottom: 12 } },
          [['search', '搜索'], ['history', '历史'], ['favorites', '收藏']].map(([k, label]) =>
            h('button', {
              key: k,
              onClick: () => setTab(k),
              style: {
                padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                border: '1px solid ' + (tab === k ? '#247bbf' : '#ccc'),
                background: tab === k ? '#247bbf' : '#fff',
                color: tab === k ? '#fff' : '#000'
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
              placeholder: '搜索资源，如：葬送的芙莉莲',
              style: { flex: 1, padding: 9, borderRadius: 8, border: '1px solid #ccc', fontSize: 14 }
            }),
            h('button', {
              onClick: runSearch,
              style: { padding: '9px 18px', borderRadius: 8, background: '#247bbf', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 14 }
            }, '搜索')
          ),

          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 } },
            h('span', { style: { fontSize: 12, color: '#666' } }, '类型：'),
            [['all', '全部']].concat(TYPES.map((t) => [t, t])).map(([v, label]) =>
              chip(label, type === v, () => setType(v))
            )
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 } },
            h('span', { style: { fontSize: 12, color: '#666' } }, '排序：'),
            [['date', '时间'], ['size', '大小'], ['name', '名称']].map(([v, label]) =>
              chip(label, sort === v, () => setSort(v))
            )
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12 } },
            h('span', { style: { fontSize: 12, color: '#666' } }, '搜索方式：'),
            [['broad', '广泛'], ['precise', '精准']].map(([v, label]) =>
              chip(label, mode === v, () => setMode(v))
            )
          ),

          error && h('div', {
            style: { marginBottom: 10, padding: '8px 12px', borderRadius: 8, background: '#fdecec', border: '1px solid #f3c2c2', color: '#b42318', fontSize: 12 }
          }, error),

          loading && h('div', { style: { textAlign: 'center', padding: 20, color: '#888' } }, '搜索中…'),

          !loading && !error && results.length === 0 && h('div', { style: { padding: 16 } },
            h('div', { style: { marginBottom: 10, fontSize: 13, color: '#555' } }, '最近搜索'),
            history.length === 0
              ? h('div', { style: { color: '#999', fontSize: 13 } }, '还没有搜索记录，试试上方搜索框。')
              : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
                  history.slice(0, 8).map((kw, i) => h('button', {
                    key: i,
                    onClick: () => { setQuery(kw); runSearch(); },
                    style: { padding: '5px 12px', borderRadius: 999, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: 12 }
                  }, kw))
                ),
            h('div', { style: { marginTop: 14, fontSize: 13, color: '#555' } },
              '收藏：' + favorites.length + ' 个（切换到「收藏」查看）')
          ),

          !loading && results.length > 0 && h('div', {}, shown.map((r, i) => card(r, i))),
          !loading && results.length > 0 && shown.length === 0 && h('div', { style: { textAlign: 'center', padding: 20, color: '#888' } }, '当前筛选下没有结果')
        ),

        tab === 'history' && h('div', {},
          h('h3', { style: { margin: '0 0 8px', fontSize: 15 } }, '搜索历史'),
          history.length === 0 && h('div', { style: { color: '#999', padding: 20, textAlign: 'center' } }, '暂无搜索历史'),
          history.map((kw, i) =>
            h('div', {
              key: i,
              onClick: () => { setQuery(kw); setTab('search'); runSearch(); },
              style: { padding: '8px 12px', marginBottom: 4, border: '1px solid #eee', borderRadius: 6, cursor: 'pointer', background: '#f9f9f9', fontSize: 13 }
            }, kw)
          ),
          history.length > 0 && h('button', {
            onClick: () => { setHistory([]); save('bt-search-history', []); },
            style: { marginTop: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: 12 }
          }, '清空历史')
        ),

        tab === 'favorites' && h('div', {},
          h('h3', { style: { margin: '0 0 8px', fontSize: 15 } }, '收藏'),
          favorites.length === 0 && h('div', { style: { color: '#999', padding: 20, textAlign: 'center' } }, '暂无收藏，点击结果卡片上的 ☆ 收藏资源。'),
          favorites.map((r, i) => card(r, 'fav-' + i))
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
