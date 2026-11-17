# 数据源说明

本文记录每个数据源的接口形态与实测结论。所有结论都用本仓库的采集代码对线上站点验证过。

## 磁力猫（Cilimao）

`clm17.vip` 是 **磁力猫 v3.0**（`cilimao.app`，页面页脚 `磁力猫 v3.0`）的一个镜像域名。它**不是聚合站**：结果来自自己的 BT 索引（首页称"热门资源一天内索引"，详情页有"浏览次数""最近下载"等自有字段，结果里没有第三方来源标识）。

### 搜索

```
GET https://<host>/search?word=<base64(关键词)>&sort=time|hits|length|rele&p=<页码>
```

- `word` 必须是关键词 UTF-8 字节的 **标准 base64**，并做 URL 编码；直接传中文不起作用。
- `p` 从 1 起，每页 12 条。
- `sort`：`time` 最新、`hits` 热门、`length` 大小、`rele` 相关度。采集端固定用 `time`，保证翻页集合稳定，排序交给前端。
- 总数在页面文本「找到关键词相关结果 N 个」里；`尾页` 链接实测指向 **`p=80`**，即单次搜索最多只能翻 80 页（约 960 条），即使总数更多也取不到后面的。
- 采集端默认**并行取 5 页 = 60 条**（第 1 页串行过验证门，其余页最多 4 路并发）；界面「加载更多」每次再追加 5 页，直到第 80 页。单页失败只记录提示，不影响已取到的结果。

### 人机验证门

首次访问会返回"验证页面/Verification Page"，其内联脚本点击后执行：

```js
fetch("", { method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: "act=challenge" })
  .then(r => r.json())
  .then(a => a.code === 1 ? location.reload() : alert(a.msg));
```

所以程序化通过方式就是：`GET`（拿到会话 cookie）→ `POST 同一个 URL` 且 body 为 `act=challenge`（返回 `{"code":1}`）→ 再次 `GET` 即返回正常页面。会话 cookie（`server_name_session`，24 小时）内后续请求不再触发验证。实测首次约 2.6 s（含过门），之后约 0.9 s。

### 结果页结构

```html
<ul id="Search_list_wrapper">
  <li>
    <a href="/information/<32位小写ID>" class="SearchListTitle_result_title">
      <em>奥</em><em>德</em><em>赛</em>.The.Odyssey.2026...
    </a>
    <div class="Search_list_info">
      <span class="Search_result_type"><i …></i>32</span>
      <em>文件大小：</em>90.46 GB
      <em>创建时间：</em>2026-11-17
      <em>文件格式：</em>.iso
    </div>
  </li>
</ul>
```

- 标题里的 `<em>` 是关键词高亮，需要去标签。
- 总数在 `找到<b>关键词</b>相关结果73个` 中；无结果时页面是 `div#No_result_container`。

### 关键捷径：ID 就是 infohash 的 base32

`/information/<ID>` 里的 32 位小写 ID 是 infohash 的 **base32（RFC 4648，字母表 A-Z2-7）**编码，32 字符 × 5 bit = 160 bit = 20 字节：

```
4fyv3fcx45tvpf5ezg4rgtzlkyrptcjt
  → E1715D9457E7675797A4C9B9134F2B5622F98933
```

已用该条目的详情页真实磁力链接交叉验证一致。**因此列表页一次请求就能拿到全部磁力链接**，不需要为每条结果再请求详情页（否则每页要多发 12 个请求）。

### 语义与限制

- 多关键词是 **AND**：`奥德赛 2160p` 返回 10 条，标题全部含 `2160p`。服务端没有 OR 能力，所以"广泛"模式只能退化为只发最长的一个分词。
- 中文索引；纯英文关键词经常 0 结果。
- 镜像实测：`clm17.vip`（有验证门，v3.0）、`clm9.in`（无验证门，v3.0，同一索引）。`clm.cc`、`clm.la`、`cilimao.biz` 已不是 v3.0 前端，不可用。
- 三个域名都不返回 `Access-Control-Allow-Origin`，浏览器不能直连 —— 这是插件必须有 Host 侧代理的原因。

## 动漫花园聚合（Anime Garden）

```
GET https://api.animes.garden/resources?search=<关键词>&limit=50&types=<类型>
```

- 响应是 `{ resources: [...] }`，条目字段：`title / type / size(字节) / createdAt / provider / providerId / magnet / href / publisher.name`（没有 `publishedAt`、`sizeBytes`、`torrent`）。
- 该接口返回 `Access-Control-Allow-Origin: *`，浏览器可以直连，因此也是 Host 代理不可用时的兜底路径。
- `types` 为真实枚举：动画 / 漫画 / 音乐 / 日剧 / RAW / 合集 / 特摄 / 游戏 / 其他。
