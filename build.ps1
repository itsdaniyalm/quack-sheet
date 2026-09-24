# Builds dist\QuackSheet\QuackSheet.exe (a folder build: less likely to trip antivirus than --onefile).
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path .venv)) { python -m venv .venv }
$py = '.\.venv\Scripts\python.exe'
& $py -m pip install --quiet -r requirements.txt
if (-not (Test-Path assets\quacksheet.ico)) {
    & $py -m pip install --quiet pillow
    & $py tools\make_icon.py
}

& $py -m PyInstaller --noconfirm --clean `
    --name QuackSheet `
    --windowed `
    --onedir `
    --icon assets\quacksheet.ico `
    --paths app `
    --add-data "app\web;web" `
    --exclude-module tkinter `
    app\main.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

Write-Host ""
Write-Host "Built: $PSScriptRoot\dist\QuackSheet\QuackSheet.exe" -ForegroundColor Green
Write-Host "Share the whole dist\QuackSheet folder (zip it); the exe needs the _internal folder beside it."
