param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "dist-custom")
)

$ErrorActionPreference = "Stop"

$cargoTomlPath = Join-Path $PSScriptRoot "src-tauri\Cargo.toml"
$cargoToml = Get-Content -LiteralPath $cargoTomlPath -Raw
$versionMatch = [regex]::Match($cargoToml, '(?m)^version\s*=\s*"(?<version>\d+\.\d+)\.\d+"')
if (-not $versionMatch.Success) {
    throw "无法从 Cargo.toml 读取 LQChat 展示版本"
}

$version = $versionMatch.Groups["version"].Value
$releaseExe = Join-Path $PSScriptRoot "src-tauri\target\release\lanchat.exe"
$launchScript = Join-Path $PSScriptRoot "src-tauri\resources\Start-LQChat.cmd"
$shortcutIcon = Join-Path $PSScriptRoot "src-tauri\resources\LQChat-shortcut-v$version.ico"

Push-Location (Join-Path $PSScriptRoot "src-tauri")
try {
    cargo build --release --bin lanchat --features desktop
    if ($LASTEXITCODE -ne 0) {
        throw "Windows 正式程序编译失败，退出码 $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

foreach ($requiredFile in @($releaseExe, $launchScript, $shortcutIcon)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "便携包缺少必要文件：$requiredFile"
    }
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
$stagingDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("lqchat-portable-" + [guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $resolvedOutput "LQChat-v$version-windows-x64-portable.zip"

try {
    [System.IO.Directory]::CreateDirectory($stagingDirectory) | Out-Null
    Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $stagingDirectory "lanchat.exe")
    Copy-Item -LiteralPath $launchScript -Destination (Join-Path $stagingDirectory "Start-LQChat.cmd")
    Copy-Item -LiteralPath $shortcutIcon -Destination (Join-Path $stagingDirectory "LQChat-shortcut-v$version.ico")
    Compress-Archive -Path (Join-Path $stagingDirectory "*") -DestinationPath $zipPath -CompressionLevel Optimal -Force
} finally {
    if (Test-Path -LiteralPath $stagingDirectory) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
}

Write-Output $zipPath
