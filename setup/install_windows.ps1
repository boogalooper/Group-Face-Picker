param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("bootstrap-pip", "download-insightface", "download-portrait-preference")]
    [string]$Action,

    [string]$Python = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

# Windows PowerShell 5.1 can otherwise negotiate older protocols on some systems.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # Keep the OS default if the runtime does not expose the enum as expected.
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BootstrapDir = Join-Path $Root "runtime\bootstrap"
$ModelDir = Join-Path $Root "models"
$InsightFaceRoot = Join-Path $ModelDir "insightface\models"
$InsightFacePack = Join-Path $InsightFaceRoot "buffalo_l"
$InsightFaceZip = Join-Path $Root "runtime\downloads\buffalo_l.zip"
$InsightFaceUrl = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
$InsightFaceSha256 = "80ffe37d8a5940d59a7384c201a2a38d4741f2f3c51eef46ebb28218a7b0ca2f"
$PortraitPreferenceDir = Join-Path $ModelDir "portrait_preference"
$PortraitPreferenceModel = Join-Path $PortraitPreferenceDir "beauty_resnet.caffemodel"
$PortraitPreferenceProto = Join-Path $PortraitPreferenceDir "beauty_resnet.prototxt"
$PortraitPreferenceModelUrl = "https://raw.githubusercontent.com/asiryan/HowCuteAmI/main/models/beauty_resnet.caffemodel"
$PortraitPreferenceProtoUrl = "https://raw.githubusercontent.com/asiryan/HowCuteAmI/main/models/beauty_resnet.prototxt"

function Invoke-WindowsDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$OutFile
    )

    $parent = Split-Path -Parent $OutFile
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    # Invoke-WebRequest uses the Windows/.NET TLS stack and therefore honors
    # trusted roots installed by products such as Kaspersky HTTPS inspection.
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -TimeoutSec 900
}

function Test-FileHash {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )

    $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "SHA-256 mismatch for $Path. Expected $ExpectedSha256, got $actual"
    }
}


function Get-LatestUniversalWheel {
    param([Parameter(Mandatory = $true)][string]$Package)

    $apiUrl = "https://pypi.org/pypi/$Package/json"
    Write-Host "Reading PyPI metadata for $Package through Windows TLS..."
    $meta = Invoke-RestMethod -Uri $apiUrl -TimeoutSec 60
    $version = [string]$meta.info.version
    $releaseProperty = $meta.releases.PSObject.Properties[$version]
    if ($null -eq $releaseProperty) {
        throw "PyPI metadata did not contain release $version for $Package"
    }

    $files = @($releaseProperty.Value)
    $wheel = $files | Where-Object {
        $_.filename -like "*.whl" -and $_.filename -like "*none-any.whl"
    } | Select-Object -First 1

    if ($null -eq $wheel) {
        throw "No universal wheel found for $Package $version"
    }

    return [PSCustomObject]@{
        Package = $Package
        Version = $version
        FileName = [string]$wheel.filename
        Url = [string]$wheel.url
        Sha256 = [string]$wheel.digests.sha256
    }
}

function Bootstrap-Pip {
    if ([string]::IsNullOrWhiteSpace($Python)) {
        throw "-Python is required for bootstrap-pip"
    }
    if (-not (Test-Path $Python)) {
        throw "Python executable not found: $Python"
    }

    # A failed previous bootstrap may have left stale wheels behind. Start from
    # an empty directory so --find-links cannot accidentally pick an old file.
    Remove-Item -Recurse -Force $BootstrapDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $BootstrapDir | Out-Null

    $downloaded = @{}
    # wheel 0.48+ depends on packaging>=24.0. Keep the complete small
    # bootstrap set local so the resolver never needs HTTPS at this stage.
    foreach ($package in @("pip", "setuptools", "packaging", "wheel")) {
        $item = Get-LatestUniversalWheel -Package $package
        $destination = Join-Path $BootstrapDir $item.FileName
        Write-Host "Downloading $($item.Package) $($item.Version) using Windows TLS..."
        Invoke-WindowsDownload -Uri $item.Url -OutFile $destination
        Test-FileHash -Path $destination -ExpectedSha256 $item.Sha256
        Write-Host "  SHA-256 OK: $($item.FileName)"
        $downloaded[$package] = $destination
    }

    # A fresh `uv venv` intentionally does not require pip to be present.
    # Bootstrap pip itself with uv, using only the SHA-256 verified wheels
    # downloaded above. This avoids the impossible `python -m pip install pip`
    # cycle when pip is not installed yet.
    $uvExe = Join-Path $Root "runtime\uv\uv.exe"
    if (-not (Test-Path -LiteralPath $uvExe -PathType Leaf)) {
        throw "Local uv executable not found: $uvExe"
    }

    Write-Host "Installing pip/setuptools/packaging/wheel locally with uv (--no-index)..."
    & $uvExe pip install --python $Python --no-index --find-links $BootstrapDir --upgrade pip setuptools packaging wheel
    if ($LASTEXITCODE -ne 0) {
        throw "Local bootstrap package installation through uv failed with exit code $LASTEXITCODE"
    }

    Write-Host "Bootstrap complete:"
    & $Python -m pip --version
    if ($LASTEXITCODE -ne 0) {
        throw "pip version check failed"
    }

    # Bootstrap files are disposable.
    Remove-Item -Recurse -Force $BootstrapDir -ErrorAction SilentlyContinue
}


function Download-PortraitPreference {
    $modelOk = (Test-Path -LiteralPath $PortraitPreferenceModel -PathType Leaf) -and ((Get-Item $PortraitPreferenceModel).Length -gt 40000000)
    $protoOk = (Test-Path -LiteralPath $PortraitPreferenceProto -PathType Leaf) -and ((Get-Item $PortraitPreferenceProto).Length -gt 10000)
    if ($modelOk -and $protoOk) {
        Write-Host "Portrait preference model already present: $PortraitPreferenceDir"
        return
    }

    $stageDir = Join-Path $Root "runtime\downloads\portrait_preference_stage"
    $stageModel = Join-Path $stageDir "beauty_resnet.caffemodel"
    $stageProto = Join-Path $stageDir "beauty_resnet.prototxt"
    $backupDir = Join-Path $ModelDir "portrait_preference_backup"
    Remove-Item -Recurse -Force $stageDir -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $backupDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

    try {
        Write-Host "Downloading public HowCuteAmI ResNet-18 portrait preference model..."
        Invoke-WindowsDownload -Uri $PortraitPreferenceProtoUrl -OutFile $stageProto
        Invoke-WindowsDownload -Uri $PortraitPreferenceModelUrl -OutFile $stageModel

        if ((Get-Item $stageModel).Length -le 40000000) {
            throw "Downloaded portrait preference model is unexpectedly small or incomplete"
        }
        if ((Get-Item $stageProto).Length -le 10000) {
            throw "Downloaded portrait preference prototxt is unexpectedly small or incomplete"
        }

        New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null
        $hadOldDir = Test-Path -LiteralPath $PortraitPreferenceDir -PathType Container
        if ($hadOldDir) {
            Move-Item -LiteralPath $PortraitPreferenceDir -Destination $backupDir
        }
        try {
            Move-Item -LiteralPath $stageDir -Destination $PortraitPreferenceDir
        } catch {
            Remove-Item -Recurse -Force $PortraitPreferenceDir -ErrorAction SilentlyContinue
            if ($hadOldDir -and (Test-Path -LiteralPath $backupDir -PathType Container)) {
                Move-Item -LiteralPath $backupDir -Destination $PortraitPreferenceDir
            }
            throw
        }
        Remove-Item -Recurse -Force $backupDir -ErrorAction SilentlyContinue
        Write-Host "Portrait preference model installed: $PortraitPreferenceDir"
    } finally {
        Remove-Item -Recurse -Force $stageDir -ErrorAction SilentlyContinue
        if ((Test-Path -LiteralPath $PortraitPreferenceDir -PathType Container) -and
            (Test-Path -LiteralPath $backupDir -PathType Container)) {
            Remove-Item -Recurse -Force $backupDir -ErrorAction SilentlyContinue
        }
    }
}

function Download-InsightFace {
    $required = @(
        "det_10g.onnx",
        "w600k_r50.onnx",
        "2d106det.onnx",
        "1k3d68.onnx",
        "genderage.onnx"
    )
    $complete = $true
    foreach ($name in $required) {
        $candidate = Join-Path $InsightFacePack $name
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or (Get-Item -LiteralPath $candidate).Length -lt 100000) {
            $complete = $false
            break
        }
    }
    if ($complete) {
        Write-Host "Complete InsightFace buffalo_l already present: $InsightFacePack"
        return
    }

    $downloadDir = Split-Path -Parent $InsightFaceZip
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    Remove-Item -Force $InsightFaceZip -ErrorAction SilentlyContinue

    Write-Host "Downloading official InsightFace buffalo_l model pack using Windows TLS..."
    Invoke-WindowsDownload -Uri $InsightFaceUrl -OutFile $InsightFaceZip
    Test-FileHash -Path $InsightFaceZip -ExpectedSha256 $InsightFaceSha256
    Write-Host "  SHA-256 OK: buffalo_l.zip"

    $extract = Join-Path $Root "runtime\\downloads\\buffalo_l_extract"
    Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $extract | Out-Null
    Expand-Archive -Path $InsightFaceZip -DestinationPath $extract -Force

    $source = $extract
    if (Test-Path (Join-Path $extract "buffalo_l")) {
        $source = Join-Path $extract "buffalo_l"
    }
    if (-not (Test-Path (Join-Path $source "det_10g.onnx"))) {
        throw "Downloaded buffalo_l archive does not contain det_10g.onnx"
    }
    if (-not (Test-Path (Join-Path $source "w600k_r50.onnx"))) {
        throw "Downloaded buffalo_l archive does not contain w600k_r50.onnx"
    }
    foreach ($name in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)) {
            throw "Downloaded buffalo_l archive does not contain $name"
        }
    }

    New-Item -ItemType Directory -Force -Path $InsightFaceRoot | Out-Null
    $backupPack = Join-Path $InsightFaceRoot "buffalo_l_backup"
    Remove-Item -Recurse -Force $backupPack -ErrorAction SilentlyContinue
    $hadOldPack = Test-Path -LiteralPath $InsightFacePack -PathType Container
    if ($hadOldPack) {
        Move-Item -LiteralPath $InsightFacePack -Destination $backupPack
    }
    try {
        Move-Item -LiteralPath $source -Destination $InsightFacePack
    } catch {
        Remove-Item -Recurse -Force $InsightFacePack -ErrorAction SilentlyContinue
        if ($hadOldPack -and (Test-Path -LiteralPath $backupPack -PathType Container)) {
            Move-Item -LiteralPath $backupPack -Destination $InsightFacePack
        }
        throw
    }
    Remove-Item -Recurse -Force $backupPack -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
    Remove-Item -Force $InsightFaceZip -ErrorAction SilentlyContinue
    Write-Host "InsightFace model installed: $InsightFacePack"
}

try {
    switch ($Action) {
        "bootstrap-pip" { Bootstrap-Pip }
        "download-insightface" { Download-InsightFace }
        "download-portrait-preference" { Download-PortraitPreference }
    }
    exit 0
} catch {
    Write-Host ""
    Write-Host "PowerShell installer error:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "Windows TLS is used here; no certificate verification is disabled."
    Write-Host "If Kaspersky HTTPS inspection is enabled, its root CA must be trusted by Windows."
    exit 1
}
