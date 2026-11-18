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

    // 结果池（模块级缓存，按查询指纹失效）：语义与桌面版一致。
    // fullList = 单源整表（本地分页）；clmPool/allPool = 「全部」来源的结果池。
    const poolState = {
      fullList: [],
      fullListKey: '',
      clmPool: [],
      clmPoolKey: '',
      allPool: [],
      allPoolKey: '',
      lastRows: []
    };

    // 磁力猫首屏要请求多页窗口（含可能的验证门），超时要留够余量。
    const TIMEOUT_MS = 25000;
    // 磁力猫 12 条/页、单次搜索最多 80 页（约 960 条）：页面按「每页条数 + 页码」
    // 换算 offset/limit 取窗口；其它来源整表取回后本地分页。
    const CLM_PAGE_SIZE = 12;
    const CLM_MAX_PAGE = 80;
    const CLM_MAX_TOTAL = CLM_PAGE_SIZE * CLM_MAX_PAGE;
    const PAGE_SIZES = [10, 20, 50, 100];
    const DEFAULT_PAGE_SIZE = 20;
    // 「全部」来源并入磁力猫前 240 条（2 次窗口请求，每次 120 条，并行）
    const CLM_POOL_LIMIT = 240;
    const CLM_POOL_CHUNK = 120;
    const SORT_OPTIONS = [['date', '时间'], ['size', '大小'], ['name', '名称']];

    function load(key) {
      try { return JSON.parse(localStorage.getItem(key) || '[]'); }
      catch (e) { return []; }
    }
    function save(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); }
      catch (e) { /* 忽略写入失败 */ }
    }

    function loadPageSize() {
      try {
        const n = parseInt(localStorage.getItem('bt-page-size') || '', 10);
        if (PAGE_SIZES.indexOf(n) >= 0) return n;
      } catch (e) { /* 忽略读取失败 */ }
      return DEFAULT_PAGE_SIZE;
    }
    function savePageSize(n) {
      try { localStorage.setItem('bt-page-size', String(n)); }
      catch (e) { /* 忽略写入失败 */ }
    }

    function sortList(list, sort) {
      const arr = list.slice();
      if (sort === 'size') {
        arr.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
      } else if (sort === 'name') {
        arr.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
      } else {
        arr.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
      }
      return arr;
    }
    // 「全部」来源的结果池已全局排序，页内不再重排；
    // 磁力猫单源时间/大小是服务端全局排序，页内不要重排。
    function maybeSort(list, source, sort) {
      if (source === 'all') return list;
      if (source === 'clm' && (sort === 'date' || sort === 'size')) return list;
      return sortList(list, sort);
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

    // 追加「加载更多」结果时按 infohash / id 去重，避免翻页边界重复。
    function dedupeRows(list) {
      const seen = new Set();
      const out = [];
      for (const row of list) {
        const hash = row && (row.infoHash || infoHashOf(row.magnet));
        const key = hash ? String(hash).toLowerCase() : ('t:' + ((row && row.title) || ''));
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
      }
      return out;
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
      // 分页状态：每页条数、当前页、总页数、磁力猫站点元数据、并行抓取进度
      const [pageSize, setPageSize] = useState(loadPageSize);
      const [curPage, setCurPage] = useState(1);
      const [totalPages, setTotalPages] = useState(1);
      const [loadingPage, setLoadingPage] = useState(false);
      const [clmTotal, setClmTotal] = useState(null);
      const [clmMaxPage, setClmMaxPage] = useState(null);
      const [poolProgress, setPoolProgress] = useState('');

      const reqSeq = useRef(0);
      const ctrlRef = useRef(null);
      const containerRef = useRef(null);

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

      const fetchHost = async (kw, src, md, tp, offset, limit, st, signal) => {
        // type/sort 参与请求：类型筛选与站点排序由 Host 侧（服务端）执行，
        // 翻页时窗口请求才会命中正确的筛选结果。
        const url = HOST_API + '?q=' + encodeURIComponent(kw)
          + '&source=' + encodeURIComponent(src)
          + '&type=' + encodeURIComponent(tp)
          + '&mode=' + encodeURIComponent(md)
          + '&sort=' + encodeURIComponent(st)
          + '&offset=' + (offset || 0)
          + '&limit=' + (limit || DEFAULT_PAGE_SIZE);
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

      // 动漫花园：优先走 Host 代理；Host 未就绪时直连（该接口允许跨域）。
      const fetchAnimes = async (kw, md, tp, st, signal) => {
        try {
          return await fetchHost(kw, 'animes', md, tp, 0, 100, st, signal);
        } catch (hostError) {
          if (hostError && hostError.name === 'AbortError') throw hostError;
          const data = await fetchDirect(kw, md, signal);
          return {
            results: data.results,
            errors: [],
            fallbackNote: 'Host 代理未就绪，动漫花园改为直连。',
          };
        }
      };

      const runSearch = async (kwArg, overrides) => {
        const kw = String(kwArg == null ? query : kwArg).trim();
        if (!kw) { setError('请输入搜索关键词'); return; }

        // 显式传参：setState 之后同一轮事件里读到的仍是旧闭包值。
        const useSource = (overrides && overrides.source) || source;
        const useMode = (overrides && overrides.mode) || mode;
        const useSort = (overrides && overrides.sort) || sort;
        const useType = (overrides && overrides.type) || type;
        const usePageSize = (overrides && overrides.pageSize) || pageSize;

        saveHistory(kw);
        setQuery(kw);
        setError('');
        setNotice('');
        setTab('search');
        setHasSearched(true);
        setSource(useSource);
        setMode(useMode);
        setSort(useSort);
        setType(useType);
        setPageSize(usePageSize);
        // 新一轮搜索重置分页状态；整表缓存按指纹失效（指纹含类型/排序），
        // 「全部」来源的结果池不含每页条数，保留以便切换每页条数时零请求重切。
        setClmTotal(null);
        setClmMaxPage(null);
        setCurPage(1);
        setTotalPages(1);
        setPoolProgress('');
        setResults([]);
        poolState.fullList = [];
        poolState.fullListKey = '';
        poolState.lastRows = [];

        if (ctrlRef.current) {
          try { ctrlRef.current.abort(); } catch (e) { /* 忽略 */ }
        }
        reqSeq.current += 1;
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        ctrlRef.current = ctrl;
        const ctx = { timedOut: false };
        const timer = ctrl ? setTimeout(() => {
          ctx.timedOut = true;
          try { ctrl.abort(); } catch (e) { /* 忽略 */ }
        }, TIMEOUT_MS) : null;

        setLoading(true);
        try {
          await loadPage(1, {
            kw, source: useSource, mode: useMode, sort: useSort,
            type: useType, pageSize: usePageSize, ctx,
          });
        } catch (e) {
          // loadPage 内部已处理各类错误，这里兜底防御
          if (e && e.name !== 'AbortError') {
            setResults([]);
            setError('搜索失败：' + (e && e.message ? e.message : String(e)));
            setLoadingPage(false);
            setLoading(false);
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const takeClmMeta = (data) => {
        if (data.total != null) {
          setClmTotal(data.total);
          setClmMaxPage(data.maxPage == null ? null : data.maxPage);
        }
      };

      // 动漫花园整表：只在查询指纹变化时重新抓取，翻页直接本地切片。
      const ensureAnimes = (kw, md, tp, st, signal, cb) => {
        const key = ['animes', kw, tp, md, st].join('|');
        if (poolState.fullListKey === key) { cb(poolState.fullList, [], null); return; }
        fetchAnimes(kw, md, tp, st, signal)
          .then((data) => {
            let rows = data.results || [];
            if (tp) rows = rows.filter((r) => r.type === tp);
            poolState.fullList = sortList(dedupeRows(rows), st);
            poolState.fullListKey = key;
            cb(poolState.fullList, data.errors || [], data.fallbackNote || null);
          })
          .catch((e) => {
            cb([], [{ source: 'animes', message: e && e.message ? e.message : String(e) }], null);
          });
      };

      // 磁力猫按当前排序并入前 240 条（2 次窗口请求，每次 120 条，并行）
      const ensureClmPool = (kw, md, tp, st, signal, cb) => {
        const key = ['clmpool', kw, tp, md, st].join('|');
        if (poolState.clmPoolKey === key) { cb(poolState.clmPool, []); return; }
        const errs = [];
        const parts = [];
        let pending = 2;
        const finish = () => {
          pending -= 1;
          if (pending > 0) return;
          poolState.clmPool = dedupeRows((parts[0] || []).concat(parts[1] || []));
          poolState.clmPoolKey = key;
          cb(poolState.clmPool, errs);
        };
        [0, CLM_POOL_CHUNK].forEach((off, i) => {
          fetchHost(kw, 'clm', md, tp, off, CLM_POOL_CHUNK, st, signal)
            .then((data) => {
              takeClmMeta(data);
              (data.errors || []).forEach((e) => errs.push(e));
              parts[i] = data.results || [];
              finish();
            })
            .catch((e) => {
              errs.push({ source: 'clm', message: e && e.message ? e.message : String(e) });
              parts[i] = [];
              finish();
            });
        });
      };

      const applyPage = (n, rows, errs, src, st, note, freshTotal) => {
        setLoadingPage(false);
        setLoading(false);
        const list = maybeSort(dedupeRows(rows || []), src, st);
        poolState.lastRows = list;
        setCurPage(n);
        setTotalPages(computeTotalPages(src, n, freshTotal));
        setResults(list);
        setError('');
        setNotice(buildNotice(note || '', (errs || []).filter(Boolean)));
        if (containerRef.current && containerRef.current.scrollTop > 0) {
          try { containerRef.current.scrollTop = 0; } catch (e) { /* 忽略 */ }
        }
      };

      const failPage = (n, msg) => {
        setLoadingPage(false);
        setLoading(false);
        setError('加载第 ' + n + ' 页失败：' + msg);
      };

      const currentTotal = (src) => {
        if (src === 'clm') {
          if (clmTotal == null) return poolState.lastRows.length;
          return Math.min(clmTotal, CLM_MAX_TOTAL);
        }
        if (src === 'all') return poolState.allPool.length || poolState.fullList.length;
        return poolState.fullList.length;
      };

      const computeTotalPages = (src, n, freshTotal) => {
        // freshTotal：磁力猫的站点总数刚拿到时 state 还没更新，这里显式传入，
        // 避免用上一轮闭包里的旧值算错页码（结果池在模块变量里，本身就是新值）。
        const total = freshTotal != null
          ? (src === 'clm' ? Math.min(freshTotal, CLM_MAX_TOTAL) : freshTotal)
          : currentTotal(src);
        if (!total) return Math.max(1, n);
        return Math.max(1, Math.ceil(total / pageSize));
      };

      const loadPage = async (n, opts) => {
        const kw = String(opts.kw == null ? query : opts.kw).trim();
        if (!kw || loadingPage) return;
        const src = opts.source == null ? source : opts.source;
        const md = opts.mode == null ? mode : opts.mode;
        const st = opts.sort == null ? sort : opts.sort;
        const tp = opts.type == null ? type : opts.type;
        const ps = opts.pageSize == null ? pageSize : opts.pageSize;
        n = Math.max(1, Math.min(totalPages, parseInt(n, 10) || 1));
        const seq = reqSeq.current;
        const signal = ctrlRef.current ? ctrlRef.current.signal : undefined;
        setLoadingPage(true);
        setError('');
        const offset = (n - 1) * ps;

        // 1) 纯磁力猫：服务端窗口分页
        if (src === 'clm') {
          try {
            const data = await fetchHost(kw, 'clm', md, tp, offset, ps, st, signal);
            if (seq !== reqSeq.current) return;
            takeClmMeta(data);
            applyPage(n, data.results, data.errors, src, st, null, data.total);
          } catch (e) {
            if (seq !== reqSeq.current) return;
            if (e && e.name === 'AbortError') {
              if (opts.ctx && opts.ctx.timedOut) {
                setResults([]);
                setError('搜索超时，请稍后重试');
              }
              setLoadingPage(false);
              setLoading(false);
              return;
            }
            failPage(n, e && e.message ? e.message : String(e));
          }
          return;
        }

        // 2) 全部来源：动漫花园整表 + 磁力猫前 240 条并行抓取，
        //    合并去重后按当前排序全局排序，本地分页
        if (src === 'all') {
          const poolKey = ['allpool', kw, tp, md, st].join('|');
          if (poolState.allPoolKey === poolKey && poolState.allPool.length) {
            applyPage(n, poolState.allPool.slice(offset, offset + ps), [], src, st);
            return;
          }
          let pending = 2;
          let oRows = [];
          let cRows = [];
          const errs = [];
          let gotCount = 0;
          let fallbackNote = '';
          const finish = () => {
            pending -= 1;
            if (pending > 0) {
              setPoolProgress('已收到 ' + gotCount + ' 条（等待 ' + pending + ' 组来源）');
              return;
            }
            setPoolProgress('');
            if (seq !== reqSeq.current) return;
            if (!oRows.length && !cRows.length && opts.ctx && opts.ctx.timedOut) {
              setLoadingPage(false);
              setLoading(false);
              setError('搜索超时，请稍后重试');
              return;
            }
            poolState.allPool = sortList(dedupeRows(oRows.concat(cRows)), st);
            poolState.allPoolKey = poolKey;
            applyPage(n, poolState.allPool.slice(offset, offset + ps), errs, src, st, fallbackNote);
          };
          ensureAnimes(kw, md, tp, st, signal, (rows, e, note) => {
            oRows = rows;
            gotCount += rows.length;
            if (note) fallbackNote = note;
            (e || []).forEach((x) => errs.push(x));
            finish();
          });
          ensureClmPool(kw, md, tp, st, signal, (rows, e) => {
            cRows = rows;
            gotCount += rows.length;
            (e || []).forEach((x) => errs.push(x));
            finish();
          });
          return;
        }

        // 3) 动漫花园单源：整表取一次，之后本地分页
        const key = [src, kw, tp, md, st].join('|');
        if (poolState.fullListKey === key && poolState.fullList.length) {
          applyPage(n, poolState.fullList.slice(offset, offset + ps), [], src, st);
          return;
        }
        ensureAnimes(kw, md, tp, st, signal, (rows, e, note) => {
          if (seq !== reqSeq.current) return;
          if (opts.ctx && opts.ctx.timedOut && !rows.length && (e || []).length) {
            setLoadingPage(false);
            setLoading(false);
            setError('搜索超时，请稍后重试');
            return;
          }
          applyPage(n, rows.slice(offset, offset + ps), e, src, st, note);
        });
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
        setLoadingPage(false);
        setPoolProgress('');
        setType('all');
        setSource('all');
        setSort('date');
        setMode('broad');
        setTab('search');
        setClmTotal(null);
        setClmMaxPage(null);
        setCurPage(1);
        setTotalPages(1);
        poolState.fullList = [];
        poolState.fullListKey = '';
        poolState.clmPool = [];
        poolState.clmPoolKey = '';
        poolState.allPool = [];
        poolState.allPoolKey = '';
        poolState.lastRows = [];
      };

      // 统计行：总数、当前区间、页码；「全部」来源额外说明结果池组成
      const shownTotal = source === 'clm'
        ? (clmTotal == null ? poolState.lastRows.length : Math.min(clmTotal, CLM_MAX_TOTAL))
        : (source === 'all'
          ? (poolState.allPool.length || poolState.fullList.length)
          : poolState.fullList.length);
      const from = results.length ? (curPage - 1) * pageSize + 1 : 0;
      const to = from ? from + results.length - 1 : 0;
      let statsText = '共 ' + shownTotal + ' 条 · 第 ' + from + '–' + to + ' 条 · 第 '
        + curPage + '/' + totalPages + ' 页';
      if (source === 'all') {
        const othersCount = poolState.allPool.filter((r) => r.source !== 'clm').length;
        const clmCount = poolState.allPool.length - othersCount;
        statsText += '（其它来源 ' + othersCount + ' 条 + 磁力猫并入 ' + clmCount + ' 条';
        if (clmTotal != null) {
          statsText += '，磁力猫共匹配 ' + clmTotal + ' 条（站点最多 '
            + (clmMaxPage || CLM_MAX_PAGE) + ' 页 / 约 ' + CLM_MAX_TOTAL + ' 条）';
        }
        statsText += '）';
      } else if (source === 'clm' && clmTotal != null) {
        statsText += '（磁力猫匹配 ' + clmTotal + ' 条，站点最多 '
          + (clmMaxPage || CLM_MAX_PAGE) + ' 页 / 约 ' + CLM_MAX_TOTAL + ' 条）';
      }
      if (source === 'clm' && sort === 'name') {
        statsText += ' · 该排序仅对当前页生效';
      }

      // 页码按钮：首页/末页 + 当前页 ±2 + 省略号；跳页输入框回车生效
      const pageButtons = () => {
        const nums = [];
        const push = (v) => { if (nums[nums.length - 1] !== v) nums.push(v); };
        push(1);
        for (let p = curPage - 2; p <= curPage + 2; p += 1) {
          if (p > 1 && p < totalPages) push(p);
        }
        if (totalPages > 1) push(totalPages);
        const buttons = [];
        for (let i = 0; i < nums.length; i += 1) {
          if (i > 0 && nums[i] - nums[i - 1] > 1) {
            buttons.push(h('span', {
              key: 'gap-' + i,
              style: { color: C.muted, fontSize: 13, padding: '0 2px' }
            }, '…'));
          }
          const cur = nums[i] === curPage;
          buttons.push(h('button', {
            key: 'pg-' + nums[i],
            onClick: () => loadPage(nums[i], {}),
            disabled: loadingPage,
            style: {
              minWidth: 32, padding: '6px 10px', borderRadius: 8, fontSize: 13,
              cursor: loadingPage ? 'default' : 'pointer',
              border: '1px solid ' + (cur ? C.brand : C.borderStrong),
              background: cur ? C.brand : C.layer,
              color: cur ? '#fff' : C.text,
              opacity: loadingPage ? 0.45 : 1
            }
          }, String(nums[i])));
        }
        return buttons;
      };

      const onJumpKey = (e) => {
        if (e.key !== 'Enter') return;
        const n = parseInt(e.target.value, 10);
        if (n >= 1) loadPage(n, {});
      };

      const pager = () => {
        if (!hasSearched || totalPages <= 1) return null;
        const btn = (label, page, disabled) => h('button', {
          onClick: () => loadPage(page, {}),
          disabled: !!disabled,
          style: {
            padding: '6px 10px', borderRadius: 8, fontSize: 13,
            cursor: disabled || loadingPage ? 'default' : 'pointer',
            border: '1px solid ' + C.borderStrong, background: C.layer, color: C.text,
            opacity: (disabled || loadingPage) ? 0.45 : 1
          }
        }, label);
        return h('div', {
          style: {
            display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
            justifyContent: 'center', margin: '18px 0 6px'
          }
        },
          btn('« 上一页', curPage - 1, curPage <= 1 || loadingPage),
          pageButtons(),
          btn('下一页 »', curPage + 1, curPage >= totalPages || loadingPage),
          h('span', { style: { fontSize: 12, color: C.muted, marginLeft: 8 } },
            '跳至 ',
            h('input', {
              onKeyDown: onJumpKey,
              type: 'number', min: 1, max: totalPages,
              placeholder: String(curPage),
              style: {
                width: 56, padding: '5px 8px', border: '1px solid ' + C.borderStrong,
                borderRadius: 8, fontSize: 12, textAlign: 'center',
                background: C.layer, color: C.text
              }
            }),
            ' 页')
        );
      };

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

      return h('div', { ref: containerRef, style: { padding: 16, height: '100%', overflow: 'auto', color: C.text } },
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

          h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 4 } }, '改「来源 / 类型 / 排序 / 搜索方式 / 每页条数」会重新搜索'),
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
              chip(label, type === v, () => {
                setType(v);
                if (hasSearched || query.trim()) runSearch(undefined, { type: v });
              })
            ),
            h('span', { style: { fontSize: 11, color: C.idle } }, '（磁力猫的类型按标题推断，可能不全）')
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 } },
            h('span', { style: { fontSize: 12, color: C.muted } }, '排序：'),
            SORT_OPTIONS.map(([v, label]) =>
              chip(label, sort === v, () => {
                setSort(v);
                if (hasSearched || query.trim()) runSearch(undefined, { sort: v });
              })
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
            }, loading, '标题必须同时包含全部关键词'),
            h('span', { style: { fontSize: 12, color: C.muted, marginLeft: 8 } }, '每页：'),
            h('select', {
              value: String(pageSize),
              onChange: (e) => {
                const v = parseInt(e.target.value, 10);
                if (PAGE_SIZES.indexOf(v) < 0) return;
                setPageSize(v);
                savePageSize(v);
                if (hasSearched || query.trim()) runSearch(undefined, { pageSize: v });
              },
              style: {
                padding: '5px 8px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                border: '1px solid ' + C.borderStrong, background: C.layer, color: C.text
              }
            },
              PAGE_SIZES.map((n) => h('option', { key: n, value: String(n) }, n + ' 条'))
            ),
            h('span', { style: { fontSize: 11, color: C.muted } },
              hasSearched ? ('第 ' + curPage + '/' + totalPages + ' 页') : '')
          ),

          notice && h('div', {
            style: { marginBottom: 10, padding: '8px 12px', borderRadius: 8, background: C.layer2, border: '1px solid ' + C.border, color: C.warn, fontSize: 12 }
          }, notice),

          error && h('div', {
            style: { marginBottom: 10, padding: '8px 12px', borderRadius: 8, background: C.layer2, border: '1px solid ' + C.err, color: C.err, fontSize: 12 }
          }, error),

          loading && !poolProgress && h('div', { style: { textAlign: 'center', padding: 20, color: C.muted } }, '搜索中…'),

          poolProgress && h('div', { style: { textAlign: 'center', padding: 20, color: C.muted } },
            '搜索中…' + poolProgress),

          !loading && !error && !hasSearched && homePanel,

          !loading && !error && hasSearched && results.length === 0 && h('div', {
            style: { textAlign: 'center', padding: 24, color: C.muted, fontSize: 13 }
          }, '没有找到「' + query + '」相关的资源。可换个关键词、切到「全部」来源，或把搜索方式改成「广泛」。'),

          !loading && results.length > 0 && h('div', {},
            h('div', { style: { fontSize: 12, color: C.muted, marginBottom: 8 } }, statsText),
            results.map((r, i) => card(r, (r.id || 'idx') + '-' + i)),
            pager()
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

    // 侧栏面板由两处注册组成：panellist 放图标（props: size/active），main 放面板本体（按 key 对应）。
    function BtSearchIcon({ size = 18, active = false }) {
      return h('span', {
        'aria-hidden': true,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: size, height: size, lineHeight: 1, opacity: active ? 1 : 0.85
        }
      }, h('svg', {
        width: Math.round(size * 0.92), height: Math.round(size * 0.92),
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round'
      },
        h('path', { d: 'm6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15' }),
        h('path', { d: 'm5 8 4 4' }),
        h('path', { d: 'm12 15 4 4' })
      ));
    }

    const PANEL_ID = 'bt-search';

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: 'BT搜索',
        }, BtSearchIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID,
        }, BtSearchPanel));
      },
    };
  },
});
