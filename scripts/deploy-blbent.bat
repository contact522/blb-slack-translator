@echo off
conhost.exe powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0deploy-blbent.ps1"
