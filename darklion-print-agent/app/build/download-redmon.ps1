# Run this ONCE before building the installer to download redmon64.dll
# Only needed by developers building the installer — NOT needed by end users

$dest = "$PSScriptRoot\redmon64.dll"

if (Test-Path $dest) {
    Write-Host "redmon64.dll already exists. Skipping download."
    exit 0
}

Write-Host "Downloading redmon64.dll..."

$urls = @(
    "https://github.com/nicholasess/redmon/raw/master/redmon64.dll",
    "https://github.com/dtjohnson/redmon/raw/master/redmon64.dll",
    "https://raw.githubusercontent.com/rcbdev/redmon/master/redmon64.dll"
)

foreach ($url in $urls) {
    try {
        Write-Host "Trying: $url"
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 15
        if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 10000) {
            Write-Host "Success! redmon64.dll downloaded ($((Get-Item $dest).Length) bytes)"
            exit 0
        }
    } catch {
        Write-Host "Failed: $_"
    }
}

Write-Host ""
Write-Host "Could not download redmon64.dll automatically."
Write-Host "Please download it manually from: https://www.undocprint.org/formats/winspool/redmon"
Write-Host "Place redmon64.dll in: $PSScriptRoot"
exit 1
