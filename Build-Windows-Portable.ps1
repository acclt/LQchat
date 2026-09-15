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
$releaseExe = Join-Path $PSScriptRoot "src-tauri\target\release\LQChat.exe"
$shortcutIcon = Join-Path $PSScriptRoot "src-tauri\icons\icon.ico"

Push-Location (Join-Path $PSScriptRoot "src-tauri")
try {
    cargo build --release --bin LQChat --features desktop
    if ($LASTEXITCODE -ne 0) {
        throw "Windows 正式程序编译失败，退出码 $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

foreach ($requiredFile in @($releaseExe, $shortcutIcon)) {
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
    Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $stagingDirectory "LQChat.exe")
    Copy-Item -LiteralPath $shortcutIcon -Destination (Join-Path $stagingDirectory "LQChat.ico")
    foreach ($relativeDirectory in @("data", "config", "downloads", "cache\EBWebView")) {
        [System.IO.Directory]::CreateDirectory((Join-Path $stagingDirectory $relativeDirectory)) | Out-Null
    }
    Compress-Archive -Path (Join-Path $stagingDirectory "*") -DestinationPath $zipPath -CompressionLevel Optimal -Force

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Update)
    try {
        foreach ($entryName in @("data/", "config/", "downloads/", "cache/", "cache/EBWebView/")) {
            if (-not $archive.GetEntry($entryName)) {
                $archive.CreateEntry($entryName) | Out-Null
            }
        }
    } finally {
        $archive.Dispose()
    }
} finally {
    if (Test-Path -LiteralPath $stagingDirectory) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
}

Write-Output $zipPath
