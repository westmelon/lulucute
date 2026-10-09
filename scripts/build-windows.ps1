$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
trap {
    $detail = "$($_.Exception.Message) at $($_.InvocationInfo.ScriptLineNumber)" -replace '[\r\n]+', ' '
    Write-Host "::error::$detail"
    exit 1
}

if ($env:OS -ne 'Windows_NT') { throw 'Windows portable packages must be built on Windows.' }
$projectDirectory = Split-Path -Parent $PSScriptRoot
$buildDirectory = Join-Path $projectDirectory 'dist'
$packageDirectory = Join-Path $buildDirectory 'lulucute-windows-x64'
if (Test-Path $packageDirectory) { throw "Output already exists: $packageDirectory. Move or remove it before rebuilding." }

$nodeExecutable = (& node -p 'process.execPath').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Node.js is required to build the package.' }
$nodeArchitecture = (& node -p 'process.arch').Trim()
if ($LASTEXITCODE -ne 0 -or $nodeArchitecture -ne 'x64') { throw 'Build with a 64-bit Node.js runtime.' }
$nodeVersion = (& node -p 'process.version').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the Node.js version.' }

New-Item -ItemType Directory -Path $packageDirectory | Out-Null
foreach ($name in @('src', 'extension', 'node_modules')) {
    Copy-Item (Join-Path $projectDirectory $name) (Join-Path $packageDirectory $name) -Recurse
}
foreach ($name in @('config.example.json', 'package.json', 'package-lock.json', 'README.md')) {
    Copy-Item (Join-Path $projectDirectory $name) $packageDirectory
}
$scriptDirectory = Join-Path $packageDirectory 'scripts'
New-Item -ItemType Directory -Path $scriptDirectory | Out-Null
foreach ($name in @('native-host.mjs', 'portable-launcher.mjs', 'install-native-host.mjs', 'plugins.mjs')) {
    Copy-Item (Join-Path $PSScriptRoot $name) $scriptDirectory
}

$runtimeDirectory = Join-Path $packageDirectory 'runtime'
New-Item -ItemType Directory -Path $runtimeDirectory | Out-Null
Copy-Item $nodeExecutable (Join-Path $runtimeDirectory 'node.exe')
$nodeLicense = Join-Path (Split-Path -Parent $nodeExecutable) 'LICENSE'
if (Test-Path $nodeLicense) {
    Copy-Item $nodeLicense (Join-Path $runtimeDirectory 'LICENSE')
} else {
    Invoke-WebRequest "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile (Join-Path $runtimeDirectory 'LICENSE')
}

$gitArchive = Join-Path $buildDirectory 'MinGit-2.56.0.2-64-bit.zip'
$gitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip'
Invoke-WebRequest $gitUrl -OutFile $gitArchive
$gitHash = (Get-FileHash $gitArchive -Algorithm SHA256).Hash
if ($gitHash -ne 'DA35E72AA21C005A5A0D298CFBAE110BC1609A815730EA0DDE84B01A1B3CD3BE') {
    throw 'Git archive checksum mismatch.'
}
$gitDirectory = Join-Path $packageDirectory 'tools\git'
Expand-Archive $gitArchive -DestinationPath $gitDirectory
foreach ($name in @('cmd\git.exe', 'usr\bin\ssh.exe', 'LICENSE.txt')) {
    if (!(Test-Path (Join-Path $gitDirectory $name))) { throw "Git package is missing $name" }
}
Remove-Item $gitArchive

$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path $compiler)) { throw 'The .NET Framework C# compiler is unavailable.' }
$executable = Join-Path $packageDirectory 'lulucute.exe'
$compilerOutput = & $compiler /nologo /target:winexe /platform:x64 /optimize /codepage:65001 "/out:$executable" `
    /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Runtime.Serialization.dll /reference:System.Xml.dll `
    (Join-Path $PSScriptRoot 'windows-launcher.cs')
Write-Host ($compilerOutput -join "`n")
if ($LASTEXITCODE -ne 0) { throw "Windows launcher compilation failed: $($compilerOutput -join ' ')" }

$archive = Join-Path $buildDirectory 'lulucute-windows-x64.zip'
if (Test-Path $archive) { Remove-Item $archive }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($packageDirectory, $archive, [System.IO.Compression.CompressionLevel]::Optimal, $true)
$hash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  lulucute-windows-x64.zip" | Set-Content (Join-Path $buildDirectory 'lulucute-windows-x64.zip.sha256') -Encoding ascii
Write-Host "Windows package ready: $archive"
