@echo off
REM One-time: start the TruthFinder agent automatically whenever this Windows user logs in, keep it running
REM (auto-restart), and stop the computer from sleeping. Run START-AGENT.bat and VERIFY-DEVICE.bat first.
cd /d "%~dp0"
title Install TruthFinder agent autostart

if not exist ".env" ( echo agent\.env is missing - run START-AGENT.bat first. & pause & exit /b 1 )
if not exist "node_modules\playwright" ( echo Not installed yet - run START-AGENT.bat first. & pause & exit /b 1 )

REM Start at log-on of this user (a visible desktop session is needed for Chrome), minimized
schtasks /create /tn "TruthFinder Agent" /tr "cmd.exe /c start \"TruthFinder agent\" /min \"%~dp0RUN-AGENT-LOOP.bat\"" /sc onlogon /ru "%USERNAME%" /rl highest /f
if errorlevel 1 ( echo Could not create the task - right-click this file and choose "Run as administrator". & pause & exit /b 1 )

REM Never sleep or hibernate (screen may still turn off)
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change standby-timeout-dc 0

echo.
echo Done. The agent now starts by itself every time %USERNAME% logs in, and restarts if it stops.
echo Starting it now...
schtasks /run /tn "TruthFinder Agent"
echo.
echo Log file: %~dp0agent.log
echo To remove: run UNINSTALL-AUTOSTART.bat
pause
