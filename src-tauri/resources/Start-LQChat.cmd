@echo off
setlocal

set "LQCHAT_DIR=%~dp0"
set "LQCHAT_EXE=%LQCHAT_DIR%lanchat.exe"

if not exist "%LQCHAT_EXE%" (
    echo LQChat executable not found: "%LQCHAT_EXE%"
    pause
    exit /b 1
)

start "" /D "%LQCHAT_DIR%" "%LQCHAT_EXE%"
exit /b 0
