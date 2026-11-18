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
- **Pagination**: selectable page size (10 / 20 / 50 / 100, default 20, remembered) with a web-style pager below the list (previous / next / page numbers / jump-to-page). The "all" source fetches every source in parallel and merges the top 240 磁力猫 results into one globally sorted list, so each page mixes sources; the site's own match count and its 80-page (~960) ceiling are shown above the list.
- In-memory response cache with a 60 s TTL and a 25 s request timeout.

## Desktop client

The same search engine is also available as a standalone Windows app in [desktop/](desktop/README.md)
(no DSH required), with extra sources (磁力猫, Anime Garden, Nyaa, The Pirate Bay, EZTV, BTDig):

- **Installer** (Windows 10/11 x64, per-user install, no admin rights):
  [BT-Search-Setup-1.2.2-win64.exe](https://github.com/QIU-KKKK/DeepSeek-Harness-BT-/releases/download/v1.2.2/BT-Search-Setup-1.2.2-win64.exe)
  — installs to `%LOCALAPPDATA%\Programs\BT搜索`, creates desktop / Start-menu shortcuts and
  an uninstall entry, and imports the bundled self-signed certificate by default so the app
  itself no longer trips SmartScreen. The installer may still show one "unknown publisher"
  prompt on first run (More info → Run anyway).
- **Portable**: [BT-Search-Portable-1.2.2-win64.zip](https://github.com/QIU-KKKK/DeepSeek-Harness-BT-/releases/download/v1.2.2/BT-Search-Portable-1.2.2-win64.zip)
  — unzip anywhere and run `BT搜索\BT搜索.exe`.

SHA256: `5B4F99160BF6B2A1591A64BB5B89F081822B57B70DAABF006069B066BADB7F5D` (installer),
`AFE7A775EA002C3AA6F35214433CF24A58946452FAB07AB2706157E111D5946E` (portable zip).

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
| `desktop/` | Standalone Windows desktop client sources and installer build scripts (see [desktop/README.md](desktop/README.md)). |
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
- **分页**：每页条数可选（10 / 20 / 50 / 100，默认 20，记忆上次选择），结果下方为网页式翻页（上一页 / 下一页 / 页码 / 跳页）；「全部」来源并行抓取各来源并把磁力猫前 240 条并入同一个列表全局排序，每页天然混合各来源，结果上方显示站点匹配总数与 80 页（约 960 条）上限。
- 60 秒内存缓存与 25 秒请求超时。

### 桌面客户端

同一套搜索能力另有独立 Windows 桌面版（不依赖 DSH，来源更多：磁力猫 / 动漫花园 / Nyaa / The Pirate Bay / EZTV / BTDig），源码与构建脚本见 [desktop/](desktop/README.md)：

- **安装版**（Win10/11 x64，装到当前用户目录，无需管理员）：
  [BT-Search-Setup-1.2.2-win64.exe](https://github.com/QIU-KKKK/DeepSeek-Harness-BT-/releases/download/v1.2.2/BT-Search-Setup-1.2.2-win64.exe)
  —— 安装到 `%LOCALAPPDATA%\Programs\BT搜索`，自动创建桌面 / 开始菜单快捷方式与卸载项，
  并默认导入随包证书，装完后程序运行不再被 SmartScreen 拦截（安装器自身首次运行仍可能提示一次
  「未知发布者」，点「更多信息 → 仍要运行」即可）。
- **便携版**：[BT-Search-Portable-1.2.2-win64.zip](https://github.com/QIU-KKKK/DeepSeek-Harness-BT-/releases/download/v1.2.2/BT-Search-Portable-1.2.2-win64.zip)
  —— 解压到任意目录，双击 `BT搜索\BT搜索.exe`。

SHA256：安装包 `5B4F99160BF6B2A1591A64BB5B89F081822B57B70DAABF006069B066BADB7F5D`，
便携包 `AFE7A775EA002C3AA6F35214433CF24A58946452FAB07AB2706157E111D5946E`。

### 数据怎么来的

浏览器无法直连磁力猫（该站不返回 CORS 头），因此插件的 Host 半在 DSH 进程内抓取两个上游，再通过同源只读路由 `/plugins/dsh-plugin-bt-search/search` 交给页面。接口细节见 [docs/SOURCES.md](docs/SOURCES.md)。

### 边界

- 磁力猫有「点击访问」人机验证，Host 半自动完成；失败时只有该来源报错，另一来源照常返回。
- 磁力猫每页 12 条，单次搜索最多可翻 80 页（约 960 条），且是中文索引，纯英文关键词常常没有结果。
- 磁力猫服务端是 AND 语义，因此广泛模式只发最长的一个关键词，与动漫花园的 OR 不同。
- 磁力链接交由系统默认 BT 客户端处理，插件不下载文件、不保存任何凭据。
- Host 半改动需要重启一次 DSH 才生效；未生效时面板回退到动漫花园直连。
