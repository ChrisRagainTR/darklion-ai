# DarkLion Printer Setup
# Run as Administrator — sets up a virtual PostScript printer using Redmon + Ghostscript
# This script is called by the Inno Setup installer during installation.

param(
    [string]$GhostscriptPath = "C:\Program Files\gs\gs10.03.1\bin\gswin64c.exe",
    [string]$RedmonDll = "$PSScriptRoot\redmon64.dll",
    [string]$SpoolDir = "$env:PROGRAMDATA\DarkLion\Spool"
)

$PrinterName = "DarkLion Printer"
$PortName    = "DarkLionPort:"
$DriverName  = "Generic / Text Only"   # fallback; will be overridden below

# ── 1. Ensure spool directory exists ────────────────────────────────────────
Write-Host "Creating spool directory: $SpoolDir"
New-Item -ItemType Directory -Force -Path $SpoolDir | Out-Null
# Grant full control to Everyone so service (SYSTEM) and users can both write/read
$acl = Get-Acl $SpoolDir
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    "Everyone", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"
)
$acl.SetAccessRule($rule)
Set-Acl $SpoolDir $acl

# ── 2. Install Redmon port monitor DLL ──────────────────────────────────────
# Redmon is a free, open-source port redirector that pipes PostScript output
# to a command (Ghostscript) instead of a physical port.
Write-Host "Installing Redmon port monitor..."

$system32 = "$env:SystemRoot\System32"
$redmonDest = "$system32\redmon64.dll"

if (-not (Test-Path $RedmonDll)) {
    Write-Error "Redmon DLL not found at: $RedmonDll"
    exit 1
}

# Copy DLL to system32 (required for port monitor registration)
Copy-Item -Path $RedmonDll -Destination $redmonDest -Force

# Register the port monitor via the Windows API (AddMonitor)
# We use rundll32 to call the setup entry point if available,
# otherwise we register via the registry + spooler restart.
$monitorKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\Redmon"
if (-not (Test-Path $monitorKey)) {
    New-Item -Path $monitorKey -Force | Out-Null
    Set-ItemProperty -Path $monitorKey -Name "Driver" -Value "redmon64.dll"
    Write-Host "Redmon monitor registered in registry."
} else {
    Write-Host "Redmon monitor already registered."
}

# ── 3. Restart Print Spooler to load the new monitor ────────────────────────
Write-Host "Restarting Print Spooler..."
Restart-Service -Name Spooler -Force
Start-Sleep -Seconds 3

# ── 4. Add the Redmon port ───────────────────────────────────────────────────
Write-Host "Adding DarkLion port..."

# Check if port already exists
$existingPorts = Get-PrinterPort -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $PortName }
if ($existingPorts) {
    Write-Host "Port $PortName already exists — skipping."
} else {
    # Use rundll32 to call Redmon's AddPort — or fall back to direct registry
    # Redmon port settings are stored under the monitor's Ports key
    $portKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\Redmon\Ports\$PortName"
    New-Item -Path $portKey -Force | Out-Null

    # Configure Redmon to pipe PostScript to Ghostscript and write PDF to spool dir
    # %s is replaced by the print job name (used as filename base)
    Set-ItemProperty -Path $portKey -Name "Command"         -Value "`"$GhostscriptPath`" -dBATCH -dNOPAUSE -dNOSAFER -sDEVICE=pdfwrite -sOutputFile=`"$SpoolDir\%Y%m%d_%H%M%S_job.pdf`" -"
    Set-ItemProperty -Path $portKey -Name "Description"     -Value "DarkLion PDF Port"
    Set-ItemProperty -Path $portKey -Name "PrintError"      -Value 0 -Type DWord
    Set-ItemProperty -Path $portKey -Name "LogFileDebug"    -Value 0 -Type DWord
    Set-ItemProperty -Path $portKey -Name "LogFileName"     -Value "$env:PROGRAMDATA\DarkLion\Logs\redmon.log"
    Set-ItemProperty -Path $portKey -Name "RunUser"         -Value 1 -Type DWord   # run as the printing user
    Set-ItemProperty -Path $portKey -Name "Delay"           -Value 300 -Type DWord # ms delay before reading stdin
    Set-ItemProperty -Path $portKey -Name "PrintJobNameAsArg" -Value 0 -Type DWord
    Set-ItemProperty -Path $portKey -Name "SessionPrintedBy" -Value 1 -Type DWord  # pass %USERNAME% env var

    Write-Host "Port $PortName configured."
}

# ── 5. Find or install the PostScript printer driver ────────────────────────
# Windows Server ships with several PS drivers. We prefer in this order:
# 1. "HP Color LaserJet 2800 Series PS" — widely available, good PS level 3
# 2. "HP Universal Printing PS"
# 3. "Generic PostScript Printer" (added via pointnprint if needed)

Write-Host "Looking for PostScript printer driver..."
$preferredDrivers = @(
    "HP Color LaserJet 2800 Series PS",
    "HP Universal Printing PS",
    "HP LaserJet 4 Plus/4M Plus PS",
    "Generic / Text Only"
)

$installedDrivers = Get-PrinterDriver -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
$selectedDriver = $null

foreach ($d in $preferredDrivers) {
    if ($installedDrivers -contains $d) {
        $selectedDriver = $d
        Write-Host "Found driver: $selectedDriver"
        break
    }
}

# If no PS driver found, install the MS built-in PostScript driver from the driver store
if (-not $selectedDriver) {
    Write-Host "No PostScript driver found — installing from driver store..."
    try {
        # pnputil + Add-PrinterDriver for the inbox PS driver
        $infPath = "$env:SystemRoot\System32\DriverStore\FileRepository"
        $psInf = Get-ChildItem -Path $infPath -Recurse -Filter "*.inf" -ErrorAction SilentlyContinue |
                 Where-Object { $_.FullName -match "ps[c5]|pscript" } |
                 Select-Object -First 1

        if ($psInf) {
            pnputil.exe /add-driver $psInf.FullName /install | Out-Null
            # After adding, re-check
            $installedDrivers = Get-PrinterDriver -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
            foreach ($d in $preferredDrivers) {
                if ($installedDrivers -contains $d) { $selectedDriver = $d; break }
            }
        }
    } catch {
        Write-Warning "Could not auto-install PS driver: $_"
    }
}

# Absolute fallback: use Generic / Text Only (won't produce great PS but won't crash)
if (-not $selectedDriver) {
    $selectedDriver = "Generic / Text Only"
    Write-Warning "Falling back to Generic driver — PostScript output quality may vary."
}

# ── 6. Create the printer ───────────────────────────────────────────────────
Write-Host "Creating printer '$PrinterName'..."
$existing = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Printer '$PrinterName' already exists — removing and recreating."
    Remove-Printer -Name $PrinterName -ErrorAction SilentlyContinue
}

Add-Printer -Name $PrinterName -DriverName $selectedDriver -PortName $PortName -ErrorAction Stop

# Set printer comment and location for easy identification
Set-Printer -Name $PrinterName -Comment "DarkLion Document Management" -Location "DarkLion"

Write-Host ""
Write-Host "✅ DarkLion Printer installed successfully!"
Write-Host "   Printer : $PrinterName"
Write-Host "   Driver  : $selectedDriver"
Write-Host "   Port    : $PortName  (Redmon → Ghostscript → $SpoolDir)"
Write-Host ""
