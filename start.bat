@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found. Install Node.js and try again.
    pause
    exit /b 1
)

if not exist "server.mjs" (
    echo Could not find server.mjs. Run this file from the project folder.
    pause
    exit /b 1
)

echo Starting Firstlight...
echo Open http://localhost:4173 in your browser.
echo Press Ctrl+C to stop the server.
echo.

node server.mjs
set "exitCode=%ERRORLEVEL%"

if not "%exitCode%"=="0" (
    echo.
    echo The server stopped with exit code %exitCode%.
    pause
)

exit /b %exitCode%
