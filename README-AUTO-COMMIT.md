# Auto-Commit Setup

This repository is configured to automatically commit and push changes to GitHub.

## Setup Options

### Option 1: PowerShell Watcher (Recommended for Windows)
Run the PowerShell script to watch for file changes:
```powershell
.\auto-commit.ps1
```

### Option 2: Batch File Watcher (Windows)
Run the batch file:
```cmd
auto-commit.bat
```

### Option 3: Git Hook (Auto-push after manual commits)
The `.git/hooks/post-commit` hook will automatically push after you manually commit.

## How It Works

- **File Watcher**: Monitors `index.html` for changes and automatically commits/pushes
- **Git Hook**: Automatically pushes after any manual commit

## Note

The file watcher scripts need to be running in a separate terminal window. They will continue running until you stop them (Ctrl+C).
