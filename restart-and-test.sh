#!/bin/bash

echo "🔄 Save Cinnamon Session - Test and Fix"
echo "========================================"

# Remove old session file to start fresh
SESSION_FILE="$HOME/.cinnamon-session-save.json"
if [ -f "$SESSION_FILE" ]; then
    echo "🗑️  Removing old session file"
    rm "$SESSION_FILE"
fi

# Restart Cinnamon to reload the extension
echo "🔄 Restarting Cinnamon to reload extension..."
export DISPLAY=:0
nohup cinnamon --replace > /dev/null 2>&1 &

# Wait for Cinnamon to stabilize
echo "⏳ Waiting for Cinnamon to stabilize..."
sleep 8

# Check if session file was created during startup
if [ -f "$SESSION_FILE" ]; then
    echo "✅ Session file created on startup!"
    echo "   Size: $(stat -c %s "$SESSION_FILE") bytes"
    echo "   Content preview:"
    head -10 "$SESSION_FILE"
else
    echo "❌ No session file created on startup"
fi

echo ""
echo "📋 Instructions for testing:"
echo "1. The extension should save sessions automatically every 30 seconds"
echo "2. Use Super+Shift+S to manually save the current session"
echo "3. Use Super+Shift+R to manually restore the saved session"
echo "4. The session will be saved automatically when you log out"
echo ""
echo "🔍 Monitor the session file with:"
echo "   watch -n 1 'ls -la ~/.cinnamon-session-save.json 2>/dev/null || echo \"No session file\"'"
echo ""
echo "📋 To test logout/login restoration:"
echo "1. Open several applications in different positions"
echo "2. Log out (session will be saved automatically)"
echo "3. Log back in (session will be restored automatically)"