@echo off
title GoCharting scraper
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
  echo Put start.bat in the project folder ^(the same folder as package.json^).
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
  call npm ci --omit=dev
  if errorlevel 1 (
    echo npm ci failed. Check the messages above, then try again.
    echo.
    pause
    exit /b 1
  )
)

set "ENTRY="
if exist "src\index.js" set "ENTRY=src\index.js"
if not defined ENTRY if exist "index.js" set "ENTRY=index.js"
if not defined ENTRY (
  echo Could not find src\index.js or index.js in:
  echo   %CD%
  echo.
  pause
  exit /b 1
)

echo.
echo Keep this window open while you want candles collected.
echo Sleep, closing the lid, or closing this window will stop the scraper.
echo When you are done for the day, press Ctrl+C, then you can shut the PC down.
echo.
node "%ENTRY%"
echo.
echo Scraper stopped.
pause
