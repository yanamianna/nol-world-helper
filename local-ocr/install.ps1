$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskVenvPython = Join-Path $taskRoot '.venv\Scripts\python.exe'

Write-Host '准备本地 OCR 环境，仅从官方 PyPI 下载依赖。'
if (-not (Test-Path -LiteralPath $taskVenvPython)) {
    $taskPython = Get-Command python -ErrorAction SilentlyContinue
    if (-not $taskPython) {
        throw '未找到 Python。请安装 64 位 Python 3.10 或更新版本，并勾选 Add Python to PATH。'
    }
    & $taskPython.Source -c "import sys,struct; sys.exit(0 if sys.version_info >= (3,10) and struct.calcsize('P') == 8 else 1)"
    if ($LASTEXITCODE -ne 0) { throw '需要 64 位 Python 3.10 或更新版本。' }
    & $taskPython.Source -m venv (Join-Path $taskRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw '无法创建本地 Python 虚拟环境。' }
}
& $taskVenvPython -m pip install --disable-pip-version-check --retries 1 --timeout 20 --index-url https://pypi.org/simple --only-binary=:all: -r (Join-Path $taskRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。请检查网络连接；无需关闭 SSL 校验或修改系统 Python。' }
& $taskVenvPython -c "import ddddocr; from PIL import Image; print('本地 OCR 依赖安装完成。')"
if ($LASTEXITCODE -ne 0) { throw '依赖无法加载。请核对 Python 与运行库版本。' }
Write-Host '运行 start.ps1 启动服务，然后使用扩展中的本地识别功能。'
