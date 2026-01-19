# Auto-commit script for Viking Game
# Watches index.html for changes and automatically commits and pushes

$fileToWatch = "index.html"
$repoPath = Get-Location

Write-Host "Watching $fileToWatch for changes..."
Write-Host "Auto-commit and push enabled. Press Ctrl+C to stop."

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $repoPath
$watcher.Filter = $fileToWatch
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite
$watcher.EnableRaisingEvents = $true

$action = {
    $details = $event.SourceEventArgs
    $name = $details.Name
    $changeType = $details.ChangeType
    
    Write-Host "`n[$([DateTime]::Now)] $changeType detected in $name"
    
    # Wait a moment for file to finish writing
    Start-Sleep -Seconds 1
    
    # Check if there are actual changes
    $status = git status --porcelain
    if ($status -match $fileToWatch) {
        Write-Host "Changes detected. Auto-committing and pushing..."
        
        # Add the file
        git add $fileToWatch
        
        # Commit with timestamp
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        git commit -m "Auto-commit: $timestamp - Game updates"
        
        # Push to remote
        git push origin main
        
        Write-Host "Auto-commit and push completed!`n"
    }
}

Register-ObjectEvent $watcher "Changed" -Action $action | Out-Null

# Keep script running
try {
    while ($true) {
        Start-Sleep -Seconds 1
    }
} finally {
    $watcher.Dispose()
}
