$rules = @(
  @{Name='Vite 5173'; Port=5173},
  @{Name='maxailearning backend 4000'; Port=4000}
)

foreach ($r in $rules) {
  try {
    $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    if (-not $existing) {
      New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -LocalPort $r.Port -Protocol TCP -Action Allow -Profile Any -Description "Added by maxailearning script"
      Write-Output "Added firewall rule: $($r.Name) on port $($r.Port)"
    } else {
      Write-Output "Rule already exists: $($r.Name)"
    }
  } catch {
    Write-Output "Failed to manage rule $($r.Name): $($_.Exception.Message)"
  }
}

# Simple connectivity test
Test-NetConnection -ComputerName 127.0.0.1 -Port 5173 | Format-List -Property @{Name='Port5173Reachable';Expression={$_.TcpTestSucceeded}},TcpTestSucceeded
Test-NetConnection -ComputerName 127.0.0.1 -Port 4000 | Format-List -Property @{Name='Port4000Reachable';Expression={$_.TcpTestSucceeded}},TcpTestSucceeded
Write-Output "Done."
