# How to Test the Viking Game

## Option 1: Open in Cursor's Built-in Browser

1. **Right-click on `index.html`** in the file explorer
2. Select **"Open with Live Server"** or **"Open in Browser"**
   - If you don't see this option, install the "Live Server" extension
3. OR use the command palette:
   - Press `Ctrl+Shift+P` (Windows) or `Cmd+Shift+P` (Mac)
   - Type "Simple Browser: Show"
   - Press Enter
   - In the address bar, type: `file:///` followed by the full path to your `index.html`
   - Example: `file:///C:/Users/andre/Downloads/Viking%20Game/index.html`

## Option 2: Open in Brave Browser

1. **Open Brave Browser**
2. Press `Ctrl+O` (Windows) or `Cmd+O` (Mac) to open a file
3. Navigate to: `C:\Users\andre\Downloads\Viking Game\`
4. Select `index.html`
5. Click "Open"

**Note:** You may see CORS errors in the console for audio files - this is normal when opening files directly from disk. The game should still work.

## Option 3: Use a Local Web Server (Recommended)

### Using Python (if installed):
1. Open terminal/command prompt in the game folder
2. Run: `python -m http.server 8000`
3. Open browser and go to: `http://localhost:8000`

### Using Node.js (if installed):
1. Install: `npm install -g http-server`
2. Open terminal in the game folder
3. Run: `http-server`
4. Open the URL shown in the terminal

## Troubleshooting

- **Buttons don't work?** Check the browser console (F12) for errors
- **Game doesn't start?** Look for red error messages in the console
- **Audio errors?** These are normal when opening files directly - the game should still work
