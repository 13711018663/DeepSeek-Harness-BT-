# DeepSeek Harness BT Search

A BT / magnet resource search panel for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web sidebar. It searches the public [Anime Garden](https://animes.garden) index, which aggregates 动漫花园 (dmhy), 蜜柑计划 (Mikan), 萌番组 (Moe) and ANi.

[中文说明](#中文)

## Install

```sh
dsh plugin --profile desktop add github:13711018663/DeepSeek-Harness-BT-
```

Restart the host or reload the profile, then open the **BT搜索** tab in the sidebar. The plugin is Web-only (`dsh.client.platform: "web"`).

## What it does

- Keyword search over the Anime Garden resource index, 50 results per query.
- **Broad / precise matching**: broad returns a resource when any word matches; precise requires every word in the title.
- Type filter (anime / manga / music / TV drama / RAW / batch / tokusatsu / game), sorting by publish time, size or name.
- Result cards with type, formatted size, publish date, source site, publisher, magnet link, copy-magnet and detail-page actions.
- Search history (last 20, clearable) and favorites (de-duplicated by title), stored in `localStorage`.
- In-memory response cache with a 60 s TTL and a 10 s request timeout.

## Limitations

- **One data source.** The panel calls the Anime Garden API directly from the browser because that endpoint sends `Access-Control-Allow-Origin: *`. Nyaa, The Pirate Bay and BTDig do not allow cross-origin requests from a Web page, so they are not searchable from the plugin.
- Magnet links are handed to the system default BitTorrent client. The plugin does not download anything itself and stores no credentials.
- The panel interface is in Chinese.

## Package layout

| File | Purpose |
| --- | --- |
| `index.js` | Host entry: `export function apply() {}` — the plugin only contributes browser UI. |
| `client.js` | Client module registered as `dsh-plugin-bt-search`; injects the `sidebar.panellist` slot. |
| `cordis.patch.yml` | Bundle patch inserting the `bt-search` row. |
| `locale/en.json`, `locale/zh.json` | Plugin title, description and detail document for each locale. |
| `docs/DETAIL.md`, `docs/DETAIL.en.md` | Detail pages shown in the plugin manager. |
| `icon.svg` | Plugin icon. |

## Development

No build step: `client.js` is the shipped browser artifact and registers a lazy factory whose id equals the package name (`dsh-plugin-bt-search`). After editing, reinstall the bundle and refresh the page.

```sh
# syntax check
node --check client.js
```

## License

MIT — see [LICENSE](LICENSE).

---

## 中文

在 DSH 左侧栏提供 BT / 磁力资源搜索面板，数据来自动漫花园聚合索引（Anime Garden，聚合 动漫花园 / 蜜柑计划 / 萌番组 / ANi）。

### 安装

```sh
dsh plugin --profile desktop add github:13711018663/DeepSeek-Harness-BT-
```

安装后重启宿主或重载 profile，在左侧栏打开 **BT搜索** 面板。本插件仅支持 Web（`dsh.client.platform: "web"`）。

### 功能

- 关键词搜索，单次返回 50 条。
- **广泛 / 精准**：广泛为任一关键词命中；精准要求标题包含全部关键词。
- 类型筛选（动画 / 漫画 / 音乐 / 日剧 / RAW / 合集 / 特摄 / 游戏），按发布时间、大小、名称排序。
- 结果卡片展示类型、大小、发布时间、来源站点与发布者，并提供磁力链接、复制磁力、详情页。
- 搜索历史（保留 20 条，可清空）与收藏（按标题去重），保存在浏览器 `localStorage`。
- 60 秒内存缓存与 10 秒请求超时。

### 边界

- **单一数据源**：面板在浏览器内直连 Anime Garden（该接口返回 `Access-Control-Allow-Origin: *`）。Nyaa、The Pirate Bay、BTDig 不允许跨域，网页端无法直连。
- 磁力链接交由系统默认 BT 客户端处理，插件不下载文件、不保存任何凭据。
- 界面文案为中文。
