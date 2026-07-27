param(
    [string]$BootstrapDir = $PSScriptRoot,
    [string]$EnrollmentToken,
    [switch]$SkipEnrollment
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Set-ManagedBlock {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BeginMarker,
        [Parameter(Mandatory = $true)][string]$EndMarker,
        [Parameter(Mandatory = $true)][string]$Block
    )

    $Parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $Parent -Force | Out-Null
    $Current = if (Test-Path $Path) {
        [System.IO.File]::ReadAllText($Path)
    } else {
        ""
    }
    $EscapedBegin = [regex]::Escape($BeginMarker)
    $EscapedEnd = [regex]::Escape($EndMarker)
    $Pattern = "(?ms)^$EscapedBegin\r?\n.*?^$EscapedEnd\r?\n?"
    if ([regex]::IsMatch($Current, $Pattern)) {
        $Next = [regex]::Replace($Current, $Pattern, "")
    } else {
        $Next = $Current
    }
    $Next = $Next.TrimEnd()
    if ($Next.Length -gt 0) {
        $Next += [Environment]::NewLine + [Environment]::NewLine
    }
    $Next += $Block.TrimEnd() + [Environment]::NewLine
    [System.IO.File]::WriteAllText(
        $Path,
        $Next,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function New-DedicatedKey {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Comment
    )

    if ((Test-Path $Path) -xor (Test-Path "$Path.pub")) {
        throw "Par de chaves incompleto em $Path; remova ou restaure o par."
    }
    if (-not (Test-Path $Path)) {
        & ssh-keygen.exe -q -t ed25519 -N '""' -C $Comment -f $Path
        if ($LASTEXITCODE -ne 0) {
            throw "ssh-keygen falhou ao criar $Comment."
        }
    }
    & icacls.exe $Path /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Não foi possível restringir a ACL de $Path."
    }
}

$InfoPath = Join-Path $BootstrapDir "bridge-info.json"
$KnownHostsSource = Join-Path $BootstrapDir "cockpit-linux-known_hosts"
$TunnelSource = Join-Path $BootstrapDir "start-mcp-tunnel.ps1"
foreach ($Required in @($InfoPath, $KnownHostsSource, $TunnelSource)) {
    if (-not (Test-Path $Required -PathType Leaf)) {
        throw "Arquivo de bootstrap ausente: $Required"
    }
}

$Info = Get-Content -Raw -Path $InfoPath | ConvertFrom-Json
if (
    -not $Info.host -or
    -not $Info.port -or
    -not $Info.user -or
    -not $Info.repoPath -or
    -not $Info.tokenCommand
) {
    throw "bridge-info.json está incompleto."
}

foreach ($Command in @("ssh.exe", "ssh-keygen.exe", "icacls.exe")) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "OpenSSH Client do Windows é obrigatório: comando ausente $Command"
    }
}

$SshDir = Join-Path $env:USERPROFILE ".ssh"
$CodexDir = Join-Path $env:USERPROFILE ".codex"
$LocalBridgeDir = Join-Path $CodexDir "bridges\cockpit-linux"
$KnownHostsPath = Join-Path $SshDir "cockpit_windows_voice_known_hosts"
$McpKeyPath = Join-Path $SshDir "cockpit_windows_voice_mcp"
$DevKeyPath = Join-Path $SshDir "cockpit_windows_voice_dev"
$SshConfigPath = Join-Path $SshDir "config"
$CodexConfigPath = Join-Path $CodexDir "config.toml"
$TunnelPath = Join-Path $LocalBridgeDir "start-mcp-tunnel.ps1"

New-Item -ItemType Directory -Path $SshDir, $LocalBridgeDir -Force | Out-Null
Copy-Item -LiteralPath $KnownHostsSource -Destination $KnownHostsPath -Force
Copy-Item -LiteralPath $TunnelSource -Destination $TunnelPath -Force

New-DedicatedKey -Path $McpKeyPath -Comment "cockpit-windows-voice-mcp"
New-DedicatedKey -Path $DevKeyPath -Comment "cockpit-windows-voice-dev"

$McpKeyForSsh = $McpKeyPath.Replace("\", "/")
$DevKeyForSsh = $DevKeyPath.Replace("\", "/")
$KnownHostsForSsh = $KnownHostsPath.Replace("\", "/")
$SshBlock = @"
# BEGIN COCKPIT WINDOWS VOICE
Host cockpit-linux-mcp
  HostName $($Info.host)
  Port $($Info.port)
  User $($Info.user)
  IdentityFile "$McpKeyForSsh"
  UserKnownHostsFile "$KnownHostsForSsh"
  StrictHostKeyChecking yes
  IdentitiesOnly yes
  BatchMode yes
  RequestTTY no
  ForwardAgent no
  ExitOnForwardFailure yes
  ServerAliveInterval 15
  ServerAliveCountMax 3
  LogLevel ERROR

Host cockpit-linux-dev
  HostName $($Info.host)
  Port $($Info.port)
  User $($Info.user)
  IdentityFile "$DevKeyForSsh"
  UserKnownHostsFile "$KnownHostsForSsh"
  StrictHostKeyChecking yes
  IdentitiesOnly yes
  BatchMode yes
  ForwardAgent no
  ServerAliveInterval 15
  ServerAliveCountMax 3
  LogLevel ERROR
# END COCKPIT WINDOWS VOICE
"@
Set-ManagedBlock `
    -Path $SshConfigPath `
    -BeginMarker "# BEGIN COCKPIT WINDOWS VOICE" `
    -EndMarker "# END COCKPIT WINDOWS VOICE" `
    -Block $SshBlock

if (-not $SkipEnrollment) {
    $TokenPointer = [IntPtr]::Zero
    $SecureToken = $null
    if (-not $EnrollmentToken) {
        $SecureToken = Read-Host `
            "Token de uso único mostrado por start-enrollment.sh no Linux" `
            -AsSecureString
        $TokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
            $SecureToken
        )
        $EnrollmentToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
            $TokenPointer
        )
    }
    try {
        $Payload = @{
            mcpPublicKey = [System.IO.File]::ReadAllText("$McpKeyPath.pub").Trim()
            devPublicKey = [System.IO.File]::ReadAllText("$DevKeyPath.pub").Trim()
        } | ConvertTo-Json -Compress
        $EnrollmentUri = "http://$($Info.host):$($Info.enrollmentPort)/enroll"
        $Result = Invoke-RestMethod `
            -Method Post `
            -Uri $EnrollmentUri `
            -Headers @{ Authorization = "Bearer $EnrollmentToken" } `
            -ContentType "application/json" `
            -Body $Payload `
            -TimeoutSec 15
        if (-not $Result.ok) {
            throw "O host recusou a matrícula das chaves."
        }
    } finally {
        if ($TokenPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($TokenPointer)
        }
        $EnrollmentToken = $null
        if ($SecureToken) {
            $SecureToken.Dispose()
        }
    }
}

$DevCheck = @(& ssh.exe "cockpit-linux-dev" `
    "printf 'dev-ok\n'; command -v codex; codex --version" 2>&1
)
if ($LASTEXITCODE -ne 0 -or $DevCheck[0] -ne "dev-ok") {
    throw "SSH de desenvolvimento não validou: $($DevCheck -join ' ')"
}

$McpToken = (
    & ssh.exe "cockpit-linux-dev" ([string]$Info.tokenCommand) 2>$null
    ) -join ""
$McpToken = $McpToken.Trim()
if ($LASTEXITCODE -ne 0 -or $McpToken -notmatch '^[!-~]{32,512}$') {
    throw "Não foi possível obter a credencial MCP pelo SSH autenticado."
}
[Environment]::SetEnvironmentVariable(
    "COCKPIT_MCP_TOKEN",
    $McpToken,
    "User"
)
$env:COCKPIT_MCP_TOKEN = $McpToken

$McpBlock = @"
# BEGIN COCKPIT WINDOWS VOICE MCP
[mcp_servers.cockpit_linux]
url = "http://127.0.0.1:3740/mcp"
bearer_token_env_var = "COCKPIT_MCP_TOKEN"
startup_timeout_sec = 15
tool_timeout_sec = 45
required = false
default_tools_approval_mode = "writes"
# END COCKPIT WINDOWS VOICE MCP
"@
Set-ManagedBlock `
    -Path $CodexConfigPath `
    -BeginMarker "# BEGIN COCKPIT WINDOWS VOICE MCP" `
    -EndMarker "# END COCKPIT WINDOWS VOICE MCP" `
    -Block $McpBlock

$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupPath = Join-Path $StartupDir "CockpitMcpTunnel.cmd"
$StartupContent = @"
@echo off
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$TunnelPath"
"@
[System.IO.File]::WriteAllText(
    $StartupPath,
    $StartupContent,
    [System.Text.Encoding]::ASCII
)

$ExistingTunnel = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -like "*start-mcp-tunnel.ps1*"
}
if (-not $ExistingTunnel) {
    Start-Process `
        -FilePath "powershell.exe" `
        -WindowStyle Hidden `
        -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", "`"$TunnelPath`""
        )
}

Start-Sleep -Seconds 2
$PortOpen = Test-NetConnection `
    -ComputerName "127.0.0.1" `
    -Port 3740 `
    -InformationLevel Quiet `
    -WarningAction SilentlyContinue
if (-not $PortOpen) {
    throw "O túnel SSH iniciou, mas 127.0.0.1:3740 não ficou disponível."
}

$Health = "indisponível até o Cockpit Linux reiniciar com a API de controle"
try {
    $HealthResponse = Invoke-RestMethod `
        -Uri "http://127.0.0.1:3740/healthz" `
        -Headers @{ Authorization = "Bearer $McpToken" } `
        -TimeoutSec 5
    if ($HealthResponse.ok) {
        $Health = "Cockpit e MCP prontos"
    }
} catch {
    if (
        $_.Exception.Response -and
        $_.Exception.Response.StatusCode.value__ -eq 503
    ) {
        $Health = "túnel e MCP prontos; reinicie o Cockpit Linux"
    }
}
$McpToken = $null

Write-Host "Ponte instalada." -ForegroundColor Green
Write-Host "  SSH dev: cockpit-linux-dev -> $($Info.repoPath)"
Write-Host "  MCP:     http://127.0.0.1:3740/mcp"
Write-Host "  Estado:  $Health"
Write-Host ""
Write-Host "Feche completamente e reabra o ChatGPT." -ForegroundColor Yellow
Write-Host "Depois habilite cockpit-linux-dev em Settings > Connections."
