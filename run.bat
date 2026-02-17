@echo off
REM ── Antigravity-GO Launcher ──

echo Starting Antigravity-GO...
echo.

if not exist "node_modules" (
    echo Installing dependencies...
    npm install
    echo.
)

if not exist "config.json" (
    if exist "config.example.json" (
        copy "config.example.json" "config.json"
        echo Created config.json from example — edit it to customize!
        echo.
    )
)

echo Starting server on http://localhost:6969
echo Press Ctrl+C to stop.
echo.

node server.js
