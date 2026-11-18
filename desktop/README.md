# BT搜索 桌面客户端 / Desktop client

与 DSH 插件同源的 Windows 桌面版：本机 HTTP 服务 + 内嵌网页界面，不依赖 DeepSeek Harness，
装了就能用。数据源在插件版（磁力猫 + 动漫花园）基础上多了 Nyaa、The Pirate Bay、EZTV、BTDig。

## 直接下载（推荐）

| 版本 | 下载 | 说明 |
| --- | --- | --- |
| 安装版 | `BT-Search-Setup-1.2.2-win64.exe`（见 Release 资产） | 安装到 `%LOCALAPPDATA%\Programs\BT搜索`，**无需管理员权限**；创建桌面/开始菜单快捷方式；可在「设置 → 应用」卸载 |
| 便携版 | `BT-Search-Portable-1.2.2-win64.zip`（见 Release 资产） | 解压到任意目录，双击 `BT搜索\BT搜索.exe` |

- 双击 exe 后自动用默认浏览器打开搜索界面（本机 `http://127.0.0.1:17650/`，端口区间 17650–17689）
- 首次运行若被 SmartScreen 拦住：点「更多信息 → 仍要运行」；或先运行包内的 `一键信任.cmd` 导入随包证书
- 关闭浏览器页面后约 90 秒自动退出；不写开机启动、不收集数据

## 源码运行

需要 Python 3.12（仅标准库，无第三方依赖）：

```bat
cd desktop
python server.py
```

服务只监听 `127.0.0.1`，自动打开浏览器。

## 构建安装包

```bat
cd desktop
python -m venv venv
venv\Scripts\pip install pyinstaller pillow

:: 1) onedir 打包（产物 desktop\dist\BT搜索\）
venv\Scripts\python -m PyInstaller --noconfirm --onedir --windowed --name "BT搜索" ^
  --icon icon.ico --add-data "index.html;." server.py

:: 2) 编译 NSIS 安装包（需要 makensis：PATH 或环境变量 BT_MAKENSIS）
venv\Scripts\python installer\build_setup.py
::    产物：release\BT搜索-1.2.2-win64-setup.exe
::    本机若有 CN=BT搜索 的代码签名证书会自动签名，没有则保持未签名并提示

:: 3) 端到端验收（静默安装 → 启动并检查 HTTP → 卸载清理）
venv\Scripts\python installer\verify_setup.py
```

说明：

- PyInstaller 的 `--onefile` 在部分 Windows 环境会因临时目录问题启动失败，因此统一用 `--onedir`
- 安装器用 NSIS 编译（`installer/bt-search.nsi`）；界面为简体中文，安装范围为当前用户
- `desktop/dist/`、`desktop/installer/payload/`、`desktop/installer/out/`、`release/` 都是构建产物，已被 `.gitignore` 忽略

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `server.py` | 本机 HTTP 服务：静态页 + `/api/search` 多源聚合（磁力猫 / 动漫花园 / Nyaa / TPB / EZTV / BTDig） |
| `index.html` | 搜索界面（分页、筛选、排序、历史、收藏） |
| `icon.ico` | 程序与快捷方式图标 |
| `BT搜索.cer` | 自签代码签名证书（仅公钥，用于手动导入信任） |
| `installer/bt-search.nsi` | NSIS 安装脚本（等待页/组件/目录/完成 + 卸载） |
| `installer/build_setup.py` | 组装 payload、编译安装器、签名 |
| `installer/verify_setup.py` | 安装/卸载端到端验收脚本 |

## English

Standalone Windows desktop build of the same search engine as the DSH plugin (local HTTP
server + embedded web UI). Download `BT-Search-Setup-1.2.2-win64.exe` (per-user install,
no admin rights) or the portable zip from the release assets, or run `python server.py`
with Python 3.12. Sources: 磁力猫, Anime Garden, Nyaa, The Pirate Bay, EZTV and BTDig.
The UI opens at `http://127.0.0.1:17650/` (ports 17650–17689). Build with PyInstaller
(`--onedir`) and `installer/build_setup.py` (needs `makensis`).
