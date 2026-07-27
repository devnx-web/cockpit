$ErrorActionPreference = "Stop"

$Ssh = (Get-Command "ssh.exe" -ErrorAction Stop).Source
$Arguments = @(
    "-T",
    "-o", "ExitOnForwardFailure=yes",
    "-L", "127.0.0.1:3740:127.0.0.1:3740",
    "cockpit-linux-mcp",
    "cockpit-mcp-tunnel"
)

$BackoffSeconds = 2
while ($true) {
    $StartedAt = [DateTime]::UtcNow
    & $Ssh @Arguments
    $ConnectedFor = ([DateTime]::UtcNow - $StartedAt).TotalSeconds
    if ($ConnectedFor -ge 60) {
        $BackoffSeconds = 2
    } else {
        $BackoffSeconds = [Math]::Min(30, $BackoffSeconds * 2)
    }
    Start-Sleep -Seconds $BackoffSeconds
}
