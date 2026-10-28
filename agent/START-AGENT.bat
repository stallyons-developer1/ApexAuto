@echo off
REM TruthFinder agent for the Imperium booking app. Double-click to start; keep the window open.
cd /d "%~dp0"
title TruthFinder agent

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created agent\.env - fill in TF_AGENT_KEY, TF_EMAIL and TF_PASSWORD, save it, then run this again.
  notepad ".env"
  pause
  exit /b 1
)

if not exist "node_modules\playwright" (
  echo Installing the agent - first time only...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
  call npx playwright install chromium
)

node truthfinder-agent.js
pause
