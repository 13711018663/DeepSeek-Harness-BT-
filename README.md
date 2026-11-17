# BT search

A BT / magnet resource search panel in the DeepSeek Harness sidebar. It aggregates two sources:

- **磁力猫 / Cilimao** (`cilimao.app` v3.0, served on `clm17.vip` with `clm9.in` as a mirror) — a Chinese BT index with fast indexing of new releases.
- **Anime Garden** — aggregates 动漫花园 (dmhy), 蜜柑计划 (Mikan), 萌番组 (Moe) and ANi.

## Features

- **Search** over both sources, with a source switch (all / Anime Garden / 磁力猫).
- **Broad / precise matching**: broad returns a resource when any word matches; precise requires every word in the title.
- **Type filter** (anime / manga / music / TV drama / RAW / batch / tokusatsu / game), sorting by publish time, size or name.
- **Result cards** with type, formatted size, publish date, file count, file format, source site and publisher, and "magnet link", "copy magnet" and "detail page" actions.
- **History and favorites**: the last 20 searches are kept and can be cleared; favorites are de-duplicated by title and stored in the browser.
- **Multi-page results**: 磁力猫 pages its index at 12 items per page. The panel fetches 5 pages (60 results) up front and offers *load more* up to the site's 80-page ceiling (~960 results); the site's own match count is shown above the list.
- In-memory response cache with a 60 s TTL and an 18 s request timeout.

## How the data is fetched

The browser cannot call 磁力猫 directly: the site sends no CORS headers. The plugin's Host half therefore fetches both upstreams inside the DSH process and answers one same-origin read-only route, `/plugins/dsh-plugin-bt-search/search`, which the panel calls. Interface details are documented in [docs/SOURCES.md](docs/SOURCES.md).

## Limitations

- 磁力猫 sits behind a click gate. The Host half passes it automatically (`POST act=challenge`); when that fails only this source reports an error and the other source still answers.
- 磁力猫 pages its index at 12 items (at most 80 pages / ~960 results per search), and its index is Chinese-only, so an English keyword often finds nothing.
- 磁力猫 matches all words (AND). Broad mode therefore sends only the longest word, unlike Anime Garden's OR behaviour.
- Magnet links are handed to the system default BitTorrent client. The plugin does not download anything itself and stores no credentials.
- A Host-half change needs one DSH restart to take effect; until then the panel falls back to the Anime Garden endpoint directly.

## Package layout

| File | Purpose |
| --- | --- |
| `index.js` | Host entry: registers the same-origin search route. |
| `sources.js` | Source adapters (Anime Garden, 磁力猫) and the aggregation. |
| `client.js` | Client module registered as `dsh-plugin-bt-search`; registers the `sidebar.panellist` icon and the `main` panel. |
| `cordis.patch.yml` | Bundle patch inserting the `bt-search` row. |
| `locale/en.json`, `locale/zh.json` | Plugin title, description and detail document for each locale. |
| `docs/DETAIL.md`, `docs/DETAIL.en.md` | Detail pages shown in the plugin manager. |
| `docs/SOURCES.md` | Data-source notes: endpoints, the click gate, and the info-hash shortcut. |
| `icon.svg` | Plugin icon. |

## Development

No build step: `client.js` is the shipped browser artifact and registers a lazy factory whose id equals the package name. After editing, reinstall the bundle and refresh the page; a Host-half change additionally needs a DSH restart.

```sh
# syntax check
node --check client.js && node --check index.js && node --check sources.js
```

## License

MIT — see [LICENSE](LICENSE).

---

## 中文

在 DSH 左侧栏提供 BT / 磁力资源搜索面板，聚合两个来源：

- **磁力猫**（`cilimao.app` v3.0，主域 `clm17.vip`，备用镜像 `clm9.in`）——中文 BT 索引，新片索引快。
- **动漫花园聚合**（Anime Garden）——聚合 动漫花园 / 蜜柑计划 / 萌番组 / ANi。

### 功能

- 两个来源统一搜索，来源可切「全部 / 动漫花园 / 磁力猫」。
- **广泛 / 精准**：广泛为任一关键词命中；精准要求标题包含全部关键词。
- 类型筛选（动画 / 漫画 / 音乐 / 日剧 / RAW / 合集 / 特摄 / 游戏），按发布时间、大小、名称排序。
- 结果卡片展示类型、大小、发布时间、文件数、文件格式、来源站点与发布者，并提供磁力链接、复制磁力、详情页。
- 搜索历史（保留 20 条，可清空）与收藏（按标题去重），保存在浏览器 `localStorage`。
- **多页结果**：磁力猫按每页 12 条分页，面板首屏并行取 5 页（60 条），并提供「加载更多」继续追加，直到站点上限 80 页（约 960 条）；结果上方显示站点给出的匹配总数。
- 60 秒内存缓存与 18 秒请求超时。

### 数据怎么来的

浏览器无法直连磁力猫（该站不返回 CORS 头），因此插件的 Host 半在 DSH 进程内抓取两个上游，再通过同源只读路由 `/plugins/dsh-plugin-bt-search/search` 交给页面。接口细节见 [docs/SOURCES.md](docs/SOURCES.md)。

### 边界

- 磁力猫有「点击访问」人机验证，Host 半自动完成；失败时只有该来源报错，另一来源照常返回。
- 磁力猫每页 12 条，单次搜索最多可翻 80 页（约 960 条），且是中文索引，纯英文关键词常常没有结果。
- 磁力猫服务端是 AND 语义，因此广泛模式只发最长的一个关键词，与动漫花园的 OR 不同。
- 磁力链接交由系统默认 BT 客户端处理，插件不下载文件、不保存任何凭据。
- Host 半改动需要重启一次 DSH 才生效；未生效时面板回退到动漫花园直连。
