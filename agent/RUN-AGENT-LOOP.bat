@echo off
REM Keeps the TruthFinder agent running: if it stops or crashes it restarts after 15 seconds.
REM Output also goes to agent\agent.log. Started by the "TruthFinder Agent" task (INSTALL-AUTOSTART.bat).
cd /d "%~dp0"
title TruthFinder agent (auto-restart)
:loop
echo [%date% %time%] starting agent >> agent.log
node truthfinder-agent.js >> agent.log 2>&1
echo [%date% %time%] agent stopped - restarting in 15 seconds >> agent.log
timeout /t 15 /nobreak >nul
goto loop
