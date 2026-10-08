$ErrorActionPreference = 'Stop'
$taskVenvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskVenvPython)) {
    throw '请先运行 install.ps1 安装本地 OCR。'
}
& $taskVenvPython (Join-Path $PSScriptRoot 'server.py')
if ($LASTEXITCODE -ne 0) { throw '本地 OCR 服务未能运行，请查看上方提示。' }
