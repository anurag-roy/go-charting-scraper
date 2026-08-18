@echo off
title GoCharting scraper — one-time test
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed, or this window cannot see it on PATH.
  echo Install Node.js 22 LTS from https://nodejs.org
  echo During setup, leave "Add to PATH" checked, then close and reopen this window.
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo Could not find package.json in:
  echo   %CD%
  echo Put start-once.bat in the project folder ^(the same folder as package.json^).
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo Missing .env in the project folder.
  echo Copy the .env file you were given next to package.json, then try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo First run: installing dependencies with npm ci ...
  call npm ci
  if errorlevel 1 (
    echo npm ci failed. Check the messages above, then try again.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo Smoke test: one config read + one sample, then this window will exit.
echo For the trading day, use start.bat instead.
echo.
set ONCE=1
node src\index.js
echo.
echo Smoke test finished.
pause
