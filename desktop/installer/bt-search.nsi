; ---------------------------------------------------------------------------
; BT搜索 installer script (NSIS 3.13, portable build)
;
; 目标：Windows 10/11 x64，安装到当前用户目录（无需管理员/UAC）：
;   %LOCALAPPDATA%\Programs\BT搜索
; 快捷方式、开始菜单、应用和功能卸载项、可选导入签名证书。
;
; 测试用命令行开关（不影响正常用户）：
;   /NOSHORTCUTS   跳过桌面/开始菜单快捷方式（静默安装验证用）
;   /NOCERT        跳过证书导入
; ---------------------------------------------------------------------------

Unicode true

SetCompressor /SOLID lzma
SetCompressorDictSize 32

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define APP_NAME "BT搜索"
!define APP_VERSION "1.2.2"
!define APP_EXE "BT搜索.exe"
!define APP_PUBLISHER "BT搜索"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\BT搜索"
!define REG_KEY "Software\BT搜索"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "out\btsearch-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "${REG_KEY}" "InstallDir"
RequestExecutionLevel user

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${APP_NAME} ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "本程序把 BT搜索 安装到当前用户目录，不需要管理员权限。$\r$\n$\r$\n· 安装位置：$LOCALAPPDATA\Programs\${APP_NAME}$\r$\n· 自动创建桌面与开始菜单快捷方式$\r$\n· 可导入随包签名证书，减少首次运行的安全提示$\r$\n$\r$\nBT搜索 聚合 磁力猫 与 动漫花园，在本机监听 127.0.0.1 的 17650-17689 端口。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 ${APP_NAME}"
!define MUI_FINISHPAGE_TEXT "${APP_NAME} 已安装完成。$\r$\n$\r$\n首次运行如果被 SmartScreen 拦住，请点「更多信息 → 仍要运行」。"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Var NoShortcuts
Var NoCert

; ---------------------------------------------------------------------------
; 初始化：解析测试开关
; ---------------------------------------------------------------------------
Function .onInit
  SetShellVarContext current
  StrCpy $NoShortcuts ""
  StrCpy $NoCert ""

  ${GetOptions} "$CMDLINE" "/NOSHORTCUTS" $0
  ${IfNot} ${Errors}
    StrCpy $NoShortcuts "1"
  ${EndIf}

  ${GetOptions} "$CMDLINE" "/NOCERT" $0
  ${IfNot} ${Errors}
    StrCpy $NoCert "1"
  ${EndIf}
FunctionEnd

Function un.onInit
  SetShellVarContext current
FunctionEnd

; ---------------------------------------------------------------------------
; 覆盖安装前：如果目标 exe 正在运行则处理占用
; ---------------------------------------------------------------------------
Function EnsureNotRunning
  ${If} ${FileExists} "$INSTDIR\${APP_EXE}"
    ClearErrors
    FileOpen $0 "$INSTDIR\${APP_EXE}" a
    ${If} ${Errors}
      ${If} ${Silent}
        nsExec::ExecToLog 'taskkill /F /IM "${APP_EXE}"'
        Sleep 800
      ${Else}
        MessageBox MB_YESNO|MB_ICONQUESTION "检测到 ${APP_NAME} 正在运行，安装程序需要先关闭它。$\r$\n是否立即关闭并继续安装？" IDNO bt_abort
        nsExec::ExecToLog 'taskkill /F /IM "${APP_EXE}"'
        Sleep 800
        Goto bt_continue
        bt_abort:
          Abort
        bt_continue:
      ${EndIf}
    ${Else}
      FileClose $0
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; 安装
; ---------------------------------------------------------------------------
Section "BT搜索 主程序（必需）" SEC_MAIN
  SectionIn RO
  Call EnsureNotRunning

  SetOutPath "$INSTDIR"
  File /r "payload\*.*"

  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "NoModify" "1"
  WriteRegStr HKCU "${UNINST_KEY}" "NoRepair" "1"
  WriteRegStr HKCU "${REG_KEY}" "InstallDir" "$INSTDIR"

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "导入签名证书（推荐）" SEC_CERT
  ${If} $NoCert == ""
    DetailPrint "导入代码签名证书到当前用户受信任根..."
    nsExec::ExecToLog 'certutil -user -addstore Root "$INSTDIR\BT搜索.cer"'
    nsExec::ExecToLog 'certutil -user -addstore TrustedPublisher "$INSTDIR\BT搜索.cer"'
  ${EndIf}
SectionEnd

Section "桌面快捷方式" SEC_DESKTOP
  ${If} $NoShortcuts == ""
    CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  ${EndIf}
SectionEnd

Section "开始菜单快捷方式" SEC_START
  ${If} $NoShortcuts == ""
    CreateDirectory "$SMPROGRAMS\${APP_NAME}"
    CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
    CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"
  ${EndIf}
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MAIN} "${APP_NAME} 主程序与页面资源（必需）。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CERT} "把随包的签名证书（CN=BT搜索）导入当前用户受信任根，减少首次运行的安全提示；不需要管理员权限。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} "在桌面创建「${APP_NAME}」快捷方式。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_START} "在开始菜单创建程序与卸载入口。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ---------------------------------------------------------------------------
; 卸载
; ---------------------------------------------------------------------------
Section "Uninstall"
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXE}"'

  Delete "$DESKTOP\${APP_NAME}.lnk"
  ; 开始菜单目录偶尔会被资源管理器/安全软件短暂占用：先删文件，再 RMDir /r，
  ; 稍等再兜一次，避免目录残留。
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  Sleep 300
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${REG_KEY}"
SectionEnd
