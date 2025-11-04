#!/bin/bash

# Test script for Save Cinnamon Session extension

echo "Testing Save Cinnamon Session Extension"
echo "======================================="

# Check if extension directory exists
EXT_DIR="$HOME/.local/share/cinnamon/extensions/save-cinnamon-session@retiarylime"
if [ ! -d "$EXT_DIR" ]; then
    echo "❌ Extension not installed at $EXT_DIR"
    exit 1
fi

echo "✅ Extension directory found"

# Check if session file exists
SESSION_FILE="$HOME/.cinnamon-session-save.json"
if [ -f "$SESSION_FILE" ]; then
    echo "✅ Session file exists: $SESSION_FILE"
    echo "   Last modified: $(stat -c %y "$SESSION_FILE")"
    echo "   Size: $(stat -c %s "$SESSION_FILE") bytes"
else
    echo "⚠️  No session file found at $SESSION_FILE"
fi

# Test manual save using the keybinding simulation
echo ""
echo "Testing manual session save..."
echo "Press Super+Shift+S to manually save session"
echo "Press Super+Shift+R to manually restore session"

# Show current windows for reference
echo ""
echo "Current windows that should be saved:"
echo "======================================="
wmctrl -l 2>/dev/null || echo "wmctrl not available - install with: sudo apt install wmctrl"

echo ""
echo "Monitoring logs for save-cinnamon-session activity..."
echo "Press Ctrl+C to stop monitoring"
journalctl --user -f | grep "save-cinnamon-session" &
LOG_PID=$!

# Wait for user input
echo ""
echo "Press Enter when you've tested the keybindings..."
read -r

# Stop log monitoring
kill $LOG_PID 2>/dev/null

# Check if session was updated
if [ -f "$SESSION_FILE" ]; then
    echo ""
    echo "Final session file status:"
    echo "========================="
    echo "Size: $(stat -c %s "$SESSION_FILE") bytes"
    echo "Last modified: $(stat -c %y "$SESSION_FILE")"
    echo ""
    echo "Session content preview:"
    head -30 "$SESSION_FILE"
fi