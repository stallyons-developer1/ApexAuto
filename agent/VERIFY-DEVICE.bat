@echo off
REM One-time setup: opens the agent's Chrome on TruthFinder so you can sign in and verify this device.
REM Run START-AGENT.bat once first (it installs everything), then this, then START-AGENT.bat again.
cd /d "%~dp0"
title TruthFinder agent - device setup
if not exist "node_modules\playwright" ( echo Run START-AGENT.bat once first. & pause & exit /b 1 )
node truthfinder-agent.js --setup
pause
