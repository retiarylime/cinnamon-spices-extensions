#!/usr/bin/env gjs

// Test script for session management
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

function testSessionSave() {
    const sessionFile = GLib.get_home_dir() + "/.cinnamon-session-save.json";
    
    // Create a test session data
    const sessionData = {
        timestamp: Date.now(),
        windows: [
            {
                app: "test-app",
                title: "Test Window",
                x: 100,
                y: 100,
                width: 800,
                height: 600,
                workspace: 0,
                maximized: false,
                minimized: false,
                monitor: 0
            }
        ],
        workspaces: {
            "0": {
                name: "Workspace 1",
                windowCount: 1
            }
        },
        currentWorkspace: 0
    };
    
    try {
        let jsonData = JSON.stringify(sessionData, null, 2);
        let file = Gio.File.new_for_path(sessionFile);
        let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        let bytes = new GLib.Bytes(jsonData);
        stream.write_bytes(bytes, null);
        stream.close(null);
        
        print("Test session file created at: " + sessionFile);
        print("Content:");
        print(jsonData);
    } catch (e) {
        print("Error creating test session: " + e);
    }
}

testSessionSave();