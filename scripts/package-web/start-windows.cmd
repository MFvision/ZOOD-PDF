@echo off
rem ZOOD PDF - start the offline web app on this computer (127.0.0.1 only).
rem Needs Node.js 22 or newer: https://nodejs.org
setlocal
chcp 65001 >nul
title ZOOD PDF
where node >nul 2>nul
if errorlevel 1 (
  echo ZOOD PDF needs Node.js 22 or newer: https://nodejs.org
  echo يحتاج زود PDF إلى Node.js 22 أو أحدث: https://nodejs.org
  start "" "https://nodejs.org/"
  pause
  exit /b 1
)
node "%~dp0serve.mjs" --open
if errorlevel 1 pause
endlocal
