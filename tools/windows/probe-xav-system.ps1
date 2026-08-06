<#
.SYNOPSIS
    Probes a Windows 11 machine for everything that determines how XAV should be
    built, configured and tuned on it.

.DESCRIPTION
    Read-only. Changes nothing. Writes a report to xav-probe-report.txt next to
    this script (override with -OutFile) and prints the same content.

    Run from an elevated PowerShell for complete results -- a few checks
    (Defender status, some CIM classes) return partial data without elevation.
    The script degrades gracefully instead of failing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\probe-xav-system.ps1

.NOTES
    Companion to docs/windows/PLAN.md. Section numbers in the output refer to it.
#>

[CmdletBinding()]
param(
    [string]$OutFile = (Join-Path $PSScriptRoot 'xav-probe-report.txt')
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

$script:Report = [System.Text.StringBuilder]::new()

function Add-Line { param([string]$Text = '') [void]$script:Report.AppendLine($Text) }

function Add-Section {
    param([string]$Title)
    Add-Line
    Add-Line ('=' * 78)
    Add-Line "  $Title"
    Add-Line ('=' * 78)
}

function Add-Field {
    param([string]$Name, $Value)
    if ($null -eq $Value -or "$Value" -eq '') { $Value = '(unknown)' }
    Add-Line ("  {0,-34} {1}" -f "$Name :", $Value)
}

function Add-Note { param([string]$Text) Add-Line "  >> $Text" }

# Always returns an array, never a bare $null, so @(Get-Cim ...) can't produce a
# one-element array containing $null (which would read as "one page file" etc).
function Get-Cim {
    param([string]$Class, [string]$Namespace = 'root/cimv2')
    try {
        @(Get-CimInstance -ClassName $Class -Namespace $Namespace -ErrorAction Stop |
            Where-Object { $null -ne $_ })
    } catch { @() }
}

function Test-Exe {
    param([string]$Name)
    $c = Get-Command $Name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

function Get-ExeVersion {
    param([string]$Name, [string[]]$VersionArgs = @('--version'))
    $path = Test-Exe $Name
    if (-not $path) { return $null }
    try {
        $out = & $Name @VersionArgs 2>&1 | Select-Object -First 1
        return "$path  [$out]"
    } catch { return $path }
}

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# ---------------------------------------------------------------- header ----
Add-Line 'XAV SYSTEM PROBE'
Add-Line ('-' * 78)
Add-Field 'Generated'   (Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')
Add-Field 'Machine'     $env:COMPUTERNAME
Add-Field 'Elevated'    $(if ($isAdmin) { 'yes' } else { 'NO - some checks limited' })
Add-Field 'PowerShell'  $PSVersionTable.PSVersion

# --------------------------------------------------------------- windows ----
Add-Section 'WINDOWS  (plan SS2.4, SS4 Phase 0)'

$os  = Get-Cim Win32_OperatingSystem | Select-Object -First 1
$cv  = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$bld = $null
try {
    $r   = Get-ItemProperty $cv -ErrorAction Stop
    $bld = [int]$r.CurrentBuildNumber
    Add-Field 'Edition'        $r.ProductName
    Add-Field 'Display version' $r.DisplayVersion
    Add-Field 'Build'          "$($r.CurrentBuildNumber).$($r.UBR)"
} catch {
    Add-Field 'Caption' $os.Caption
    Add-Field 'Version' $os.Version
}
Add-Field 'Architecture' $env:PROCESSOR_ARCHITECTURE

if ($bld) {
    if ($bld -ge 22000) {
        Add-Note "Build >= 22000: platform/windows.rs IORING write path is available."
    } else {
        Add-Note "Build < 22000: IORING UNAVAILABLE. Needs an overlapped-I/O fallback (plan SS4 Phase 0)."
    }
}

$devMode = $null
try {
    $devMode = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' `
        -ErrorAction Stop).AllowDevelopmentWithoutDevLicense
} catch { }
Add-Field 'Developer mode' $(if ($devMode -eq 1) { 'enabled' } else { 'disabled' })

$lpEnabled = $null
try {
    $lpEnabled = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
        -Name LongPathsEnabled -ErrorAction Stop).LongPathsEnabled
} catch { }
Add-Field 'Long paths enabled' $(if ($lpEnabled -eq 1) { 'yes' } else { 'no' })

# ------------------------------------------------------------------- cpu ----
Add-Section 'CPU  (plan SS2.2 - AVX2 is a HARD build requirement)'

$cpu = @(Get-Cim Win32_Processor)
foreach ($c in $cpu) {
    Add-Field 'Model'            $c.Name.Trim()
    Add-Field 'Physical cores'   $c.NumberOfCores
    Add-Field 'Logical cores'    $c.NumberOfLogicalProcessors
    Add-Field 'Max clock (MHz)'  $c.MaxClockSpeed
    Add-Field 'L2 cache (KB)'    $c.L2CacheSize
    Add-Field 'L3 cache (KB)'    $c.L3CacheSize
}
Add-Field 'NUMBER_OF_PROCESSORS' $env:NUMBER_OF_PROCESSORS

# Instruction-set detection via IsProcessorFeaturePresent.
# PF_AVX_INSTRUCTIONS_AVAILABLE = 39, PF_AVX2 = 40, PF_AVX512F = 41
$pfOk = $false
try {
    if (-not ('Xav.PF' -as [type])) {
        Add-Type -Namespace Xav -Name PF -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern bool IsProcessorFeaturePresent(uint feature);
'@ -ErrorAction Stop
    }
    $pfOk = $true
} catch { }

if ($pfOk) {
    $avx    = [Xav.PF]::IsProcessorFeaturePresent(39)
    $avx2   = [Xav.PF]::IsProcessorFeaturePresent(40)
    $avx512 = [Xav.PF]::IsProcessorFeaturePresent(41)
    Add-Field 'AVX'     $avx
    Add-Field 'AVX2'    $avx2
    Add-Field 'AVX-512' $avx512

    if (-not $avx2) {
        Add-Note 'STOP: no AVX2. XAV cannot build -- build.rs assembles no kernels below'
        Add-Note '      AVX2 and the Rust code calls ~20 of those symbols unconditionally.'
    } elseif ($avx512) {
        Add-Note 'AVX-512 present: asm/avx512/* kernels will be selected by target-cpu=native.'
    } else {
        Add-Note 'AVX2 only: asm/avx2/* kernels will be used. Fine -- this is the supported floor.'
    }
} else {
    Add-Note 'Could not query processor features (Add-Type unavailable).'
}

# Hybrid P/E detection -- matters because AVX-512 is fused off on Intel hybrids,
# and because -w x --lp scheduling behaves differently across core types.
$hybrid = $false
if ($cpu.Count -eq 1 -and $cpu[0].NumberOfLogicalProcessors -gt 0) {
    $cores = $cpu[0].NumberOfCores
    $lps   = $cpu[0].NumberOfLogicalProcessors
    if ($lps -ne $cores -and $lps -ne (2 * $cores)) {
        $hybrid = $true
        Add-Note "Logical($lps) is neither 1x nor 2x physical($cores): likely a hybrid P/E-core CPU."
        Add-Note 'Hybrid CPUs: Intel fuses AVX-512 off. Pin encodes to P-cores if fps is erratic.'
    }
}
Add-Field 'Hybrid P/E suspected' $hybrid

# ---------------------------------------------------------------- memory ----
Add-Section 'MEMORY  (plan SS5.2 - worker count is a MEMORY decision first)'

$totalKB = $os.TotalVisibleMemorySize
$freeKB  = $os.FreePhysicalMemory
$totalGB = [math]::Round($totalKB / 1MB, 1)
$freeGB  = [math]::Round($freeKB  / 1MB, 1)
Add-Field 'Total RAM (GB)' $totalGB
Add-Field 'Free  RAM (GB)' $freeGB

$sticks = @(Get-Cim Win32_PhysicalMemory)
foreach ($s in $sticks) {
    Add-Field "  DIMM $($s.DeviceLocator)" `
        ("{0} GB @ {1} MT/s ({2})" -f [math]::Round($s.Capacity/1GB,0), $s.ConfiguredClockSpeed, $s.Manufacturer)
}

$pf = @(Get-Cim Win32_PageFileUsage)
if ($pf.Count -eq 0) {
    Add-Field 'Page file' 'NONE'
    Add-Note 'No page file. XAV spikes at chunk boundaries -- a missing page file turns'
    Add-Note 'a transient spike into a hard OOM abort mid-encode. Set system-managed (plan SS5.3).'
} else {
    foreach ($p in $pf) {
        Add-Field 'Page file' ("{0}  alloc {1} MB, peak {2} MB" -f $p.Name, $p.AllocatedBaseSize, $p.PeakUsage)
    }
}

# Worker-count guidance straight from src/guide.txt SS2.3
Add-Line
Add-Line '  Per-worker chunk memory (guide.txt SS2.3: bytes/frame x 300 frames):'
foreach ($m in @(
    @{ n = '1080p  8-bit'; b = 1.5 * 1920 * 1080 * 300 },
    @{ n = '1080p 10-bit'; b = 3.0 * 1920 * 1080 * 300 },
    @{ n = '4K     8-bit'; b = 1.5 * 3840 * 2160 * 300 },
    @{ n = '4K    10-bit'; b = 3.0 * 3840 * 2160 * 300 })) {
    $gb  = [math]::Round($m.b / 1GB, 2)
    # Leave ~8 GB for Windows + decode + mux overhead.
    $max = [math]::Max(1, [math]::Floor(($totalGB - 8) / $gb))
    Add-Line ("    {0,-14} {1,6} GB/worker   -> max ~{2} workers on this box" -f $m.n, $gb, $max)
}
Add-Note 'These are ceilings from memory alone. Start at half and measure (plan SS5.2, SS7.1).'

# ------------------------------------------------------------------- gpu ----
Add-Section 'GPU  (plan SS3 - decides WSL2 vs native, and cuda vs vulkan features)'

$gpus = @(Get-Cim Win32_VideoController)
$hasNvidia = $false; $hasAmd = $false; $hasIntel = $false
foreach ($g in $gpus) {
    Add-Field 'Adapter'       $g.Name
    Add-Field '  Driver ver'  $g.DriverVersion
    Add-Field '  Driver date' $g.DriverDate
    # AdapterRAM is a signed 32-bit field and lies above 4 GB; report qualified.
    if ($g.AdapterRAM -gt 0) {
        Add-Field '  Reported VRAM (GB)' ([math]::Round($g.AdapterRAM / 1GB, 1))
    }
    switch -Regex ($g.Name) {
        'NVIDIA|GeForce|RTX|GTX|Quadro' { $hasNvidia = $true }
        'AMD|Radeon|RX '                { $hasAmd    = $true }
        'Intel|Arc|UHD|Iris'            { $hasIntel  = $true }
    }
}

# nvidia-smi is authoritative for VRAM and CUDA version.
$smi = Test-Exe 'nvidia-smi'
if ($smi) {
    Add-Field 'nvidia-smi' $smi
    try {
        $q = & nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap `
                          --format=csv,noheader 2>&1
        foreach ($l in $q) { Add-Line "    $l" }
    } catch { Add-Note 'nvidia-smi present but query failed.' }
}

Add-Line
if ($hasNvidia) {
    Add-Note 'NVIDIA detected ->'
    Add-Note '  build features: vship,cuda   |  --hwdec uses *_cuvid (ffms.rs:579)'
    Add-Note '  WSL2 route is viable: CUDA passes through to WSL2 (plan SS3).'
} elseif ($hasAmd -or $hasIntel) {
    Add-Note 'AMD/Intel GPU, no NVIDIA ->'
    Add-Note '  build features: vship (Vulkan backend), NOT cuda -- cuda will fail to link.'
    Add-Note '  WSL2 has no reliable Vulkan passthrough, so TQ/--hwdec need the NATIVE'
    Add-Note '  port. This promotes plan Phase 2/3 from "nice" to "required" (plan SS3).'
} else {
    Add-Note 'No discrete GPU identified -- CPU-only. Build without vship (no TQ), or'
    Add-Note 'accept CPU metrics. --hwdec will not help.'
}

# --------------------------------------------------------------- storage ----
Add-Section 'STORAGE  (plan SS5.3 - XAV writes many small chunk files)'

try {
    $disks = @(Get-PhysicalDisk -ErrorAction Stop)
    foreach ($d in $disks) {
        Add-Field 'Physical disk' `
            ("{0}  {1}  {2} GB  bus={3}" -f $d.FriendlyName, $d.MediaType,
             [math]::Round($d.Size/1GB,0), $d.BusType)
    }
} catch { Add-Note 'Get-PhysicalDisk unavailable (needs Windows 8+ / elevation).' }

Add-Line
foreach ($v in (Get-Cim Win32_LogicalDisk | Where-Object DriveType -eq 3)) {
    $freeG  = [math]::Round($v.FreeSpace / 1GB, 1)
    $sizeG  = [math]::Round($v.Size      / 1GB, 1)
    Add-Field "Volume $($v.DeviceID)" "$freeG GB free of $sizeG GB"
}

try {
    foreach ($b in (Get-BitLockerVolume -ErrorAction Stop)) {
        if ($b.ProtectionStatus -ne 'Off') {
            Add-Field "BitLocker $($b.MountPoint)" $b.ProtectionStatus
        }
    }
} catch { }

# -------------------------------------------------------------- defender ----
Add-Section 'DEFENDER & POWER  (plan SS5.3 - biggest Windows-specific wins)'

try {
    $mp = Get-MpPreference -ErrorAction Stop
    $ms = Get-MpComputerStatus -ErrorAction Stop
    Add-Field 'Real-time protection' $ms.RealTimeProtectionEnabled
    $ex = @($mp.ExclusionPath)
    if ($ex.Count -gt 0 -and $ex[0]) {
        Add-Field 'Existing path exclusions' $ex.Count
        foreach ($e in $ex) { Add-Line "    $e" }
    } else {
        Add-Field 'Existing path exclusions' 'none'
    }
    if ($ms.RealTimeProtectionEnabled) {
        Add-Note 'Add exclusions before benchmarking (plan SS5.3 item 1):'
        Add-Note '  media dir, the .<hash7>/ working dirs XAV creates next to inputs,'
        Add-Note '  %USERPROFILE%\.local\src, the xav repo, and the xav.exe process.'
    }
} catch { Add-Note 'Defender query failed (needs elevation, or third-party AV installed).' }

Add-Line
try {
    $active = ((powercfg /getactivescheme) 2>&1 | Out-String).Trim()
    Add-Field 'Active power plan' $active
    if ($active -notmatch 'Ultimate|High performance') {
        Add-Note 'Not on High/Ultimate Performance. Long encodes lose throughput to core'
        Add-Note 'parking and clock stepping (plan SS5.3 item 2).'
    }
} catch { }

# ------------------------------------------------------------------ wsl2 ----
Add-Section 'WSL2  (plan SS3, Phase 1 - the optimal build lives here)'

$wsl = Test-Exe 'wsl'
if ($wsl) {
    Add-Field 'wsl.exe' $wsl
    try {
        # wsl.exe emits UTF-16LE; normalise so the report is readable.
        $prev = [Console]::OutputEncoding
        [Console]::OutputEncoding = [Text.Encoding]::Unicode
        $list = (& wsl.exe --list --verbose) 2>&1
        [Console]::OutputEncoding = $prev
        foreach ($l in $list) {
            $t = ("$l" -replace "`0", '').Trim()
            if ($t) { Add-Line "    $t" }
        }
    } catch { Add-Note 'wsl --list failed.' }
} else {
    Add-Field 'wsl.exe' 'not installed'
    Add-Note 'Phase 1 needs: wsl --install -d Ubuntu-24.04'
}

$wslCfg = Join-Path $env:USERPROFILE '.wslconfig'
if (Test-Path $wslCfg) {
    Add-Field '.wslconfig' $wslCfg
    foreach ($l in (Get-Content $wslCfg)) { Add-Line "    $l" }
} else {
    Add-Field '.wslconfig' 'absent'
    $suggest = [math]::Floor($totalGB * 0.75)
    Add-Note "Suggested memory=${suggest}GB, swap=0, processors=$env:NUMBER_OF_PROCESSORS (plan SS5.4)."
}

# ------------------------------------------------------------- toolchain ----
Add-Section 'EXISTING TOOLCHAIN  (plan SS4 Phase 3)'

foreach ($t in @(
    @{ n = 'rustup'; a = @('--version') },
    @{ n = 'cargo';  a = @('--version') },
    @{ n = 'rustc';  a = @('--version') },
    @{ n = 'clang';  a = @('--version') },
    @{ n = 'nasm';   a = @('-v')        },
    @{ n = 'cmake';  a = @('--version') },
    @{ n = 'ninja';  a = @('--version') },
    @{ n = 'meson';  a = @('--version') },
    @{ n = 'git';    a = @('--version') },
    @{ n = 'nvcc';   a = @('--version') },
    @{ n = 'ffmpeg'; a = @('-version')  },
    @{ n = 'x264';   a = @('--version') },
    @{ n = 'x265';   a = @('--version') })) {
    Add-Field $t.n (Get-ExeVersion -Name $t.n -VersionArgs $t.a)
}

foreach ($p in @('C:\msys64', "$env:ProgramFiles\Microsoft Visual Studio",
                 "$env:ProgramFiles\NVIDIA GPU Computing Toolkit\CUDA")) {
    Add-Field "Path: $(Split-Path $p -Leaf)" $(if (Test-Path $p) { $p } else { 'absent' })
}

$wt = Get-AppxPackage -Name 'Microsoft.WindowsTerminal' -ErrorAction SilentlyContinue
Add-Field 'Windows Terminal' $(if ($wt) { $wt.Version } else { 'not installed (plan SS5.3 item 8)' })

# ----------------------------------------------------------------- verdict --
Add-Section 'VERDICT'

if ($pfOk -and -not [Xav.PF]::IsProcessorFeaturePresent(40)) {
    Add-Line '  BLOCKED: no AVX2 -- XAV cannot be built on this machine.'
} else {
    Add-Line '  Buildable. Recommended path:'
    Add-Line
    if ($hasNvidia) {
        Add-Line '    Route : WSL2 first (full no_std/io_uring build, CUDA passes through),'
        Add-Line '            then the native port for the GUI.        [plan SS3]'
        Add-Line '    Feats : --features vship,cuda'
    } elseif ($hasAmd -or $hasIntel) {
        Add-Line '    Route : native port is REQUIRED for TQ/--hwdec (no Vulkan in WSL2).'
        Add-Line '            WSL2 still useful as the CPU-only perf reference. [plan SS3]'
        Add-Line '    Feats : --features vship   (NOT cuda)'
    } else {
        Add-Line '    Route : WSL2 first; CPU-only.                     [plan SS3]'
        Add-Line '    Feats : --no-default-features  (no TQ)'
    }
    Add-Line '    Flags : -C target-cpu=native   (mandatory, not optional -- plan SS2.2)'
    Add-Line
    Add-Line '  Next: send xav-probe-report.txt back, then answer the three decisions'
    Add-Line '        in docs/windows/PLAN.md SS9.'
}
Add-Line

# ------------------------------------------------------------------ emit ----
$text = $script:Report.ToString()
Write-Output $text
try {
    $text | Out-File -FilePath $OutFile -Encoding utf8
    Write-Output "`nReport written to: $OutFile"
} catch {
    Write-Warning "Could not write $OutFile : $_"
}
