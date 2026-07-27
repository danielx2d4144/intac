@echo off
rem agentvoice daemon launcher - runs in its OWN window (required: if the daemon
rem lives in a VS Code terminal pane, paste targeting cannot reach the agent pane).
set AGENTVOICE_TARGET_TITLE=Visual Studio Code
start "agentvoice daemon" cmd /k node "%~dp0daemon\agentvoice-daemon.mjs"
