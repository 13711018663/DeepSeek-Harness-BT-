# BT search

A BT / magnet resource search panel in the DeepSeek Harness sidebar. It aggregates two sources:

- **磁力猫 / Cilimao** (`cilimao.app` v3.0; `clm17.vip` primary, `clm9.in` mirror) — a Chinese BT index that picks up new releases quickly.
- **Anime Garden** — aggregates 动漫花园 (dmhy), 蜜柑计划 (Mikan), 萌番组 (Moe) and ANi.

## Features

- **Search** across both sources, with a source switch (all / Anime Garden / 磁力猫).
- **Broad / precise matching**: broad returns a resource when any word matches; precise requires every word to appear in the title.
- **Type filter**: all / anime / manga / music / TV drama / RAW / batch / tokusatsu / game.
- **Sorting**: publish time, file size, name.
- **Pagination**: page size is selectable (10 / 20 / 50 / 100, default 20, remembered) with a web-style pager below the list (previous / next / page numbers / jump-to-page); the "all" source fetches every source in parallel and merges the top 240 磁力猫 results into one globally sorted list, so every page mixes sources naturally.
- **Result cards**: type, formatted size, publish date, file count, file format, source site and publisher, with "magnet link", "copy magnet" and "detail page" actions.
- **History and favorites**: the last 20 searches are kept and can be cleared; favorites are de-duplicated by title and stored in the browser.
- **Back home**: clears the keyword and every filter and returns to the recent-search entry.

## How the data is fetched

The browser cannot call 磁力猫 directly because the site sends no CORS headers, so the plugin's Host half fetches both upstreams inside the DSH process and answers one same-origin read-only route, `/plugins/dsh-plugin-bt-search/search`. The endpoint, the click gate and the info-hash shortcut are documented in [SOURCES.md](SOURCES.md).

## Desktop client

The same search engine is also available as a standalone Windows desktop app (no DSH needed; extra
sources: 磁力猫, Anime Garden, Nyaa, The Pirate Bay, EZTV, BTDig).

- Installer `BT-Search-Setup-1.2.2-win64.exe`: per-user install without admin rights, with desktop /
  Start-menu shortcuts and an uninstall entry.
- Portable `BT-Search-Portable-1.2.2-win64.zip`: unzip and run.

Download from [GitHub Releases](https://github.com/QIU-KKKK/DeepSeek-Harness-BT-/releases/tag/v1.2.2);
sources and the installer build scripts live in the repository's `desktop/` folder.

## Limitations

- 磁力猫 pages its index at 12 items per page and caps a search at 80 pages (~960 results); the API fetches offset/limit windows (up to 120 items per request, the first page serially past the click gate and the rest 4-way parallel). The single-source view can page through all 960; the "all" source merges the top 240 for speed, and the stats line says so.
- 磁力猫 is a Chinese index, so a pure English keyword often finds nothing.
- 磁力猫 matches all words (AND), so broad mode sends only the longest word — different from Anime Garden's OR behaviour.
- The Host half needs one DSH restart after an update; until then the panel falls back to Anime Garden directly and says so.
- Magnet links are handed to the system default BitTorrent client; the plugin never downloads files itself and stores no credentials.
- The panel interface is in Chinese.
