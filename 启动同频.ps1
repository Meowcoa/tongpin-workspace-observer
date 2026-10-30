$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7 或更高版本运行。' }
Set-Location -LiteralPath $PSScriptRoot
$observerNodeVersion = [version]((node --version).TrimStart('v'))
if ($LASTEXITCODE -ne 0) { throw '找不到 Node.js。需要 Node.js 24.16 或更新的 24.x 版本。' }
if ($observerNodeVersion -lt [version]'24.16.0' -or $observerNodeVersion.Major -ne 24) { throw '本版验证环境为 Node.js 24.16+（24.x）。' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    npm ci --no-fund
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'dist\index.html'))) {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw '界面构建失败。' }
}
Write-Output '打开 http://127.0.0.1:4318；停止服务请在此窗口按 Ctrl+C。'
npm start
if ($LASTEXITCODE -ne 0) { throw '启动失败，请查看上方的原始错误。' }
