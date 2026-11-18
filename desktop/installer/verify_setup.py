# -*- coding: utf-8 -*-
"""End-to-end acceptance test for release\\BT搜索-1.2.2-win64-setup.exe.

Build the installer first (build_setup.py) and make sure desktop/dist/BT搜索 exists.
The setup exe is copied to %TEMP% before it runs, because launching packed exes from
a restricted/network path can hang; on a normal local disk the copy is harmless.

Test 1: silent install to a temp dir -> file/signature/registry assertions
        -> launch app (--no-browser) -> HTTP assertions -> kill
        -> silent uninstall -> cleanup assertions
Test 2: shortcut install (desktop + start menu) -> assertion -> uninstall
        -> assertion -> restore the pre-existing desktop shortcut

Prints a summary and exits 0 only when every check passes.
"""
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import winreg

HERE = os.path.dirname(os.path.abspath(__file__))   # <repo>/desktop/installer
DESKTOP = os.path.dirname(HERE)                      # <repo>/desktop
ROOT = os.path.dirname(DESKTOP)                      # <repo>
SETUP = os.path.join(ROOT, 'release', 'BT搜索-1.2.2-win64-setup.exe')
DIST = os.path.join(DESKTOP, 'dist', 'BT搜索')
TEMP = os.environ.get('LOCALAPPDATA', os.path.expanduser('~')) + r'\Temp'
BASE = os.path.join(TEMP, 'bt-setup-test')
INSTALL = os.path.join(BASE, 'install')
INSTALL2 = os.path.join(BASE, 'install2')
UNINST_KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\BT搜索'
APP_EXE = 'BT搜索.exe'
PORT_RANGE = range(17650, 17690)
DESKTOP_LNK = os.path.join(os.environ['USERPROFILE'], 'Desktop', 'BT搜索.lnk')
STARTMENU_DIR = os.path.join(os.environ['APPDATA'], 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'BT搜索')

failures = []


def check(name, ok, detail=''):
    print('[%s] %s%s' % (' ok ' if ok else 'FAIL', name, ('  ' + detail) if detail else ''))
    if not ok:
        failures.append(name + ((' -> ' + detail) if detail else ''))


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def ps(code, **env_extra):
    """Run PowerShell with UTF-8 output and tolerant decoding."""
    prefix = ('[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
              '$OutputEncoding = [Text.Encoding]::UTF8; ')
    env = dict(os.environ)
    env.update(env_extra)
    result = subprocess.run(
        ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', prefix + code],
        capture_output=True, env=env,
    )
    raw = (result.stdout or b'') + (result.stderr or b'')
    for enc in ('utf-8-sig', 'utf-8', 'gbk'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', 'replace')


def signature_status(path):
    out = ps("$s = Get-AuthenticodeSignature -LiteralPath $env:BT_P; Write-Output $s.Status",
             BT_P=path)
    return out.strip()


def read_lnk_target(path):
    out = ps("$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:BT_LNK); "
             "Write-Output $s.TargetPath", BT_LNK=path)
    return out.strip()


def lnk_matches(path, expected):
    """Compare inside PowerShell (avoids Python<->PowerShell codepage mangling).

    Returns (ok, detail). On mismatch the detail carries both paths as base64(UTF-8)
    so Python can decode them losslessly.
    """
    code = (
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:BT_LNK); "
        "$t = $s.TargetPath; "
        "if ([string]::Equals($t, $env:BT_EXPECT, [System.StringComparison]::OrdinalIgnoreCase)) { "
        "  Write-Output 'MATCH' "
        "} else { "
        "  $te = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)); "
        "  $ee = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($env:BT_EXPECT)); "
        "  Write-Output ('MISMATCH ' + $te + ' ' + $ee) "
        "}"
    )
    out = ps(code, BT_LNK=path, BT_EXPECT=expected).strip()
    if out == 'MATCH':
        return True, 'match'
    parts = out.split()
    if len(parts) == 3 and parts[0] == 'MISMATCH':
        import base64
        actual = base64.b64decode(parts[1]).decode('utf-8', 'replace')
        wanted = base64.b64decode(parts[2]).decode('utf-8', 'replace')
        return False, 'actual=%r expected=%r' % (actual, wanted)
    return False, out[:200]


def read_reg(name):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINST_KEY) as key:
            value, _ = winreg.QueryValueEx(key, name)
            return value
    except OSError:
        return None


def reg_key_exists():
    try:
        winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINST_KEY).Close()
        return True
    except OSError:
        return False


def run_process(args, timeout=180, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, timeout=timeout,
                          text=True, encoding='utf-8', errors='replace')


def wait_dir_gone(path, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not os.path.exists(path):
            return True
        time.sleep(0.3)
    return not os.path.exists(path)


def compare_tree(expected_root, actual_root):
    """Compare every file under expected_root with actual_root by SHA256."""
    problems = []
    for dirpath, dirnames, filenames in os.walk(expected_root):
        dirnames.sort()
        for name in sorted(filenames):
            src = os.path.join(dirpath, name)
            rel = os.path.relpath(src, expected_root)
            dst = os.path.join(actual_root, rel)
            if not os.path.isfile(dst):
                problems.append('missing ' + rel)
                continue
            if sha256(src) != sha256(dst):
                problems.append('hash mismatch ' + rel)
    return problems


def probe_port(timeout=20.0):
    """Return the first listening port in PORT_RANGE, or None."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for port in PORT_RANGE:
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=0.05):
                    return port
            except OSError:
                continue
        time.sleep(0.3)
    return None


def http_get(port, path, timeout=8):
    with urllib.request.urlopen('http://127.0.0.1:%d%s' % (port, path), timeout=timeout) as resp:
        return resp.status, resp.read()


def kill_app():
    subprocess.run(['taskkill', '/F', '/IM', APP_EXE], capture_output=True)


def uninstall(install_dir, label):
    uninst = os.path.join(install_dir, 'uninstall.exe')
    if not os.path.isfile(uninst):
        check(label + ': uninstall.exe present', False)
        return
    removed = False
    for attempt in (1, 2):
        try:
            run_process([uninst, '/S'], timeout=120)
        except subprocess.TimeoutExpired:
            pass
        # NSIS 卸载器会先复制到 %TEMP% 再执行，目录删除可能滞后；新装 exe 也可能被杀软占用
        if wait_dir_gone(install_dir, timeout=45):
            removed = True
            break
        time.sleep(2)
    check(label + ': install dir removed', removed)
    if not removed:
        leftover = []
        for root, dirs, files in os.walk(install_dir):
            leftover.extend(os.path.join(root, f) for f in files)
        print('   leftover files (%d): %s' % (len(leftover), sorted(leftover)[:8]))
    check(label + ': uninstall registry key removed', not reg_key_exists())


def install_silent(label, extra_flags):
    """Copy setup to temp and run it silently to INSTALL."""
    setup_local = os.path.join(BASE, 'btsearch-setup.exe')
    shutil.copy2(SETUP, setup_local)
    args = [setup_local, '/S'] + list(extra_flags) + ['/D=' + INSTALL]
    result = run_process(args, timeout=300, cwd=BASE)
    check(label + ': setup exit code 0', result.returncode == 0,
          'rc=%d %s' % (result.returncode, (result.stderr or result.stdout or '')[:200]))


def lnk_target_contains(path, needle):
    code = (
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:BT_LNK); "
        "if ($s.TargetPath.IndexOf($env:BT_NEEDLE, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) "
        "{ Write-Output 'YES' } else { Write-Output 'NO' }"
    )
    return 'YES' in ps(code, BT_LNK=path, BT_NEEDLE=needle)


def cleanup_previous_test_leftovers():
    """Remove start-menu/desktop shortcuts left by an earlier failed test run.

    Only touches shortcuts whose target points into the test BASE dir, so a user's
    own BT搜索 shortcuts are never destroyed.
    """
    if os.path.isdir(STARTMENU_DIR):
        lnks = [os.path.join(STARTMENU_DIR, n) for n in os.listdir(STARTMENU_DIR) if n.lower().endswith('.lnk')]
        if lnks and all(lnk_target_contains(p, BASE) for p in lnks):
            shutil.rmtree(STARTMENU_DIR, ignore_errors=True)
            print('[clean] removed leftover test start-menu folder')
    if os.path.isfile(DESKTOP_LNK) and lnk_target_contains(DESKTOP_LNK, BASE):
        try:
            os.remove(DESKTOP_LNK)
            print('[clean] removed leftover test desktop shortcut')
        except OSError:
            pass


def main():
    print('setup  : %s (%d bytes)' % (SETUP, os.path.getsize(SETUP) if os.path.isfile(SETUP) else -1))
    if not os.path.isfile(SETUP):
        sys.exit('setup exe missing: %s' % SETUP)
    os.makedirs(BASE, exist_ok=True)
    # clean stale installs from previous runs
    for path in (INSTALL, INSTALL2):
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
    kill_app()
    cleanup_previous_test_leftovers()

    # 卸载器总会删除 "$DESKTOP\BT搜索.lnk"（标准行为），所以 Test 1 的卸载也可能
    # 删掉用户已有的快捷方式：在整个测试开始前备份，结束时恢复。
    backup = os.path.join(BASE, '_desktop_backup.lnk')
    had_desktop = os.path.isfile(DESKTOP_LNK)
    if had_desktop:
        shutil.copy2(DESKTOP_LNK, backup)
    sm_backup = os.path.join(BASE, '_startmenu_backup')
    had_startmenu = os.path.isdir(STARTMENU_DIR)
    if had_startmenu:
        shutil.copytree(STARTMENU_DIR, sm_backup)

    check('setup signature Valid', signature_status(SETUP) == 'Valid', signature_status(SETUP))

    # ---------------- Test 1: silent install without shortcuts/cert ----------------
    install_silent('install', ['/NOSHORTCUTS', '/NOCERT'])

    check('install dir exists', os.path.isdir(INSTALL))
    exe = os.path.join(INSTALL, APP_EXE)
    check('app exe installed', os.path.isfile(exe))
    check('app exe signature Valid', os.path.isfile(exe) and signature_status(exe) == 'Valid')

    for name in ('使用说明.txt', '一键信任.cmd', 'BT搜索.cer', 'uninstall.exe'):
        check('installed ' + name, os.path.isfile(os.path.join(INSTALL, name)))
    check('usage text readable',
          os.path.isfile(os.path.join(INSTALL, '使用说明.txt')) and
          '安装版' in open(os.path.join(INSTALL, '使用说明.txt'), 'rb').read().decode('utf-8-sig', 'replace'))
    cmd_ok = False
    try:
        text = open(os.path.join(INSTALL, '一键信任.cmd'), 'rb').read().decode('gbk')
        cmd_ok = 'certutil' in text and 'chcp 936' in text
    except Exception:
        cmd_ok = False
    check('trust cmd decodes as GBK', cmd_ok)

    problems = compare_tree(DIST, INSTALL)
    check('installed files match dist (SHA256)', not problems,
          '; '.join(problems[:6]) + (' ...' if len(problems) > 6 else ''))

    check('registry DisplayName', read_reg('DisplayName') == 'BT搜索', str(read_reg('DisplayName')))
    check('registry DisplayVersion', read_reg('DisplayVersion') == '1.2.2', str(read_reg('DisplayVersion')))
    uninstall_string = str(read_reg('UninstallString') or '')
    check('registry UninstallString points at uninstall.exe',
          uninstall_string.lower().endswith('uninstall.exe"'), uninstall_string)

    # ---------------- launch + HTTP assertions ----------------
    proc = subprocess.Popen([exe, '--no-browser'], cwd=INSTALL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    port = probe_port(timeout=20)
    check('app listens on 17650-17689', port is not None, 'port=%s' % port)
    if port:
        try:
            status, body = http_get(port, '/api/health')
            ok_health = status == 200 and json.loads(body.decode('utf-8')).get('ok') is True
        except Exception as exc:
            ok_health = False
            body = str(exc).encode()
        check('/api/health returns ok', ok_health)
        try:
            status, body = http_get(port, '/')
            html = body.decode('utf-8', 'replace')
            ok_page = status == 200 and 'BT搜索' in html and '每页' in html
        except Exception:
            ok_page = False
        check('/ serves the paged UI', ok_page)
    kill_app()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()

    # ---------------- silent uninstall ----------------
    uninstall(INSTALL, 'uninstall')

    # ---------------- Test 2: shortcuts ----------------
    setup_local = os.path.join(BASE, 'btsearch-setup.exe')
    args = [setup_local, '/S', '/NOCERT', '/D=' + INSTALL2]
    result = run_process(args, timeout=300, cwd=BASE)
    check('shortcut install: setup exit code 0', result.returncode == 0, 'rc=%d' % result.returncode)
    check('shortcut install: dir exists', os.path.isdir(INSTALL2))
    if os.path.isfile(DESKTOP_LNK):
        ok, detail = lnk_matches(DESKTOP_LNK, os.path.join(INSTALL2, APP_EXE))
        check('desktop shortcut target', ok, detail)
    else:
        check('desktop shortcut created', False)
    sm_app = os.path.join(STARTMENU_DIR, 'BT搜索.lnk')
    sm_uninst = os.path.join(STARTMENU_DIR, '卸载 BT搜索.lnk')
    check('start menu app shortcut', os.path.isfile(sm_app))
    check('start menu uninstall shortcut', os.path.isfile(sm_uninst))

    uninstall(INSTALL2, 'shortcut uninstall')
    check('desktop shortcut removed by uninstaller', wait_dir_gone(DESKTOP_LNK, timeout=15))
    check('start menu folder removed by uninstaller', wait_dir_gone(STARTMENU_DIR, timeout=15))

    # restore user's pre-existing shortcuts
    if had_desktop:
        shutil.copy2(backup, DESKTOP_LNK)
    if had_startmenu:
        if os.path.isdir(STARTMENU_DIR):
            shutil.rmtree(STARTMENU_DIR, ignore_errors=True)
        shutil.copytree(sm_backup, STARTMENU_DIR)

    # ---------------- summary ----------------
    print('')
    if failures:
        print('FAILED (%d):' % len(failures))
        for item in failures:
            print('  - ' + item)
        raise SystemExit(1)
    print('ALL CHECKS PASSED')


if __name__ == '__main__':
    main()
