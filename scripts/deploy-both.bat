@echo off
conhost.exe powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0deploy-both.ps1"
