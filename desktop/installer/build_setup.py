# -*- coding: utf-8 -*-
"""Build the BT搜索 Windows installer (NSIS) and sign it.

Usage:  python build_setup.py

Steps:
  1. assemble payload/ (desktop/dist/BT搜索/* + 使用说明.txt + 一键信任.cmd + BT搜索.cer + icon.ico)
  2. run makensis (from PATH, or set BT_MAKENSIS to a portable makensis.exe)
  3. move out/btsearch-setup.exe -> <repo>/release/BT搜索-1.2.2-win64-setup.exe
  4. sign with the author's self-signed code-signing cert (skipped when absent)

Prereqs: `pyinstaller --noconfirm --onedir --windowed --name "BT搜索" --icon icon.ico
--add-data "index.html;." server.py` run inside desktop/ produces desktop/dist/BT搜索/.
Everything is written under desktop/installer/ or release/ (both gitignored).
"""
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))     # <repo>/desktop/installer
DESKTOP = os.path.dirname(HERE)                        # <repo>/desktop
ROOT = os.path.dirname(DESKTOP)                        # <repo>
DIST = os.path.join(DESKTOP, 'dist', 'BT搜索')
WEB = DESKTOP
PAYLOAD = os.path.join(HERE, 'payload')
OUT_DIR = os.path.join(HERE, 'out')
MAKENSIS = os.environ.get('BT_MAKENSIS') or shutil.which('makensis') or 'makensis'
SETUP_NAME = 'BT搜索-1.2.2-win64-setup.exe'
SETUP_PATH = os.path.join(ROOT, 'release', SETUP_NAME)
THUMBPRINT = os.environ.get('BT_CERT_THUMB', 'EC1B1478D534BBE9BD3488082EE89CCE000FF5D5')
VERSION = '1.2.2'

README = """BT搜索  v1.2.2  安装版
适用于 Windows 10 / 11（64 位）
============================================

【怎么用】
1. 双击安装包（BT搜索-1.2.2-win64-setup.exe），按提示下一步即可；
   默认安装到 %LOCALAPPDATA%\\Programs\\BT搜索（当前用户目录，不需要管理员权限）。
2. 安装完成后桌面和开始菜单会有「BT搜索」快捷方式，双击即可启动，
   程序会自动用默认浏览器打开搜索界面。
3. 首次运行如果被 SmartScreen 拦住（「Windows 已保护你的电脑」），
   点「更多信息」→「仍要运行」。安装器已导入随包证书时不会再拦；
   如果仍然拦，可双击安装目录里的 一键信任.cmd 手动导入。

【卸载】
· 开始菜单 → BT搜索 → 卸载 BT搜索；或
· Windows 设置 → 应用 → 已安装的应用 → BT搜索 → 卸载。

【环境要求】
· Windows 10 / 11，64 位系统（32 位系统跑不了）。
· 不需要安装 Python，运行时和依赖库已随包附带。
· 需要能上网；程序只在本机监听 127.0.0.1 的 17650-17689 端口。
· 磁力链接交给系统默认下载器（迅雷 / BitComet / qBittorrent 等）。

【常见问题】
· 双击后没反应 / 没有浏览器弹出：
  1) 看看任务管理器里有没有 BT搜索.exe 在跑：有的话程序其实已经起来，
     手动把 http://127.0.0.1:17650/ 粘到浏览器即可；
  2) 也可以右键 BT搜索.exe → 以管理员身份运行。
· 杀毒软件报毒：PyInstaller + 自签签名的程序较常见误报，添加信任/白名单即可。
  本程序只做本机搜索转发，不设开机启动、不改系统设置。
· 提示「缺少页面资源 index.html」：_internal 文件夹被删或损坏，重新运行安装包覆盖安装即可。
· 提示「端口区间被占用」：关掉占用 17650-17689 端口的程序再试。

【安装目录里的文件】
  BT搜索.exe        主程序（已签名）
  _internal\\        运行时与页面资源（不要删除或移动）
  uninstall.exe     卸载程序
  一键信任.cmd      手动导入证书（可选）
  BT搜索.cer        自签代码签名证书
  使用说明.txt      本文件
"""

TRUST_CMD = """@echo off\r
chcp 936 >nul\r
setlocal\r
echo ==============================================\r
echo   BT搜索 - 一键信任（消除 SmartScreen 拦截）\r
echo ==============================================\r
echo.\r
echo [1/2] 导入代码签名证书到「受信任根」（当前用户，无需管理员）...\r
certutil -addstore -user Root "%~dp0BT搜索.cer"\r
echo.\r
echo [2/2] 解除文件阻止（去除「标记来自互联网」）...\r
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath '%~dp0BT搜索.exe','%~dp0BT搜索.cer','%~dp0一键信任.cmd'"\r
echo.\r
echo 完成！现在双击 BT搜索.exe 不会再弹出 SmartScreen 红色拦截。\r
echo 若仍提示，请右键 BT搜索.exe - 属性 - 勾选「解除锁定」。\r
echo.\r
pause\r
"""


def fail(msg):
    print('[FAIL] ' + msg)
    raise SystemExit(1)


def assemble_payload():
    if not os.path.isdir(DIST):
        fail('dist folder missing: %s' % DIST)
    if not os.path.isfile(os.path.join(DIST, 'BT搜索.exe')):
        fail('dist BT搜索.exe missing')
    if os.path.isdir(PAYLOAD):
        shutil.rmtree(PAYLOAD)
    os.makedirs(PAYLOAD)

    # 1) program files keep the onedir layout (exe + _internal)
    for name in sorted(os.listdir(DIST)):
        src = os.path.join(DIST, name)
        dst = os.path.join(PAYLOAD, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)

    # 2) docs / cert / icon for the script
    with open(os.path.join(PAYLOAD, '使用说明.txt'), 'wb') as fh:
        fh.write(README.replace('\n', '\r\n').encode('utf-8-sig'))
    with open(os.path.join(PAYLOAD, '一键信任.cmd'), 'wb') as fh:
        fh.write(TRUST_CMD.encode('gbk'))

    cert = os.path.join(WEB, 'BT搜索.cer')
    if not os.path.isfile(cert):
        fail('cert missing: %s' % cert)
    shutil.copy2(cert, os.path.join(PAYLOAD, 'BT搜索.cer'))

    icon = os.path.join(WEB, 'icon.ico')
    if not os.path.isfile(icon):
        fail('icon missing: %s' % icon)
    shutil.copy2(icon, os.path.join(HERE, 'icon.ico'))

    files = []
    for root, dirs, names in os.walk(PAYLOAD):
        dirs.sort()
        for name in sorted(names):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, PAYLOAD).replace('\\', '/')
            files.append((rel, os.path.getsize(full)))
    total = sum(size for _, size in files)
    print('[payload] %d files, %.2f MB' % (len(files), total / 1024.0 / 1024.0))
    return files


def ensure_script_bom(path):
    """NSIS 3 需要 BOM 才能把 .nsi 当 UTF-8 读取（否则报 Bad text encoding）。"""
    with open(path, 'rb') as fh:
        raw = fh.read()
    if raw.startswith(b'\xef\xbb\xbf'):
        return
    with open(path, 'wb') as fh:
        fh.write(b'\xef\xbb\xbf' + raw)
    print('[nsi] utf-8 BOM added')


def build():
    if not (os.path.isfile(MAKENSIS) or shutil.which(MAKENSIS)):
        fail('makensis not found: set BT_MAKENSIS or put makensis on PATH')
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(SETUP_PATH), exist_ok=True)
    out_exe = os.path.join(OUT_DIR, 'btsearch-setup.exe')
    if os.path.exists(out_exe):
        os.remove(out_exe)

    script = os.path.join(HERE, 'bt-search.nsi')
    ensure_script_bom(script)
    # 不加 /NOCD：让 makensis 切到脚本目录，脚本里的相对路径（icon.ico、payload\）才对。
    result = subprocess.run([MAKENSIS, '/V2', script], capture_output=True)
    stdout = result.stdout.decode('gbk', 'replace')
    stderr = result.stderr.decode('gbk', 'replace')
    if result.returncode != 0:
        print(stdout)
        print(stderr)
        fail('makensis exit code %d' % result.returncode)
    tail = [line for line in (stdout + stderr).splitlines() if line.strip()]
    print('[makensis] ' + '\n[ makensis] '.join(tail[-12:]))

    if not os.path.isfile(out_exe):
        fail('setup.exe not produced')
    size = os.path.getsize(out_exe)
    if size < 5 * 1024 * 1024:
        fail('setup.exe too small: %d bytes' % size)

    # 新生成的 exe 可能被杀软临时占用，移动要带重试
    move_with_retry(out_exe, SETUP_PATH)
    print('[build] %s  %.2f MB' % (SETUP_PATH, size / 1024.0 / 1024.0))
    return SETUP_PATH


def move_with_retry(src, dst, tries=20, delay=0.5):
    for i in range(tries):
        try:
            if os.path.exists(dst):
                os.remove(dst)
            os.replace(src, dst)
            return
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(delay)


def _decode(raw):
    if not raw:
        return ''
    for enc in ('utf-8-sig', 'utf-8', 'gbk'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', 'replace')


def run_ps(code, **env_extra):
    """Run PowerShell, force UTF-8 output, decode robustly (console codepage varies)."""
    prefix = ('[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
              '$OutputEncoding = [Text.Encoding]::UTF8; ')
    env = dict(os.environ)
    env.update(env_extra)
    result = subprocess.run(
        ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', prefix + code],
        capture_output=True, env=env,
    )
    return _decode(result.stdout) + _decode(result.stderr)


def sign(path):
    code = (
        "$c = Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert | "
        "Where-Object { $_.Thumbprint -eq $env:BT_THUMB }; "
        "if (-not $c) { Write-Output 'NO_CERT'; exit 2 }; "
        "$r = Set-AuthenticodeSignature -LiteralPath $env:BT_OUT -Certificate $c -HashAlgorithm SHA256; "
        "Write-Output ('status=' + $r.Status); "
        "if ($r.Status -ne 'Valid') { if ($r.StatusMessage) { Write-Output ('message=' + $r.StatusMessage) } }"
    )
    out = ''
    for attempt in range(6):
        out = run_ps(code, BT_OUT=path, BT_THUMB=THUMBPRINT)
        if 'status=Valid' in out or 'NO_CERT' in out:
            break
        time.sleep(0.5)  # 刚写出的 exe 可能仍被扫盘进程占用，签名校验会短暂读不到
    print('[sign] ' + (out.strip() or '(no output)'))
    if 'NO_CERT' in out:
        print('[sign] certificate %s not in the current user store -> installer left unsigned'
              % THUMBPRINT)
        return False
    if 'status=Valid' not in out:
        fail('signature status is not Valid')
    return True


def verify(path):
    code = (
        "$s = Get-AuthenticodeSignature -LiteralPath $env:BT_OUT; "
        "Write-Output ('status=' + $s.Status); "
        "Write-Output ('signer=' + $s.SignerCertificate.Subject); "
        "Write-Output ('bytes=' + (Get-Item -LiteralPath $env:BT_OUT).Length)"
    )
    out = ''
    for attempt in range(6):
        out = run_ps(code, BT_OUT=path).strip()
        if 'status=Valid' in out:
            break
        time.sleep(0.5)
    print('[verify] ' + out.replace('\n', ' | '))
    if 'status=Valid' not in out:
        fail('setup exe signature verification failed')
    return out


def main():
    files = assemble_payload()
    path = build()
    signed = sign(path)
    if signed:
        verify(path)
    else:
        print('[verify] skipped (installer is not signed)')

    # self-check: payload files are newer than nothing weird; print expected names
    must = ['BT搜索.exe', '_internal/index.html', '使用说明.txt', '一键信任.cmd', 'BT搜索.cer']
    names = {rel for rel, _ in files}
    missing = [m for m in must if m not in names]
    if missing:
        fail('payload missing: %s' % missing)
    exe_size = os.path.getsize(os.path.join(PAYLOAD, 'BT搜索.exe'))
    print('[check] payload exe = %d bytes, version = %s' % (exe_size, VERSION))
    print('BUILD OK')


if __name__ == '__main__':
    main()
