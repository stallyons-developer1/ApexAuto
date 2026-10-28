@echo off
REM Removes the TruthFinder agent autostart and stops a running agent.
schtasks /delete /tn "TruthFinder Agent" /f
taskkill /fi "WINDOWTITLE eq TruthFinder agent (auto-restart)*" /f >nul 2>nul
wmic process where "name='node.exe' and commandline like '%%truthfinder-agent%%'" call terminate >nul 2>nul
echo Autostart removed and the agent stopped.
pause
