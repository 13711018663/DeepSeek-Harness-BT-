# BT search

A BT / magnet resource search panel in the DeepSeek Harness sidebar. It queries the public [Anime Garden](https://animes.garden) index, which aggregates 动漫花园 (dmhy), 蜜柑计划 (Mikan), 萌番组 (Moe) and ANi.

## Features

- **Search**: type a keyword and press Enter.
- **Broad / precise matching**: broad returns a resource when any word matches; precise requires every word to appear in the title.
- **Type filter**: all / anime / manga / music / TV drama / RAW / batch / tokusatsu / game.
- **Sorting**: publish time, file size, name.
- **Result cards**: type, formatted size, publish date, source site and publisher, with "magnet link", "copy magnet" and "detail page" actions.
- **History and favorites**: the last 20 searches are kept and can be cleared; favorites are de-duplicated by title and stored in the browser.

## Limitations

- The panel fetches Anime Garden directly from the browser because that API allows cross-origin requests, so Anime Garden is the only data source. Nyaa, The Pirate Bay and BTDig do not allow cross-origin requests and are blocked by the browser.
- Magnet links are handed to the system default BitTorrent client; the plugin never downloads files itself.
- The panel interface is in Chinese.
