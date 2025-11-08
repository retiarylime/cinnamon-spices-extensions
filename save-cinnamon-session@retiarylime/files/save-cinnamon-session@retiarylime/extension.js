/*
 * Save Cinnamon Session Extension
 * 
 * Automatically saves window positions and applications on logout/shutdown
 * and restores them on login to maintain workspace state across sessions.
 */

const UUID = "save-cinnamon-session@retiarylime";
const Meta = imports.gi.Meta;
const Main = imports.ui.main;
const SignalManager = imports.misc.signalManager;
const Settings = imports.ui.settings;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;
const MessageTray = imports.ui.messageTray;
const St = imports.gi.St;
const Cinnamon = imports.gi.Cinnamon;

let extension = null;

function SaveCinnamonSessionExtension() {
    this._init();
}

SaveCinnamonSessionExtension.prototype = {
    
    _init: function() {
        this._signals = new SignalManager.SignalManager(null);
        this._saveTimeout = null;
        this._restoreTimeout = null;
        this._autoSaveId = null;
        this._sessionFile = GLib.get_home_dir() + "/.cinnamon-session-save.json";
        this._logoutDetected = false;
        this._restoring = false; // flag to avoid overwriting saved session during startup restore
        this._restorationInProgress = false; // prevent concurrent restoration attempts
        this._restorationCompleted = false; // track if restoration is done for this session
        this._loginDetected = false; // track if login was detected during this enable
        this._restoredAppsThisSession = new Set(); // track apps restored in this login session
        this._launchedBrowsers = new Set(); // track which browsers we've launched to prevent extra windows
        this._previousExcludedApps = ""; // track previous exclusion list to detect changes
        
        // Set default values first
        this.autoSaveOnLogout = true;
        this.autoRestoreOnLogin = true;
        this.restoreDelay = 5000; // 5 seconds delay before restoring
        this.excludedApps = "cinnamon-settings,cinnamon-killer-daemon,nemo-desktop";
        this.customAppMappings = ""; // Custom app-to-command mappings
        this.manualSaveKeybinding = "<Super><Shift>s";
        this.manualRestoreKeybinding = "<Super><Shift>r";
        this.debugMode = true; // Enable debug mode by default for better troubleshooting
        
        // Settings - try to bind with error handling
        try {
            this.settings = new Settings.ExtensionSettings(this, UUID);
            this.settings.bind("auto-save-logout", "autoSaveOnLogout", this._onSettingsChanged);
            this.settings.bind("auto-restore-login", "autoRestoreOnLogin", this._onSettingsChanged);
            this.settings.bind("restore-delay", "restoreDelay", this._onSettingsChanged);
            this.settings.bind("excluded-apps", "excludedApps", this._onSettingsChanged);
            this.settings.bind("custom-app-mappings", "customAppMappings", this._onSettingsChanged);
            this.settings.bind("manual-save-keybinding", "manualSaveKeybinding", this._onKeybindingChanged);
            this.settings.bind("manual-restore-keybinding", "manualRestoreKeybinding", this._onKeybindingChanged);
            this.settings.bind("debug-mode", "debugMode", this._onSettingsChanged);
            
            // Store initial excluded apps list for change detection
            this._previousExcludedApps = this.excludedApps;
        } catch (e) {
            global.log("[" + UUID + "] Settings binding failed, using defaults: " + e);
        }
        
        global.log("[" + UUID + "] Extension initialized with auto-save: " + this.autoSaveOnLogout + 
                   ", auto-restore: " + this.autoRestoreOnLogin + ", delay: " + this.restoreDelay + "ms");
    },
    
    enable: function() {
        global.log("[" + UUID + "] Enabling extension");
        // Reset restoration flags on each enable
        this._restoring = true;
        this._restorationInProgress = false;
        this._restorationCompleted = false;
        this._loginDetected = false;
        
        // Connect to session management signals
        this._connectSessionSignals();
        
        // Set up keybindings
        this._setupKeybindings();
        
        // Schedule an initial save, but _saveSession will skip writes while this._restoring is true
        Mainloop.timeout_add(3000, () => {
            this._saveSession();
            return false;
        });
        
        // Check for login restoration with delayed attempts to handle autostart timing
        global.log("[" + UUID + "] Scheduling login detection attempts...");
        
        // Multiple attempts to check for login markers (optimized for speed)
        let loginCheckAttempts = [
            { delay: 100, name: "Instant check" },        // 0.1s - immediate
            { delay: 500, name: "Quick check" },          // 0.5s - very fast  
            { delay: 1500, name: "Fast check" },          // 1.5s - autostart should be done
            { delay: 3000, name: "Safety check" }         // 3s - final safety net
        ];
        
        for (let i = 0; i < loginCheckAttempts.length; i++) {
            let attempt = loginCheckAttempts[i];
            Mainloop.timeout_add(attempt.delay, () => {
                global.log("[" + UUID + "] " + attempt.name + " for login marker...");
                
                // Only check if we haven't already detected login
                if (this._restoring && !this._loginDetected) {
                    let isActualLogin = this._isLoginRestore();
                    global.log("[" + UUID + "] " + attempt.name + " result: " + isActualLogin);
                    
                    if (isActualLogin) {
                        this._loginDetected = true;
                        global.log("[" + UUID + "] LOGIN RESTORE DETECTED - calling _attemptSessionRestore");
                        this._attemptSessionRestore();
                    } else if (i === loginCheckAttempts.length - 1) {
                        // Last attempt failed - clear restoring flag
                        global.log("[" + UUID + "] All login checks failed - clearing restore phase");
                        this._restoring = false;
                        this._loginDetected = false;
                    }
                }
                return false;
            });
        }
    },
    
    _isLoginRestore: function() {
        global.log("[" + UUID + "] _isLoginRestore called - checking for login");
        
        // First try the marker-based approach
        let markerFile = GLib.get_home_dir() + "/.cinnamon-session-login-marker";
        global.log("[" + UUID + "] Checking for login marker at: " + markerFile);
        global.log("[" + UUID + "] File exists check: " + GLib.file_test(markerFile, GLib.FileTest.EXISTS));
        
        if (GLib.file_test(markerFile, GLib.FileTest.EXISTS)) {
            try {
                let [success, contents] = GLib.file_get_contents(markerFile);
                if (success) {
                    let contentStr = contents.toString().trim();
                    global.log("[" + UUID + "] Login marker content: '" + contentStr + "' (length: " + contentStr.length + ")");
                    
                    if (contentStr.length > 0) {
                        let markerTime = parseInt(contentStr);
                        if (!isNaN(markerTime)) {
                            let currentTime = Math.floor(Date.now() / 1000);
                            let timeDiff = currentTime - markerTime;
                            
                            global.log("[" + UUID + "] Login marker time: " + markerTime + ", current: " + currentTime + ", diff: " + timeDiff + "s");
                            
                            if (timeDiff < 600) { // 10 minutes
                                // Delete the marker to prevent repeated restores
                                GLib.unlink(markerFile);
                                global.log("[" + UUID + "] Login marker is recent - DELETING MARKER AND RETURNING TRUE");
                                return true;
                            } else {
                                global.log("[" + UUID + "] Login marker is too old (" + timeDiff + "s) - RETURNING FALSE");
                                return false;
                            }
                        } else {
                            global.log("[" + UUID + "] Login marker contains invalid timestamp: " + contentStr);
                        }
                    } else {
                        global.log("[" + UUID + "] Login marker is empty");
                    }
                } else {
                    global.log("[" + UUID + "] Failed to read login marker file");
                }
            } catch (e) {
                global.log("[" + UUID + "] Error checking login marker: " + e);
            }
        } else {
            global.log("[" + UUID + "] No login marker found");
        }
        
        // Fallback: Check system uptime
        try {
            let uptimeFile = "/proc/uptime";
            if (GLib.file_test(uptimeFile, GLib.FileTest.EXISTS)) {
                let [success, contents] = GLib.file_get_contents(uptimeFile);
                if (success) {
                    let uptimeStr = contents.toString().split(' ')[0]; // First field is uptime in seconds
                    let uptime = parseFloat(uptimeStr);
                    
                    global.log("[" + UUID + "] System uptime: " + uptime + " seconds");
                    
                    if (uptime < 300) { // Less than 5 minutes
                        global.log("[" + UUID + "] System uptime is low (" + uptime + "s) - likely a fresh login, triggering restore");
                        return true;
                    } else {
                        global.log("[" + UUID + "] System uptime is high (" + uptime + "s) - not a fresh login");
                    }
                }
            }
        } catch (e) {
            global.log("[" + UUID + "] Error checking system uptime: " + e);
        }
        
        global.log("[" + UUID + "] No login restore detected");
        return false;
    },
    
    _attemptSessionRestore: function() {
        global.log("[" + UUID + "] _attemptSessionRestore called - autoRestoreOnLogin: " + this.autoRestoreOnLogin);
        
        if (!this.autoRestoreOnLogin) {
            global.log("[" + UUID + "] Auto-restore on login is disabled");
            return;
        }
        
        if (!GLib.file_test(this._sessionFile, GLib.FileTest.EXISTS)) {
            global.log("[" + UUID + "] No session file found for restoration");
            return;
        }
        
        global.log("[" + UUID + "] SESSION RESTORE STARTING");
        
        // Start restoration process with optimized timing for speed
        let restoreAttempts = [
            { delay: 500, name: "Instant restore" },     // 0.5s - immediate attempt
            { delay: 1500, name: "Quick restore" },      // 1.5s - desktop should be ready
            { delay: 3000, name: "Main restore" },       // 3s - main attempt  
            { delay: 6000, name: "Final restore" }       // 6s - final safety net
        ];
        
    global.log("[" + UUID + "] Scheduling " + restoreAttempts.length + " restoration attempts");
        
        for (let i = 0; i < restoreAttempts.length; i++) {
            let attempt = restoreAttempts[i];
            Mainloop.timeout_add(attempt.delay, () => {
                global.log("[" + UUID + "] *** " + attempt.name.toUpperCase() + " ATTEMPT at " + attempt.delay + "ms ***");
                
                // Skip if restoration is already in progress
                if (this._restorationInProgress) {
                    global.log("[" + UUID + "] Skipping " + attempt.name + " - restoration already in progress");
                    return false;
                }
                
                this._restoreSession();
                return false;
            });
        }
        
        // Also create a startup script as backup (disabled to prevent duplicates)
        // this._createStartupScript();

        // Clear the restoring flag shortly after the last scheduled attempt so future auto-saves can proceed
        let lastDelay = restoreAttempts[restoreAttempts.length - 1].delay;
        Mainloop.timeout_add(lastDelay + 3000, () => {
            this._restoring = false;
            global.log("[" + UUID + "] Restore phase complete - auto-saves will resume");
            return false;
        });
    },
    
    _createStartupScript: function() {
        try {
            let scriptContent = `#!/bin/bash
# Cinnamon Session Restore Backup Script
sleep 10
SESSION_FILE="$HOME/.cinnamon-session-save.json"
if [ -f "$SESSION_FILE" ]; then
    echo "Backup session restore triggered"
    # Parse session file and launch applications
    python3 -c "
import json
import subprocess
import time

try:
    with open('$SESSION_FILE', 'r') as f:
        session = json.load(f)
    
    apps_launched = set()
    for window in session.get('windows', []):
        app = window.get('app', '')
        exec_path = window.get('execPath', '')
        
        # Skip if already launched
        if app in apps_launched:
            continue
            
        # Try to launch application
        launch_cmd = None
        if app == 'Code':
            launch_cmd = 'code'
        elif app == 'firefox':
            launch_cmd = 'firefox'
        elif app == 'Brave-browser':
            launch_cmd = 'brave-browser'
        elif app == 'Terminator':
            launch_cmd = 'terminator'
        elif app == 'Nemo' or app == 'org.Nemo':
            launch_cmd = 'nemo'
        elif exec_path:
            launch_cmd = exec_path
        else:
            launch_cmd = app.lower()
        
        if launch_cmd:
            try:
                subprocess.Popen([launch_cmd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                apps_launched.add(app)
                print(f'Launched: {launch_cmd}')
                time.sleep(1)  # Wait between launches
            except:
                print(f'Failed to launch: {launch_cmd}')
                
except Exception as e:
    print(f'Session restore error: {e}')
"
fi`;
            
            let scriptFile = GLib.get_home_dir() + "/.cinnamon-session-restore.sh";
            let file = Gio.File.new_for_path(scriptFile);
            let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            let bytes = new GLib.Bytes(scriptContent);
            stream.write_bytes(bytes, null);
            stream.close(null);
            
            // Make executable
            Util.spawn_command_line_async("chmod +x " + scriptFile);
            
            // Schedule script execution
            Mainloop.timeout_add(30000, () => { // 30 seconds after login
                Util.spawn_command_line_async(scriptFile);
                return false;
            });
            
            global.log("[" + UUID + "] Backup startup script created and scheduled");
        } catch (e) {
            global.log("[" + UUID + "] Could not create startup script: " + e);
        }
    },
    
    disable: function() {
        global.log("[" + UUID + "] ==========================================");
        global.log("[" + UUID + "] DISABLE CALLED - LOGOUT/SHUTDOWN DETECTED");
        global.log("[" + UUID + "] ==========================================");
        
        this._logoutDetected = true;
        
        // CRITICAL: Save session MULTIPLE TIMES on disable for maximum reliability
        if (this.autoSaveOnLogout) {
            global.log("[" + UUID + "] EMERGENCY SESSION SAVE #1");
            this._saveSession();
            
            // Additional saves with slight delays
            Mainloop.timeout_add(50, () => {
                global.log("[" + UUID + "] EMERGENCY SESSION SAVE #2");
                this._saveSession();
                return false;
            });
            
            Mainloop.timeout_add(100, () => {
                global.log("[" + UUID + "] EMERGENCY SESSION SAVE #3");
                this._saveSession();
                return false;
            });
        }
        
        // Call cleanup function
        if (this._cleanupFunction) {
            this._cleanupFunction();
        }
        
        // Clean up timeouts
        if (this._saveTimeout) {
            Mainloop.source_remove(this._saveTimeout);
            this._saveTimeout = null;
        }
        if (this._restoreTimeout) {
            Mainloop.source_remove(this._restoreTimeout);
            this._restoreTimeout = null;
        }
        if (this._autoSaveId) {
            Mainloop.source_remove(this._autoSaveId);
            this._autoSaveId = null;
        }
        
        // Clean up keybindings
        this._cleanupKeybindings();
        
        // Disconnect signals
        if (this._signals) {
            this._signals.disconnectAllSignals();
        }
        
        // Finalize settings
        if (this.settings) {
            this.settings.finalize();
            this.settings = null;
        }
        
        global.log("[" + UUID + "] LOGOUT SESSION SAVE COMPLETED - Extension disabled");
    },
    
    _onSettingsChanged: function() {
        global.log("[" + UUID + "] Settings changed - auto-save: " + this.autoSaveOnLogout + 
                   ", auto-restore: " + this.autoRestoreOnLogin + ", delay: " + this.restoreDelay + "ms" +
                   ", excluded-apps: '" + this.excludedApps + "'" +
                   ", custom-mappings: '" + this.customAppMappings + "'");
        
        // Check if excluded apps list has changed
        if (this._previousExcludedApps !== this.excludedApps) {
            global.log("[" + UUID + "] Excluded apps changed from '" + this._previousExcludedApps + "' to '" + this.excludedApps + "'");
            this._handleExclusionChanges(this._previousExcludedApps, this.excludedApps);
            this._previousExcludedApps = this.excludedApps;
        }
    },
    
    _onKeybindingChanged: function() {
        // Clean up old keybindings and set up new ones
        this._cleanupKeybindings();
        this._setupKeybindings();
    },
    
    _handleExclusionChanges: function(previousExcluded, currentExcluded) {
        try {
            global.log("[" + UUID + "] Handling exclusion changes...");
            
            // Parse the exclusion lists
            let previousApps = previousExcluded.split(',').map(app => app.trim().toLowerCase()).filter(app => app.length > 0);
            let currentApps = currentExcluded.split(',').map(app => app.trim().toLowerCase()).filter(app => app.length > 0);
            
            // Find newly added exclusions
            let newlyExcluded = currentApps.filter(app => !previousApps.includes(app));
            
            if (newlyExcluded.length > 0) {
                global.log("[" + UUID + "] Newly excluded applications: " + newlyExcluded.join(', '));
                
                // Remove newly excluded applications from saved session
                this._removeExcludedAppsFromSession(newlyExcluded);
                
                // Show notification about the changes
                this._showNotification("Exclusion Updated", 
                    "Removed " + newlyExcluded.join(', ') + " from saved session");
            } else {
                global.log("[" + UUID + "] No new exclusions detected");
            }
        } catch (e) {
            global.logError("[" + UUID + "] Error handling exclusion changes: " + e);
        }
    },
    
    _removeExcludedAppsFromSession: function(excludedApps) {
        try {
            // Check if session file exists
            if (!GLib.file_test(this._sessionFile, GLib.FileTest.EXISTS)) {
                global.log("[" + UUID + "] No session file exists to clean up");
                return;
            }
            
            // Read current session data
            let file = Gio.File.new_for_path(this._sessionFile);
            let [success, contents] = file.load_contents(null);
            
            if (!success) {
                global.log("[" + UUID + "] Failed to read session file for cleanup");
                return;
            }
            
            let sessionData = JSON.parse(contents);
            
            if (!sessionData.windows || !Array.isArray(sessionData.windows)) {
                global.log("[" + UUID + "] Invalid session data structure for cleanup");
                return;
            }
            
            let originalWindowCount = sessionData.windows.length;
            global.log("[" + UUID + "] Original session contains " + originalWindowCount + " windows");
            
            // Filter out excluded applications
            sessionData.windows = sessionData.windows.filter(windowData => {
                let app = (windowData.app || '').toLowerCase();
                let title = (windowData.title || '').toLowerCase();
                let wmClass = (windowData.wmClass || '').toLowerCase();
                let wmClassInstance = (windowData.wmClassInstance || '').toLowerCase();
                
                // Check if this window matches any newly excluded app
                let shouldRemove = excludedApps.some(excluded => {
                    let excludedLower = excluded.toLowerCase();
                    
                    // Check multiple identifiers for matches (same logic as in _collectSessionData)
                    return app.includes(excludedLower) || 
                           title.includes(excludedLower) ||
                           wmClass.includes(excludedLower) ||
                           wmClassInstance.includes(excludedLower) ||
                           // Exact matches for better precision
                           app === excludedLower ||
                           wmClass === excludedLower ||
                           wmClassInstance === excludedLower;
                });
                
                if (shouldRemove) {
                    global.log("[" + UUID + "] Removing excluded window: " + windowData.app + " (" + windowData.title + ")");
                }
                
                return !shouldRemove; // Keep windows that are NOT excluded
            });
            
            let removedCount = originalWindowCount - sessionData.windows.length;
            global.log("[" + UUID + "] Removed " + removedCount + " windows from session");
            
            // Update workspace window counts
            sessionData.workspaces = {};
            for (let windowData of sessionData.windows) {
                let workspaceIndex = windowData.workspace;
                if (!sessionData.workspaces[workspaceIndex]) {
                    sessionData.workspaces[workspaceIndex] = {
                        name: "Workspace " + (workspaceIndex + 1),
                        windowCount: 0
                    };
                }
                sessionData.workspaces[workspaceIndex].windowCount++;
            }
            
            // Save the updated session data
            let jsonData = JSON.stringify(sessionData, null, 2);
            let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            let bytes = new GLib.Bytes(jsonData);
            stream.write_bytes(bytes, null);
            stream.close(null);
            
            global.log("[" + UUID + "] Updated session file: " + sessionData.windows.length + " windows remaining");
            
            if (removedCount > 0) {
                global.log("[" + UUID + "] Successfully removed " + removedCount + " excluded applications from saved session");
            }
            
        } catch (e) {
            global.logError("[" + UUID + "] Error removing excluded apps from session: " + e);
        }
    },
    
    _connectSessionSignals: function() {
        // Connect to session management signals
        try {
            // Method 1: Connect to session manager for logout/shutdown detection
            try {
                let sessionManager = Main.sessionManager;
                if (sessionManager) {
                    this._signals.connect(sessionManager, 'prepare-for-shutdown', this._onShutdown, this);
                    this._signals.connect(sessionManager, 'prepare-for-sleep', this._onShutdown, this);
                    global.log("[" + UUID + "] Connected to session manager signals");
                }
            } catch (e) {
                global.log("[" + UUID + "] Session manager not available: " + e);
            }
            
            // Method 2: Monitor for critical system signals
            this._signals.connect(global, 'shutdown', this._onShutdown, this);
            
            // Method 3: Connect to window manager signals for better logout detection
            try {
                if (global.window_manager) {
                    this._signals.connect(global.window_manager, 'destroy', this._onWindowDestroy, this);
                }
            } catch (e) {
                global.log("[" + UUID + "] Window manager signals not available: " + e);
            }
            
            // Method 4: Monitor window events for session changes
            this._signals.connect(global.display, 'window-created', this._onWindowCreated, this);
            this._signals.connect(global.workspace_manager, 'workspace-switched', this._onWorkspaceChanged, this);
            
            // Method 5: Set up periodic auto-save as safety net
            this._autoSaveId = Mainloop.timeout_add_seconds(30, () => { // Every 30 seconds
                if (this.autoSaveOnLogout) {
                    this._saveSession();
                }
                return true; // Keep repeating
            });
            
            // Method 6: Hook into system shutdown via systemd user session
            this._setupSystemdLogoutHook();
            
            // Method 7: Hook into Cinnamon's exit process using environment monitoring
            this._setupExitHooks();
            
            global.log("[" + UUID + "] Connected to session signals");
        } catch (e) {
            global.log("[" + UUID + "] Failed to connect session signals: " + e);
        }
    },
    
    _onShutdown: function() {
        // Save session on shutdown
        if (this.autoSaveOnLogout) {
            global.log("[" + UUID + "] Shutdown detected, saving session");
            this._saveSession();
        }
    },
    
    _onWindowCreated: function(display, window) {
        // Track window creation for session management
        // This could be used to monitor application startup during restore
    },
    
    _onWindowDestroy: function(wm, actor) {
        // Monitor for window destruction that might indicate logout
        let allWindows = global.get_window_actors();
        if (allWindows.length <= 3) { // Very few windows left, might be logout
            global.log("[" + UUID + "] Few windows remaining, saving session as precaution");
            if (this.autoSaveOnLogout) {
                this._saveSession();
            }
        }
    },
    
    _onWorkspaceChanged: function() {
        // Save session when workspace changes to capture current state
        if (this.autoSaveOnLogout) {
            this._scheduleSave();
        }
    },
    
    _setupSystemdLogoutHook: function() {
        // Create a systemd user service to detect logout
        try {
            let serviceContent = `[Unit]
Description=Save Cinnamon Session on Logout
DefaultDependencies=false
Before=shutdown.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'dbus-send --session --type=method_call --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.GetConnectionUnixProcessID string:org.Cinnamon 2>/dev/null && echo "Session save trigger" > ${GLib.get_home_dir()}/.cinnamon-logout-trigger'
RemainAfterExit=yes

[Install]
WantedBy=shutdown.target`;
            
            let serviceDir = GLib.get_home_dir() + "/.config/systemd/user";
            let serviceFile = serviceDir + "/cinnamon-session-save.service";
            
            // Create systemd user directory if it doesn't exist
            let dir = Gio.File.new_for_path(serviceDir);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
            }
            
            // Write service file
            let file = Gio.File.new_for_path(serviceFile);
            let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            let bytes = new GLib.Bytes(serviceContent);
            stream.write_bytes(bytes, null);
            stream.close(null);
            
            // Enable the service
            Util.spawn_command_line_async("systemctl --user enable cinnamon-session-save.service");
            
            global.log("[" + UUID + "] Systemd logout hook installed");
        } catch (e) {
            global.log("[" + UUID + "] Could not set up systemd logout hook: " + e);
        }
    },
    
    _cleanupOldSessionFiles: function() {
        try {
            global.log("[" + UUID + "] Starting cleanup of old session tracking files...");
            
            let homeDir = GLib.get_home_dir();
            
            // Use shell command to find and clean up old session files (keep only 4 newest to make room for new one)
            let cleanupScript = 'cd "' + homeDir + '" && ' +
                               'FILES=($(ls -t .cinnamon-session-running-* 2>/dev/null)) && ' +
                               'TOTAL=${#FILES[@]} && ' +
                               'if [ $TOTAL -gt 4 ]; then ' +
                               '  echo "Cleaning up $((TOTAL-4)) old session files" && ' +
                               '  for ((i=4; i<TOTAL; i++)); do ' +
                               '    echo "Removing: ${FILES[i]}" && ' +
                               '    rm -f "${FILES[i]}" ' +
                               '  done ' +
                               'fi && ' +
                               'echo "Session files remaining: $(ls .cinnamon-session-running-* 2>/dev/null | wc -l)"';
            
            let [success, output, error] = GLib.spawn_command_line_sync('bash -c \'' + cleanupScript + '\'');
            
            if (success) {
                let result = output.toString().trim();
                if (result) {
                    global.log("[" + UUID + "] Session file cleanup result: " + result);
                }
            } else {
                global.log("[" + UUID + "] Session file cleanup failed: " + (error ? error.toString() : "unknown error"));
            }
            
        } catch (e) {
            global.log("[" + UUID + "] Error during session file cleanup: " + e);
        }
    },
    
    _setupExitHooks: function() {
        global.log("[" + UUID + "] _setupExitHooks called - setting up exit detection");
        
        // Set up additional exit detection methods
        try {
            // Clean up old session tracking files before creating a new one
            this._cleanupOldSessionFiles();
            
            // Create a PID file that will be cleaned up on clean shutdown
            this._pidFile = GLib.get_home_dir() + "/.cinnamon-session-running-" + GLib.get_real_time();
            let pidFile = Gio.File.new_for_path(this._pidFile);
            let stream = pidFile.create(Gio.FileCreateFlags.NONE, null);
            stream.close(null);
            
            global.log("[" + UUID + "] Created session tracking file: " + this._pidFile);
            
            // Set up a periodic check to save session data
            this._periodicSaveId = Mainloop.timeout_add_seconds(30, () => { // Every 30 seconds
                if (this.autoSaveOnLogout) {
                    this._saveSession();
                }
                return true;
            });
            
            // Create an autostart entry to help with restoration
            this._createAutostartEntry();
            
            // Create manual cleanup script for advanced users
            this._createManualCleanupScript();
            
            global.log("[" + UUID + "] Exit hooks and periodic save set up");
        } catch (e) {
            global.log("[" + UUID + "] Could not set up exit hooks: " + e);
        }
        
        // Create a cleanup function that will be called on disable
        let self = this;
        this._cleanupFunction = function() {
            // Clean up the PID file
            if (self._pidFile) {
                try {
                    let pidFile = Gio.File.new_for_path(self._pidFile);
                    if (pidFile.query_exists(null)) {
                        pidFile.delete(null);
                    }
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
            
            // Clean up periodic save
            if (self._periodicSaveId) {
                Mainloop.source_remove(self._periodicSaveId);
                self._periodicSaveId = null;
            }
        };
    },
    
    _createAutostartEntry: function() {
        // Create an autostart entry that creates login marker for session restoration
        try {
            let autostartContent = `[Desktop Entry]
Type=Application
Name=Cinnamon Session Restore
Comment=Create login marker for session restore
Exec=/bin/bash -c 'echo $EPOCHSECONDS > "$HOME/.cinnamon-session-login-marker" 2>/dev/null || echo $(date +%s) > "$HOME/.cinnamon-session-login-marker"; echo "Autostart executed at $(date)" >> "$HOME/.cinnamon-session-autostart.log"'
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=0
StartupNotify=false
Terminal=false`;
            
            let autostartDir = GLib.get_home_dir() + "/.config/autostart";
            let autostartFile = autostartDir + "/cinnamon-session-restore.desktop";
            
            // Create autostart directory if it doesn't exist
            let dir = Gio.File.new_for_path(autostartDir);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
            }
            
            // Write autostart file
            let file = Gio.File.new_for_path(autostartFile);
            let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            let bytes = new GLib.Bytes(autostartContent);
            stream.write_bytes(bytes, null);
            stream.close(null);
            
            global.log("[" + UUID + "] Login marker autostart entry created for session restoration");
        } catch (e) {
            global.log("[" + UUID + "] Could not create autostart entry: " + e);
        }
    },
    
    _createManualCleanupScript: function() {
        // Create a manual cleanup script for session tracking files
        try {
            let scriptContent = `#!/bin/bash
# Cinnamon Session Files Cleanup Script
# Automatically created by Save Cinnamon Session extension
# Keeps only the 5 most recent session tracking files

# Change to home directory
cd "$HOME" || exit 1

# Find all session tracking files and store them in an array, sorted by modification time (newest first)
mapfile -t FILES < <(ls -t .cinnamon-session-running-* 2>/dev/null)

# Get total count
TOTAL=\${#FILES[@]}

echo "Found $TOTAL session tracking files"

# If we have more than 5 files, remove the oldest ones
if [ $TOTAL -gt 5 ]; then
    REMOVE_COUNT=$((TOTAL - 5))
    echo "Cleaning up $REMOVE_COUNT old session files (keeping 5 newest)"
    
    # Remove files beyond the first 5 (oldest files)
    for ((i=5; i<TOTAL; i++)); do
        if [ -f "\${FILES[i]}" ]; then
            echo "Removing: \${FILES[i]}"
            rm -f "\${FILES[i]}"
        fi
    done
    
    echo "Cleanup completed successfully"
else
    echo "No cleanup needed - only $TOTAL session files exist (keeping up to 5)"
fi

# Show current status
REMAINING=$(ls .cinnamon-session-running-* 2>/dev/null | wc -l)
echo "Session tracking files remaining: $REMAINING"
`;
            
            // Create the script directory if it doesn't exist
            let scriptDir = GLib.get_home_dir() + "/.local/bin";
            let dir = Gio.File.new_for_path(scriptDir);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
                global.log("[" + UUID + "] Created ~/.local/bin directory");
            }
            
            // Write the cleanup script
            let scriptFile = scriptDir + "/cleanup-session-files.sh";
            let file = Gio.File.new_for_path(scriptFile);
            let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            let bytes = new GLib.Bytes(scriptContent);
            stream.write_bytes(bytes, null);
            stream.close(null);
            
            // Make the script executable
            Util.spawn_command_line_async("chmod +x " + scriptFile);
            
            global.log("[" + UUID + "] Manual cleanup script created at: " + scriptFile);
            global.log("[" + UUID + "] Users can run: ~/.local/bin/cleanup-session-files.sh");
            global.log("[" + UUID + "] Or add to crontab for automatic execution");
            
        } catch (e) {
            global.log("[" + UUID + "] Could not create manual cleanup script: " + e);
        }
    },
    
    _setupKeybindings: function() {
        if (this.manualSaveKeybinding && this.manualSaveKeybinding !== "") {
            Main.keybindingManager.addHotKey(UUID + "-save", this.manualSaveKeybinding, () => {
                this._saveSession();
            });
            global.log("[" + UUID + "] Save keybinding set up: " + this.manualSaveKeybinding);
        }
        
        if (this.manualRestoreKeybinding && this.manualRestoreKeybinding !== "") {
            Main.keybindingManager.addHotKey(UUID + "-restore", this.manualRestoreKeybinding, () => {
                this._manualRestore();
            });
            global.log("[" + UUID + "] Restore keybinding set up: " + this.manualRestoreKeybinding);
        }
    },
    
    _cleanupKeybindings: function() {
        Main.keybindingManager.removeHotKey(UUID + "-save");
        Main.keybindingManager.removeHotKey(UUID + "-restore");
        global.log("[" + UUID + "] Keybindings cleaned up");
    },
    
    _scheduleSave: function() {
        // Debounce save operations
        if (this._saveTimeout) {
            Mainloop.source_remove(this._saveTimeout);
        }
        
        this._saveTimeout = Mainloop.timeout_add(1000, () => { // 1 second delay
            this._saveSession();
            this._saveTimeout = null;
            return false;
        });
    },
    
    _scheduleRestore: function() {
        // Schedule restore with delay to let desktop settle
        this._restoreTimeout = Mainloop.timeout_add(this.restoreDelay, () => {
            this._restoreSession();
            this._restoreTimeout = null;
            return false;
        });
        global.log("[" + UUID + "] Scheduled session restore in " + this.restoreDelay + "ms");
    },
    
    _saveSession: function() {
        try {
            // If we are in the startup restoring phase, avoid overwriting an existing valid session
            // This prevents startup auto-saves (when few/no windows exist yet) from wiping the
            // session that we are trying to restore.
            if (this._restoring && GLib.file_test(this._sessionFile, GLib.FileTest.EXISTS) && !this._logoutDetected) {
                global.log("[" + UUID + "] Skipping save during restore phase to avoid overwriting saved session");
                return;
            }
            let sessionData = this._collectSessionData();
            let jsonData = JSON.stringify(sessionData, null, 2);
            // If our collected session is empty but an existing saved session contains windows,
            // avoid overwriting it with an empty file. This protects the saved logout state from
            // being clobbered by an early startup auto-save.
            if (sessionData.windows.length === 0 && GLib.file_test(this._sessionFile, GLib.FileTest.EXISTS)) {
                try {
                    let existingFile = Gio.File.new_for_path(this._sessionFile);
                    let [ok, existingContents] = existingFile.load_contents(null);
                    if (ok) {
                        try {
                            let existingData = JSON.parse(existingContents);
                            if (existingData.windows && Array.isArray(existingData.windows) && existingData.windows.length > 0) {
                                global.log("[" + UUID + "] Detected existing saved session with windows; skipping overwrite with empty session");
                                return;
                            }
                        } catch (e) {
                            // If parsing fails, fall through and overwrite (safer to refresh)
                        }
                    }
                } catch (e) {
                    // ignore errors reading existing file
                }
            }
            
            // Write session data to file
            let file = Gio.File.new_for_path(this._sessionFile);
            let stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            let bytes = new GLib.Bytes(jsonData);
            stream.write_bytes(bytes, null);
            stream.close(null);
            
            global.log("[" + UUID + "] Session saved successfully to " + this._sessionFile);
            global.log("[" + UUID + "] Saved " + sessionData.windows.length + " windows across " + 
                       Object.keys(sessionData.workspaces).length + " workspaces");
            
            // Show notification
            this._showNotification("Session Saved", 
                "Saved " + sessionData.windows.length + " windows across " + 
                Object.keys(sessionData.workspaces).length + " workspaces");
        } catch (e) {
            global.logError("[" + UUID + "] Failed to save session: " + e);
            this._showNotification("Session Save Failed", "Error: " + e.message);
        }
    },
    
    _collectSessionData: function() {
        let sessionData = {
            timestamp: Date.now(),
            workspaces: {},
            windows: [],
            currentWorkspace: global.workspace_manager.get_active_workspace_index()
        };
        
        let windows = global.get_window_actors();
        let excludedAppsArray = this.excludedApps.split(',').map(app => app.trim().toLowerCase());
        let seenWindows = new Set(); // Track windows to avoid duplicates
        
        global.log("[" + UUID + "] === WINDOW COLLECTION DEBUG ===");
        global.log("[" + UUID + "] Total window actors available: " + windows.length);
        global.log("[" + UUID + "] Current excluded apps setting: '" + this.excludedApps + "'");
        global.log("[" + UUID + "] Excluded apps list: " + excludedAppsArray.join(', '));
        global.log("[" + UUID + "] Collecting session data from " + windows.length + " window actors");
        
        for (let windowActor of windows) {
            let window = windowActor.get_meta_window();
            if (!window || window.is_skip_taskbar()) {
                if (!window) {
                    global.log("[" + UUID + "] Skipping null window");
                } else if (window.is_skip_taskbar()) {
                    global.log("[" + UUID + "] Skipping taskbar-skipped window: " + (window.get_title() || "no title"));
                }
                continue;
            }
            
            // Get application information - try multiple methods with detailed logging
            let gtkAppId = window.get_gtk_application_id();
            let wmClass = window.get_wm_class();
            let wmClassInstance = window.get_wm_class_instance();
            let title = window.get_title();
            
            global.log("[" + UUID + "] Examining window - gtk_app_id: '" + (gtkAppId || "none") + 
                      "', wm_class: '" + (wmClass || "none") + 
                      "', wm_class_instance: '" + (wmClassInstance || "none") + 
                      "', title: '" + (title || "none") + "'");
            
            let app = gtkAppId || wmClass || wmClassInstance || title;
            
            if (!app) {
                global.log("[" + UUID + "] Skipping window with no identifiable app");
                continue;
            }
            
            global.log("[" + UUID + "] Checking exclusions for app: '" + app + "'");
            
            // Skip excluded applications - comprehensive matching
            let shouldExclude = excludedAppsArray.some(excluded => {
                if (excluded.trim() === '') return false; // Skip empty entries
                
                let excludedLower = excluded.toLowerCase();
                let appLower = app.toLowerCase();
                let titleLower = title.toLowerCase();
                let wmClassLower = (wmClass || '').toLowerCase();
                let wmClassInstanceLower = (wmClassInstance || '').toLowerCase();
                
                // Check multiple identifiers for matches
                let matches = appLower.includes(excludedLower) || 
                            titleLower.includes(excludedLower) ||
                            wmClassLower.includes(excludedLower) ||
                            wmClassInstanceLower.includes(excludedLower) ||
                            // Exact matches for better precision
                            appLower === excludedLower ||
                            wmClassLower === excludedLower ||
                            wmClassInstanceLower === excludedLower;
                
                if (matches) {
                    global.log("[" + UUID + "] Match found: '" + excluded + "' matches app data");
                }
                
                return matches;
            });
            
            if (shouldExclude) {
                global.log("[" + UUID + "] ✓ EXCLUDING application: " + app + " (wmClass: " + wmClass + ", title: " + title + ")");
                continue;
            } else {
                global.log("[" + UUID + "] ✓ INCLUDING application: " + app);
            }
            
            let frame = window.get_frame_rect();
            let workspace = window.get_workspace();
            
            // Skip windows without valid workspace (e.g., being destroyed)
            if (!workspace) {
                global.log("[" + UUID + "] Skipping window with null workspace: " + app);
                continue;
            }
            
            let workspaceIndex = workspace.index();
            
            // Get additional window information
            let pid = window.get_pid();
            let windowType = window.get_window_type();
            
            // Get executable path for better restoration
            let execPath = "";
            try {
                let [success, out] = GLib.spawn_command_line_sync('ps -p ' + pid + ' -o comm=');
                if (success && out.length > 0) {
                    execPath = out.toString().trim();
                }
            } catch (e) {
                // Ignore errors getting executable path
            }
            
            let windowData = {
                app: app,
                title: window.get_title() || "",
                x: frame.x,
                y: frame.y,
                width: frame.width,
                height: frame.height,
                workspace: workspaceIndex,
                maximized: window.get_maximized(),
                minimized: window.minimized,
                monitor: window.get_monitor(),
                pid: pid,
                windowType: windowType,
                wmClass: window.get_wm_class(),
                wmClassInstance: window.get_wm_class_instance(),
                execPath: execPath
            };
            
            // For VS Code, try to extract and store workspace information
            if (app === "Code") {
                let extractedWorkspace = this._extractWorkspaceFromTitle(windowData.title);
                if (extractedWorkspace) {
                    windowData.vscodeWorkspace = extractedWorkspace;
                    global.log("[" + UUID + "] Captured VS Code workspace: " + extractedWorkspace);
                }
                
                // Try to capture the full workspace path from VS Code's current working directory
                try {
                    let fullWorkspacePath = this._getVSCodeWorkspacePath(pid);
                    if (fullWorkspacePath) {
                        windowData.vscodeWorkspacePath = fullWorkspacePath;
                        global.log("[" + UUID + "] Captured VS Code full path: " + fullWorkspacePath);
                    }
                } catch (e) {
                    global.log("[" + UUID + "] Could not get VS Code workspace path: " + e);
                }
            }
            
            // Create a unique key for duplicate detection - use PID and window handle for better uniqueness
            let windowHandle = window.get_stable_sequence ? window.get_stable_sequence() : window.get_id();
            let windowKey = app + "|" + windowData.title + "|" + pid + "|" + windowHandle;
            
            if (seenWindows.has(windowKey)) {
                global.log("[" + UUID + "] Skipping duplicate window: " + app + " (" + windowData.title + ") - Key: " + windowKey);
                continue;
            }
            seenWindows.add(windowKey);
            
            global.log("[" + UUID + "] Adding unique window: " + app + " - Key: " + windowKey);
            
            sessionData.windows.push(windowData);
            
            // Track workspace usage
            if (!sessionData.workspaces[workspaceIndex]) {
                sessionData.workspaces[workspaceIndex] = {
                    name: "Workspace " + (workspaceIndex + 1),
                    windowCount: 0
                };
            }
            sessionData.workspaces[workspaceIndex].windowCount++;
            
            global.log("[" + UUID + "] Captured window: app='" + app + "', title='" + windowData.title + 
                      "', wmClass='" + (windowData.wmClass || "none") + 
                      "', execPath='" + (windowData.execPath || "none") + 
                      "' on workspace " + workspaceIndex);
        }
        
        global.log("[" + UUID + "] === WINDOW COLLECTION SUMMARY ===");
        global.log("[" + UUID + "] Started with " + windows.length + " window actors");
        global.log("[" + UUID + "] Successfully collected " + sessionData.windows.length + " windows");
        global.log("[" + UUID + "] Filtered out " + (windows.length - sessionData.windows.length) + " windows");
        global.log("[" + UUID + "] Session data collected: " + sessionData.windows.length + " windows, " + Object.keys(sessionData.workspaces).length + " workspaces");
        return sessionData;
    },
    
    _restoreSession: function() {
        try {
            // Set restoration lock to prevent concurrent attempts
            if (this._restorationInProgress) {
                global.log("[" + UUID + "] Restoration already in progress, skipping");
                return;
            }
            
            // Check if we've already successfully restored in this session
            if (this._restorationCompleted) {
                global.log("[" + UUID + "] Restoration already completed in this session, skipping");
                return;
            }
            
            this._restorationInProgress = true;
            
            if (!GLib.file_test(this._sessionFile, GLib.FileTest.EXISTS)) {
                global.log("[" + UUID + "] No session file found to restore");
                this._restorationInProgress = false;
                return;
            }
            
            let file = Gio.File.new_for_path(this._sessionFile);
            let [success, contents] = file.load_contents(null);
            
            if (!success) {
                global.logError("[" + UUID + "] Failed to read session file");
                this._restorationInProgress = false;
                return;
            }
            
            global.log("[" + UUID + "] DEBUG: Session file read successfully, size: " + contents.length + " bytes");
            global.log("[" + UUID + "] DEBUG: First 200 chars: " + contents.toString().substring(0, 200));
            
            let sessionData = JSON.parse(contents);
            
            global.log("[" + UUID + "] DEBUG: Session data loaded");
            global.log("[" + UUID + "] DEBUG: sessionData.windows exists: " + (sessionData.windows ? "yes" : "no"));
            global.log("[" + UUID + "] DEBUG: sessionData.windows is array: " + Array.isArray(sessionData.windows));
            global.log("[" + UUID + "] DEBUG: sessionData.windows.length: " + (sessionData.windows ? sessionData.windows.length : "undefined"));
            
            // Validate session data
            if (!sessionData.windows || !Array.isArray(sessionData.windows) || sessionData.windows.length === 0) {
                global.log("[" + UUID + "] Session file contains no valid windows to restore");
                global.log("[" + UUID + "] DEBUG: Validation failed - windows: " + (sessionData.windows ? "exists" : "missing") + 
                          ", isArray: " + Array.isArray(sessionData.windows) + 
                          ", length: " + (sessionData.windows ? sessionData.windows.length : "undefined"));
                this._restorationInProgress = false;
                return;
            }
            
            // Check if session is too old (more than 24 hours)
            let sessionAge = Date.now() - sessionData.timestamp;
            let maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
            
            if (sessionAge > maxAge) {
                global.log("[" + UUID + "] Session is too old (" + Math.round(sessionAge / (60 * 60 * 1000)) + " hours), skipping restore");
                return;
            }
            
            global.log("[" + UUID + "] Restoring session from " + new Date(sessionData.timestamp));
            global.log("[" + UUID + "] Session age: " + Math.round(sessionAge / (60 * 1000)) + " minutes");
            global.log("[" + UUID + "] Restoring " + sessionData.windows.length + " windows");
            
            // Show notification
            this._showNotification("Restoring Session", 
                "Restoring " + sessionData.windows.length + " windows from " + 
                Math.round(sessionAge / (60 * 1000)) + " minutes ago...");
            
            // Restore applications and windows
            this._restoreApplications(sessionData);
            
        } catch (e) {
            global.logError("[" + UUID + "] Failed to restore session: " + e);
            this._showNotification("Session Restore Failed", "Error: " + e.message);
            this._restorationInProgress = false; // Release lock on error
        }
    },
    
    _restoreApplications: function(sessionData) {
        let restoredWindows = new Set(); // Track individual windows restored
        this._launchedBrowsers = new Set(); // Track which browsers we've already launched (reset for each restoration)
        this._sequentialRestoredCount = 0; // Reset counter for sequential restoration
        this._sequentialRestoredWindows = new Set(); // Reset set for sequential restoration
        
        // Group windows by application for logging
        let appWindows = {};
        for (let windowData of sessionData.windows) {
            if (!appWindows[windowData.app]) {
                appWindows[windowData.app] = [];
            }
            appWindows[windowData.app].push(windowData);
        }
        
        global.log("[" + UUID + "] Attempting to restore " + sessionData.windows.length + " windows from " + Object.keys(appWindows).length + " applications");
        
        // Log application breakdown
        for (let app in appWindows) {
            global.log("[" + UUID + "] " + app + ": " + appWindows[app].length + " windows");
        }
        
        // Restore each window individually with delays
        let windowsToRestore = sessionData.windows.slice(); // Copy array
        let restoredCount = 0;
        
        // Launch windows with staggered timing to prevent browser conflicts
        this._launchWindowsSequentially(windowsToRestore, appWindows, 0, (finalRestoredCount) => {
            // After all windows are launched, clean up any excess browser windows
            Mainloop.timeout_add(3000, () => {
                this._cleanupExcessBrowserWindows(sessionData);
                return false;
            });
            
            // Schedule window positioning with longer delay based on number of windows
            let positioningDelay = Math.max(12000, finalRestoredCount * 2000); // Extra time for cleanup
            Mainloop.timeout_add(positioningDelay, () => { 
                this._positionWindows(sessionData);
                // Release restoration lock after positioning is complete
                this._restorationInProgress = false;
                this._restorationCompleted = true; // Mark restoration as completed
                global.log("[" + UUID + "] Restoration complete - lock released, marked as completed");
                return false;
            });
            
            global.log("[" + UUID + "] Launched " + finalRestoredCount + " windows, cleanup in 3s, positioning in " + positioningDelay + "ms");
        });
    },
    
    _launchWindowsSequentially: function(windowsToRestore, appWindows, index, callback) {
        if (index >= windowsToRestore.length) {
            // All windows processed, call the callback
            callback(this._sequentialRestoredCount || 0);
            return;
        }
        
        let windowData = windowsToRestore[index];
        let windowId = windowData.app + "_" + windowData.title + "_" + windowData.x + "_" + windowData.y;
        
        if (!this._sequentialRestoredCount) this._sequentialRestoredCount = 0;
        if (!this._sequentialRestoredWindows) this._sequentialRestoredWindows = new Set();
        
        if (this._sequentialRestoredWindows.has(windowId)) {
            global.log("[" + UUID + "] Skipping duplicate window: " + windowId);
            // Continue to next window immediately
            this._launchWindowsSequentially(windowsToRestore, appWindows, index + 1, callback);
            return;
        }
        
        // Check if we already restored this app in this session (but allow multiple windows)
        let currentWindowCount = this._countApplicationWindows(windowData.app);
        let expectedWindowCount = appWindows[windowData.app].length;
        
        global.log("[" + UUID + "] Restoring window " + (index + 1) + "/" + windowsToRestore.length + ": " + 
                  windowData.app + " (" + windowData.title + ") - Current: " + currentWindowCount + ", Expected: " + expectedWindowCount);
        
        try {
            global.log("[" + UUID + "] About to call _launchApplicationWindow for: " + windowData.app);
            let launched = this._launchApplicationWindow(windowData);
            global.log("[" + UUID + "] _launchApplicationWindow returned: " + launched + " for: " + windowData.app);
            
            if (launched) {
                this._sequentialRestoredWindows.add(windowId);
                this._sequentialRestoredCount++;
                this._restoredAppsThisSession.add(windowData.app);
                global.log("[" + UUID + "] Successfully launched window: " + windowData.app + " (" + windowData.title + ")");
            } else {
                global.log("[" + UUID + "] Failed to launch window: " + windowData.app + " (" + windowData.title + ")");
            }
        } catch (e) {
            global.log("[" + UUID + "] Exception launching window: " + windowData.app + " - " + e);
            global.log("[" + UUID + "] Exception stack: " + e.stack);
        }
        
        // Add delay before launching next window (optimized for speed)
        let delay = 200; // Fast 200ms delay
        if (windowData.app.includes("browser") || windowData.app.includes("firefox") || windowData.app.includes("Brave")) {
            delay = 800; // Shorter browser delay for faster restoration
        }
        
        // Continue to next window after delay
        Mainloop.timeout_add(delay, () => {
            this._launchWindowsSequentially(windowsToRestore, appWindows, index + 1, callback);
            return false;
        });
    },

    // Manual restore function for testing
    _manualRestore: function() {
        global.log("[" + UUID + "] Manual restore triggered");
        
        // Temporarily allow manual restoration by clearing completion flag
        let wasCompleted = this._restorationCompleted;
        this._restorationCompleted = false;
        
        this._restoreSession();
        
        // Restore the completion flag to previous state
        this._restorationCompleted = wasCompleted;
    },
    
    _isApplicationRunning: function(appName) {
        let windows = global.get_window_actors();
        for (let windowActor of windows) {
            let window = windowActor.get_meta_window();
            if (!window || window.is_skip_taskbar()) continue;
            
            let gtkAppId = window.get_gtk_application_id();
            let wmClass = window.get_wm_class();
            let wmClassInstance = window.get_wm_class_instance();
            
            // Check for exact matches
            if (gtkAppId === appName || wmClass === appName || wmClassInstance === appName) {
                return true;
            }
            
            // Special handling for browsers
            if (appName === "Brave-browser") {
                if (wmClass === "Brave-browser" || wmClassInstance === "brave-browser" || 
                    gtkAppId === "com.brave.Browser") {
                    return true;
                }
            }
            
            if (appName === "firefox") {
                if (wmClass === "firefox" || wmClassInstance === "Navigator" || 
                    gtkAppId === "firefox" || wmClass === "Firefox") {
                    return true;
                }
            }
        }
        return false;
    },
    
    _countApplicationWindows: function(appName) {
        let count = 0;
        let windows = global.get_window_actors();
        for (let windowActor of windows) {
            let window = windowActor.get_meta_window();
            if (!window || window.is_skip_taskbar()) continue;
            
            let gtkAppId = window.get_gtk_application_id();
            let wmClass = window.get_wm_class();
            let wmClassInstance = window.get_wm_class_instance();
            
            // Check for exact matches
            if (gtkAppId === appName || wmClass === appName || wmClassInstance === appName) {
                count++;
                continue;
            }
            
            // Special handling for browsers
            if (appName === "Brave-browser") {
                if (wmClass === "Brave-browser" || wmClassInstance === "brave-browser" || 
                    gtkAppId === "com.brave.Browser") {
                    count++;
                }
            } else if (appName === "firefox") {
                if (wmClass === "firefox" || wmClassInstance === "Navigator" || 
                    gtkAppId === "firefox" || wmClass === "Firefox") {
                    count++;
                }
            }
        }
        return count;
    },
    
    _parseCustomAppMappings: function() {
        let customMappings = {};
        
        if (!this.customAppMappings || this.customAppMappings.trim() === "") {
            return customMappings;
        }
        
        try {
            // Parse format: "AppName:command,AnotherApp:another-command"
            let mappingPairs = this.customAppMappings.split(',');
            
            for (let pair of mappingPairs) {
                let trimmedPair = pair.trim();
                if (trimmedPair === "") continue;
                
                let colonIndex = trimmedPair.indexOf(':');
                if (colonIndex === -1) {
                    global.log("[" + UUID + "] Invalid custom mapping format (missing colon): " + trimmedPair);
                    continue;
                }
                
                let appName = trimmedPair.substring(0, colonIndex).trim();
                let command = trimmedPair.substring(colonIndex + 1).trim();
                
                if (appName && command) {
                    customMappings[appName] = [command];
                    global.log("[" + UUID + "] Added custom mapping: " + appName + " -> " + command);
                } else {
                    global.log("[" + UUID + "] Invalid custom mapping (empty app or command): " + trimmedPair);
                }
            }
        } catch (e) {
            global.log("[" + UUID + "] Error parsing custom app mappings: " + e);
        }
        
        return customMappings;
    },
    
    _launchApplication: function(app, windowData) {
        let launched = false;
        
        global.log("[" + UUID + "] Attempting to launch application: " + app);
        
        // Application mapping for reliable launching
        let appCommands = {
            'Code': ['code', 'code-oss', '/usr/bin/code'],
            'firefox': ['firefox', 'firefox-esr', '/usr/bin/firefox'],
            'Brave-browser': ['brave-browser', 'brave', '/usr/bin/brave-browser'],
            'Terminator': ['terminator', '/usr/bin/terminator'],
            'Nemo': ['nemo', '/usr/bin/nemo'],
            'org.Nemo': ['nemo', '/usr/bin/nemo'],
            'org.x.editor': ['xed', '/usr/bin/xed'],
            'Xed': ['xed', '/usr/bin/xed'],
            'io.missioncenter.MissionCenter': ['flatpak run io.missioncenter.MissionCenter', 'missioncenter'],
            'missioncenter': ['flatpak run io.missioncenter.MissionCenter', 'missioncenter'],
            'Xlet-settings.py': ['cinnamon-settings extensions'],
            'gnome-terminal-server': ['gnome-terminal', '/usr/bin/gnome-terminal'],
            'thunderbird': ['thunderbird', '/usr/bin/thunderbird'],
            'org.libreoffice': ['libreoffice', '/usr/bin/libreoffice'],
            'libreoffice-writer': ['libreoffice --writer', '/usr/bin/libreoffice --writer'],
            'libreoffice-calc': ['libreoffice --calc', '/usr/bin/libreoffice --calc'],
            'libreoffice-impress': ['libreoffice --impress', '/usr/bin/libreoffice --impress'],
            'libreoffice-draw': ['libreoffice --draw', '/usr/bin/libreoffice --draw'],
            'libreoffice': ['libreoffice', '/usr/bin/libreoffice'],
            'gedit': ['gedit', '/usr/bin/gedit'],
            'nautilus': ['nautilus', '/usr/bin/nautilus']
        };
        
        // Merge custom app mappings with built-in mappings (custom mappings take priority)
        let customMappings = this._parseCustomAppMappings();
        Object.assign(appCommands, customMappings);
        
        if (Object.keys(customMappings).length > 0) {
            global.log("[" + UUID + "] Using " + Object.keys(customMappings).length + " custom app mappings");
        }
        
        let commands;
        
        // Special handling for LibreOffice applications based on WM class
        if (app === 'org.libreoffice' && windowData && windowData.wmClass) {
            let wmClass = windowData.wmClass.toLowerCase();
            if (wmClass === 'libreoffice-writer') {
                commands = ['libreoffice --writer', '/usr/bin/libreoffice --writer'];
            } else if (wmClass === 'libreoffice-calc') {
                commands = ['libreoffice --calc', '/usr/bin/libreoffice --calc'];
            } else if (wmClass === 'libreoffice-impress') {
                commands = ['libreoffice --impress', '/usr/bin/libreoffice --impress'];
            } else if (wmClass === 'libreoffice-draw') {
                commands = ['libreoffice --draw', '/usr/bin/libreoffice --draw'];
            } else {
                // Fall back to generic libreoffice
                commands = ['libreoffice', '/usr/bin/libreoffice'];
            }
            global.log("[" + UUID + "] LibreOffice detected - using specific command for " + wmClass);
        } else {
            // Get possible commands for this app
            commands = appCommands[app] || [app, app.toLowerCase()];
        }
        
        // Method 1: Try known command mappings
        for (let cmd of commands) {
            if (launched) break;
            try {
                if (cmd.includes('/')) {
                    // Full path command
                    Util.spawn_async([cmd], null);
                } else {
                    // Regular command
                    GLib.spawn_command_line_async(cmd);
                }
                launched = true;
                global.log("[" + UUID + "] Successfully launched via command: " + cmd);
                break;
            } catch (e) {
                // Try next command
            }
        }
        
        // Method 2: Try desktop file launching
        if (!launched) {
            try {
                let desktopFiles = [
                    app + '.desktop',
                    app.toLowerCase() + '.desktop',
                    app.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() + '.desktop'
                ];
                
                for (let desktopFile of desktopFiles) {
                    try {
                        GLib.spawn_command_line_async('gtk-launch ' + desktopFile);
                        launched = true;
                        global.log("[" + UUID + "] Successfully launched via desktop file: " + desktopFile);
                        break;
                    } catch (e) {
                        // Try next desktop file
                    }
                }
            } catch (e) {
                // Continue to next method
            }
        }
        
        // Method 3: Try Cinnamon app system
        if (!launched) {
            try {
                let appSystem = Cinnamon.AppSystem.get_default();
                let appInfo = appSystem.lookup_app(app + '.desktop') || appSystem.lookup_app(app);
                if (appInfo) {
                    appInfo.launch([], null);
                    launched = true;
                    global.log("[" + UUID + "] Successfully launched via Cinnamon app system: " + app);
                }
            } catch (e) {
                // Continue
            }
        }
        
        // Method 4: Try direct executable
        if (!launched) {
            try {
                // Check if command exists
                let [success, out] = GLib.spawn_command_line_sync('which ' + app.toLowerCase());
                if (success && out.length > 0) {
                    let execPath = out.toString().trim();
                    Util.spawn_async([execPath], null);
                    launched = true;
                    global.log("[" + UUID + "] Successfully launched via which: " + execPath);
                }
            } catch (e) {
                // Final attempt failed
            }
        }
        
        if (!launched) {
            global.log("[" + UUID + "] FAILED to launch application: " + app);
        }
        
        return launched;
    },
    
    _getVSCodeMostRecent: function() {
        // Read VS Code's global storage to get the most recently used workspace or folder
        try {
            let vscodeStoragePath = GLib.get_home_dir() + "/.config/Code/User/globalStorage/storage.json";
            if (!GLib.file_test(vscodeStoragePath, GLib.FileTest.EXISTS)) {
                global.log("[" + UUID + "] VS Code storage not found");
                return null;
            }
            
            let file = Gio.File.new_for_path(vscodeStoragePath);
            let [success, contents] = file.load_contents(null);
            if (!success) {
                global.log("[" + UUID + "] Failed to read VS Code storage");
                return null;
            }
            
            let storageData = JSON.parse(contents);
            if (storageData.windowsState && storageData.windowsState.lastActiveWindow) {
                let lastWindow = storageData.windowsState.lastActiveWindow;
                
                // Check if it was a workspace file
                if (lastWindow.workspaceIdentifier && lastWindow.workspaceIdentifier.configURIPath) {
                    let workspacePath = lastWindow.workspaceIdentifier.configURIPath.replace(/^file:\/\//, '');
                    global.log("[" + UUID + "] VS Code most recent: workspace file " + workspacePath);
                    return { type: 'workspace', path: workspacePath };
                }
                
                // Check if it was a folder (could be in different locations)
                if (lastWindow.folderUri) {
                    let folderPath = lastWindow.folderUri.replace(/^file:\/\//, '');
                    global.log("[" + UUID + "] VS Code most recent: folder " + folderPath);
                    return { type: 'folder', path: folderPath };
                }
                
                // Sometimes folder info is stored differently - check backup folders
                if (lastWindow.backupPath && storageData.backupWorkspaces && storageData.backupWorkspaces.folders) {
                    let recentFolder = storageData.backupWorkspaces.folders[0]; // Most recent folder
                    if (recentFolder && recentFolder.folderUri) {
                        let folderPath = recentFolder.folderUri.replace(/^file:\/\//, '');
                        global.log("[" + UUID + "] VS Code most recent: backup folder " + folderPath);
                        return { type: 'folder', path: folderPath };
                    }
                }
            }
            
            global.log("[" + UUID + "] No recent VS Code workspace/folder found in lastActiveWindow");
            return null;
        } catch (e) {
            global.log("[" + UUID + "] Error reading VS Code recent items: " + e);
            return null;
        }
    },
    
    _launchApplicationWindow: function(windowData) {
        let launched = false;
        let app = windowData.app;
        
        global.log("[" + UUID + "] Attempting to launch application: " + app);
        global.log("[" + UUID + "] Window details: title='" + windowData.title + "', wmClass='" + windowData.wmClass + "'");
        
        // Special handling for applications that support specific window opening
        if (app === "org.Nemo" || app === "Nemo") {
            // For file manager, try to open the specific location
            try {
                let path = this._extractPathFromTitle(windowData.title);
                if (path) {
                    GLib.spawn_command_line_async('nemo "' + path + '"');
                    launched = true;
                    global.log("[" + UUID + "] Launched Nemo with path: " + path);
                } else {
                    GLib.spawn_command_line_async('nemo');
                    launched = true;
                    global.log("[" + UUID + "] Launched Nemo (default location)");
                }
            } catch (e) {
                global.log("[" + UUID + "] Failed to launch Nemo: " + e);
            }
        } else if (app === "Code") {
            // For VS Code, try to open with the most recent workspace/folder
            global.log("[" + UUID + "] Entering VS Code launch section");
            try {
                // Priority 1: Use full workspace path if available
                // Priority 1: Get the most recent workspace/folder from VS Code storage (what user actually used last)
                let mostRecent = this._getVSCodeMostRecent();
                // Priority 2: Use full workspace path that was captured during session save
                let fullWorkspacePath = windowData.vscodeWorkspacePath;
                // Priority 3: Use stored workspace name from saved session
                let storedWorkspace = windowData.vscodeWorkspace;
                // Priority 4: Extract workspace from current title
                let extractedWorkspace = this._extractWorkspaceFromTitle(windowData.title);
                
                if (mostRecent) {
                    // Use VS Code's most recently used workspace/folder (highest priority)
                    global.log("[" + UUID + "] Launching VS Code with most recent " + mostRecent.type + ": " + mostRecent.path);
                    let command;
                    if (mostRecent.type === 'workspace') {
                        // Open workspace file
                        command = 'code "' + mostRecent.path + '"';
                    } else {
                        // Open folder
                        command = 'code "' + mostRecent.path + '"';
                    }
                    GLib.spawn_command_line_async(command);
                    launched = true;
                    global.log("[" + UUID + "] Launched VS Code with most recent " + mostRecent.type);
                } else if (fullWorkspacePath) {
                    // Use the full workspace path that was captured during session save
                    global.log("[" + UUID + "] Launching VS Code with full workspace path: " + fullWorkspacePath);
                    let command = this._buildVSCodeCommand(fullWorkspacePath);
                    GLib.spawn_command_line_async(command);
                    launched = true;
                    global.log("[" + UUID + "] Launched VS Code with full workspace path");
                } else if (storedWorkspace) {
                    // Use the workspace name that was stored when the session was saved
                    global.log("[" + UUID + "] Launching VS Code with stored workspace: " + storedWorkspace);
                    let command = this._buildVSCodeCommand(storedWorkspace);
                    GLib.spawn_command_line_async(command);
                    launched = true;
                    global.log("[" + UUID + "] Launched VS Code with stored workspace");
                } else if (extractedWorkspace) {
                    // Try to open the specific workspace from the title
                    global.log("[" + UUID + "] Launching VS Code with extracted workspace: " + extractedWorkspace);
                    let command = this._buildVSCodeCommand(extractedWorkspace);
                    GLib.spawn_command_line_async(command);
                    launched = true;
                    global.log("[" + UUID + "] Launched VS Code with extracted workspace");
                } else {
                    // Try to restore the last session automatically
                    global.log("[" + UUID + "] Launching VS Code with last session restore");
                    GLib.spawn_command_line_async('code --restore-last-session');
                    launched = true;
                    global.log("[" + UUID + "] Launched VS Code with last session restore");
                }
            } catch (e) {
                global.log("[" + UUID + "] VS Code launch failed, trying fallback: " + e);
                try {
                    // Fallback to simple launch
                    global.log("[" + UUID + "] Attempting fallback VS Code launch");
                    GLib.spawn_command_line_async('code');
                    launched = true;
                    global.log("[" + UUID + "] Launched VS Code (fallback)");
                } catch (e2) {
                    global.log("[" + UUID + "] Failed to launch VS Code: " + e2);
                }
            }
        } else if (app === "Terminator") {
            // For terminal, open new window
            global.log("[" + UUID + "] Entering Terminator launch section");
            try {
                global.log("[" + UUID + "] Attempting terminator command for new window");
                GLib.spawn_command_line_async('terminator');
                launched = true;
                global.log("[" + UUID + "] Launched Terminator (new window)");
            } catch (e) {
                global.log("[" + UUID + "] Failed to launch Terminator: " + e);
            }
        } else if (app === "firefox" || app === "Firefox") {
            // For Firefox, handle first launch vs subsequent windows carefully
            global.log("[" + UUID + "] Entering Firefox launch section");
            
            let isFirstFirefoxWindow = !this._launchedBrowsers.has("firefox");
            let currentFirefoxWindows = this._countApplicationWindows("firefox");
            
            global.log("[" + UUID + "] Firefox status - First window: " + isFirstFirefoxWindow + 
                      ", Current windows: " + currentFirefoxWindows);
            
            try {
                if (isFirstFirefoxWindow && currentFirefoxWindows === 0) {
                    // First Firefox window - launch without --new-window to avoid extra default window
                    global.log("[" + UUID + "] Launching first Firefox window (no --new-window)");
                    GLib.spawn_command_line_async('firefox');
                    this._launchedBrowsers.add("firefox");
                    launched = true;
                    global.log("[" + UUID + "] Launched first Firefox window");
                } else {
                    // Subsequent Firefox windows - use --new-window
                    global.log("[" + UUID + "] Launching additional Firefox window (--new-window)");
                    GLib.spawn_command_line_async('firefox --new-window');
                    launched = true;
                    global.log("[" + UUID + "] Launched additional Firefox window");
                }
            } catch (e) {
                global.log("[" + UUID + "] Firefox launch failed: " + e);
                try {
                    global.log("[" + UUID + "] Attempting fallback firefox command");
                    GLib.spawn_command_line_async('firefox');
                    launched = true;
                    global.log("[" + UUID + "] Launched Firefox (fallback)");
                } catch (e2) {
                    global.log("[" + UUID + "] Failed to launch Firefox: " + e2);
                }
            }
        } else if (app === "Brave-browser" || app === "brave-browser") {
            // For Brave browser, use a simpler approach to prevent extra windows
            global.log("[" + UUID + "] Entering Brave browser launch section");
            
            let currentBraveWindows = this._countApplicationWindows("Brave-browser");
            global.log("[" + UUID + "] Current Brave windows before launch: " + currentBraveWindows);
            
            try {
                // Always use --new-window for consistency, but we'll clean up extras later
                global.log("[" + UUID + "] Launching Brave browser window");
                GLib.spawn_command_line_async('brave-browser --new-window');
                launched = true;
                global.log("[" + UUID + "] Launched Brave window");
                
                // Mark that we've launched Brave for cleanup tracking
                this._launchedBrowsers.add("Brave-browser");
                
            } catch (e) {
                global.log("[" + UUID + "] Brave launch failed: " + e);
                try {
                    global.log("[" + UUID + "] Attempting fallback brave-browser command");
                    GLib.spawn_command_line_async('brave-browser');
                    launched = true;
                    global.log("[" + UUID + "] Launched Brave (fallback)");
                } catch (e2) {
                    global.log("[" + UUID + "] Failed to launch Brave: " + e2);
                }
            }
        } else {
            // For other applications, use the general launch method
            global.log("[" + UUID + "] Using general launch method for: " + app);
            launched = this._launchApplication(app, windowData);
            if (launched) {
                global.log("[" + UUID + "] General launch successful for: " + app);
            } else {
                global.log("[" + UUID + "] General launch failed for: " + app);
            }
        }
        
        global.log("[" + UUID + "] Launch result for " + app + ": " + (launched ? "SUCCESS" : "FAILED"));
        return launched;
    },
    
    _extractPathFromTitle: function(title) {
        // Extract file path from Nemo window title
        // Common patterns: "Home", "/tmp", "/path/to/folder"
        if (title === "Home") {
            return GLib.get_home_dir();
        } else if (title.startsWith("/")) {
            return title;
        } else if (title === "tmp") {
            return "/tmp";
        }
        return null;
    },
    
    _extractWorkspaceFromTitle: function(title) {
        // Extract workspace/project from VS Code title
        // Common patterns:
        // "filename - workspace (Workspace) - Visual Studio Code"
        // "workspace (Workspace) - Visual Studio Code" 
        // "filename - folder_name - Visual Studio Code"
        // "folder_name - Visual Studio Code"
        
        global.log("[" + UUID + "] Extracting workspace from title: " + title);
        
        if (!title || !title.includes("Visual Studio Code")) {
            return null;
        }
        
        // Remove "Visual Studio Code" from the end
        let cleanTitle = title.replace(" - Visual Studio Code", "");
        
        // Pattern 1: "filename - workspace (Workspace)"
        if (cleanTitle.includes("(Workspace)")) {
            let parts = cleanTitle.split(" - ");
            for (let i = 0; i < parts.length; i++) {
                if (parts[i].includes("(Workspace)")) {
                    let workspace = parts[i].replace(" (Workspace)", "").trim();
                    global.log("[" + UUID + "] Found workspace pattern: " + workspace);
                    return workspace;
                }
            }
        }
        
        // Pattern 2: "filename - folder_name" or just "folder_name"
        let parts = cleanTitle.split(" - ");
        if (parts.length >= 2) {
            // Take the last part as potential folder name
            let potentialFolder = parts[parts.length - 1].trim();
            global.log("[" + UUID + "] Found potential folder: " + potentialFolder);
            return potentialFolder;
        } else if (parts.length === 1) {
            // Single part, could be just a folder name
            let potentialFolder = parts[0].trim();
            global.log("[" + UUID + "] Found single folder: " + potentialFolder);
            return potentialFolder;
        }
        
        return null;
    },
    
    _getVSCodeRecentWorkspace: function() {
        // Try to get the most recent workspace/folder from VS Code's storage
        try {
            let homeDir = GLib.get_home_dir();
            
            // Try multiple possible storage locations
            let possibleStorageFiles = [
                homeDir + "/.config/Code/storage.json",
                homeDir + "/.config/Code/User/globalStorage/storage.json",
                homeDir + "/.vscode/extensions/ms-vscode.vscode-json/package.json", // Alternative
                homeDir + "/.config/Code/logs/main.log" // Last resort - check recent logs
            ];
            
            let storageFile = null;
            for (let file of possibleStorageFiles) {
                if (GLib.file_test(file, GLib.FileTest.EXISTS)) {
                    storageFile = file;
                    global.log("[" + UUID + "] Found VS Code storage at: " + file);
                    break;
                }
            }
            
            if (!storageFile) {
                global.log("[" + UUID + "] No VS Code storage files found");
                // Try to get recent workspace from command line history or recent files
                return this._getVSCodeRecentFromCLI();
            }
            
            // For now, only handle the main storage.json format
            if (!storageFile.endsWith('storage.json')) {
                global.log("[" + UUID + "] Storage file is not storage.json format");
                return this._getVSCodeRecentFromCLI();
            }
            
            // Read the storage file
            let file = Gio.File.new_for_path(storageFile);
            let [success, contents] = file.load_contents(null);
            
            if (!success) {
                global.log("[" + UUID + "] Failed to read VS Code storage.json");
                return this._getVSCodeRecentFromCLI();
            }
            
            let storageData = JSON.parse(contents.toString());
            
            // Look for recent workspaces/folders
            if (storageData.openedPathsList && storageData.openedPathsList.entries && 
                storageData.openedPathsList.entries.length > 0) {
                
                let recentPath = storageData.openedPathsList.entries[0];
                if (recentPath.folderUri) {
                    // It's a folder
                    let folderPath = recentPath.folderUri.replace("file://", "");
                    global.log("[" + UUID + "] Found recent folder: " + folderPath);
                    return folderPath;
                } else if (recentPath.workspace && recentPath.workspace.configPath) {
                    // It's a workspace file
                    let workspacePath = recentPath.workspace.configPath.replace("file://", "");
                    global.log("[" + UUID + "] Found recent workspace: " + workspacePath);
                    return workspacePath;
                }
            }
            
            global.log("[" + UUID + "] No recent workspaces found in storage");
            return this._getVSCodeRecentFromCLI();
            
        } catch (e) {
            global.log("[" + UUID + "] Error reading VS Code recent workspaces: " + e);
            return this._getVSCodeRecentFromCLI();
        }
    },
    
    _getVSCodeRecentFromCLI: function() {
        // Fallback method: try to get recent workspace from command line
        try {
            global.log("[" + UUID + "] Trying to get recent VS Code workspace from CLI");
            
            // Check if VS Code has a recent files command
            let [success, output] = GLib.spawn_command_line_sync('code --list-extensions 2>/dev/null');
            if (success) {
                // VS Code is available, we can try to get recent workspaces
                // For now, just return null and let the restore-last-session handle it
                global.log("[" + UUID + "] VS Code CLI available, will use --restore-last-session");
                return null;
            }
            
            global.log("[" + UUID + "] VS Code CLI not available");
            return null;
            
        } catch (e) {
            global.log("[" + UUID + "] Error getting VS Code recent from CLI: " + e);
            return null;
        }
    },
    
    _buildVSCodeCommand: function(workspacePath) {
        // Build a proper VS Code command with the workspace/folder path
        if (!workspacePath) {
            return 'code';
        }
        
        // Check if it's a workspace file (.code-workspace) or a folder
        if (workspacePath.endsWith('.code-workspace')) {
            // It's a workspace file
            global.log("[" + UUID + "] Building command for workspace file: " + workspacePath);
            return 'code "' + workspacePath + '"';
        } else {
            // It's a folder path - check if it exists
            if (GLib.file_test(workspacePath, GLib.FileTest.IS_DIR)) {
                global.log("[" + UUID + "] Building command for folder: " + workspacePath);
                return 'code "' + workspacePath + '"';
            } else {
                // Path doesn't exist, try to find it in common locations
                let homeDir = GLib.get_home_dir();
                let potentialPaths = [
                    homeDir + "/" + workspacePath,
                    homeDir + "/.github/" + workspacePath,  // Add .github directory  
                    homeDir + "/Projects/" + workspacePath,
                    homeDir + "/projects/" + workspacePath,
                    homeDir + "/Code/" + workspacePath,
                    homeDir + "/code/" + workspacePath,
                    homeDir + "/workspace/" + workspacePath,
                    homeDir + "/Workspace/" + workspacePath,
                    homeDir + "/Documents/" + workspacePath,
                    homeDir + "/git/" + workspacePath,       // Add common git directory
                    homeDir + "/Github/" + workspacePath,    // Add Github directory
                    homeDir + "/github/" + workspacePath,    // Add github directory
                    "/home/" + workspacePath,
                    "/opt/" + workspacePath
                ];
                
                for (let path of potentialPaths) {
                    if (GLib.file_test(path, GLib.FileTest.IS_DIR)) {
                        global.log("[" + UUID + "] Found workspace at: " + path);
                        return 'code "' + path + '"';
                    }
                }
                
                global.log("[" + UUID + "] Workspace path not found, using as-is: " + workspacePath);
                return 'code "' + workspacePath + '"';
            }
        }
    },
    
    _getVSCodeWorkspacePath: function(pid) {
        // Try to get the actual working directory of the VS Code process
        try {
            let [success, cwd] = GLib.file_get_contents('/proc/' + pid + '/cwd');
            if (success) {
                let workingDir = GLib.filename_to_utf8(cwd, -1, null, null, null)[0];
                if (workingDir && GLib.file_test(workingDir, GLib.FileTest.IS_DIR)) {
                    global.log("[" + UUID + "] Found VS Code working directory: " + workingDir);
                    return workingDir;
                }
            }
        } catch (e) {
            // /proc method failed, try alternative approach
            try {
                let [success, stdout, stderr, exit_status] = GLib.spawn_command_line_sync('readlink /proc/' + pid + '/cwd');
                if (success && exit_status === 0) {
                    let workingDir = new TextDecoder().decode(stdout).trim();
                    if (workingDir && GLib.file_test(workingDir, GLib.FileTest.IS_DIR)) {
                        global.log("[" + UUID + "] Found VS Code working directory via readlink: " + workingDir);
                        return workingDir;
                    }
                }
            } catch (e2) {
                global.log("[" + UUID + "] Could not determine VS Code working directory: " + e2);
            }
        }
        return null;
    },
    
    _positionWindows: function(sessionData) {
        let positionedCount = 0;
        let positionedWindows = new Set(); // Track which actual windows we've positioned
        
        global.log("[" + UUID + "] Attempting to position " + sessionData.windows.length + " windows");
        
        for (let windowData of sessionData.windows) {
            let windows = global.get_window_actors();
            let windowFound = false;
            
            for (let windowActor of windows) {
                let window = windowActor.get_meta_window();
                if (!window) continue;
                
                // Skip if we already positioned this window
                let windowId = window.get_stable_sequence();
                if (positionedWindows.has(windowId)) {
                    continue;
                }
                
                // Try multiple matching strategies
                let app = window.get_gtk_application_id() || 
                         window.get_wm_class() || 
                         window.get_wm_class_instance();
                
                let titleMatch = window.get_title() === windowData.title;
                let appMatch = app === windowData.app;
                let wmClassMatch = window.get_wm_class() === windowData.wmClass;
                let wmInstanceMatch = window.get_wm_class_instance() === windowData.wmClassInstance;
                
                // For applications with multiple windows, prefer exact title matches
                let isExactMatch = appMatch && titleMatch;
                let isGoodMatch = appMatch && (wmClassMatch || wmInstanceMatch);
                let isBasicMatch = appMatch && !titleMatch;
                
                // Prioritize exact matches, then good matches for same app
                if (isExactMatch || (isGoodMatch && !windowFound) || (isBasicMatch && !windowFound && !this._hasExactTitleMatch(windows, windowData))) {
                    try {
                        global.log("[" + UUID + "] Positioning window: " + windowData.app + " -> " + windowData.title + 
                                  " (match: " + (isExactMatch ? "exact" : isGoodMatch ? "good" : "basic") + ")");
                        
                        // Move to correct workspace first
                        let workspace = global.workspace_manager.get_workspace_by_index(windowData.workspace);
                        if (workspace && window.get_workspace() !== workspace) {
                            window.change_workspace(workspace);
                            global.log("[" + UUID + "] Moved to workspace " + windowData.workspace);
                        }
                        
                        // Handle window state
                        if (windowData.maximized) {
                            window.maximize(Meta.MaximizeFlags.BOTH);
                            global.log("[" + UUID + "] Maximized window");
                        } else {
                            window.unmaximize(Meta.MaximizeFlags.BOTH);
                            // Wait a bit before positioning
                            Mainloop.timeout_add(200, () => {
                                window.move_resize_frame(false, windowData.x, windowData.y, 
                                                       windowData.width, windowData.height);
                                global.log("[" + UUID + "] Positioned window at " + windowData.x + "," + windowData.y);
                                return false;
                            });
                        }
                        
                        if (windowData.minimized) {
                            window.minimize();
                            global.log("[" + UUID + "] Minimized window");
                        } else {
                            window.unminimize();
                        }
                        
                        positionedCount++;
                        positionedWindows.add(windowId);
                        windowFound = true;
                        
                        // For exact matches, break immediately
                        if (isExactMatch) {
                            break;
                        }
                    } catch (e) {
                        global.log("[" + UUID + "] Failed to position window: " + windowData.title + " - " + e);
                    }
                }
            }
            
            if (!windowFound) {
                global.log("[" + UUID + "] Could not find window for: " + windowData.app + " (" + windowData.title + ")");
            }
        }
        
        global.log("[" + UUID + "] Successfully positioned " + positionedCount + " out of " + sessionData.windows.length + " windows");
        
        // Show notification
        this._showNotification("Session Restored", 
            "Restored " + positionedCount + " windows from saved session");
        
        // Restore active workspace
        if (sessionData.currentWorkspace !== undefined) {
            let workspace = global.workspace_manager.get_workspace_by_index(sessionData.currentWorkspace);
            if (workspace) {
                workspace.activate(global.get_current_time());
                global.log("[" + UUID + "] Switched to workspace " + sessionData.currentWorkspace);
            }
        }
    },
    
    _hasExactTitleMatch: function(windows, windowData) {
        // Check if there's a window with the exact title match for this app
        for (let windowActor of windows) {
            let window = windowActor.get_meta_window();
            if (!window) continue;
            
            let app = window.get_gtk_application_id() || 
                     window.get_wm_class() || 
                     window.get_wm_class_instance();
            
            if (app === windowData.app && window.get_title() === windowData.title) {
                return true;
            }
        }
        return false;
    },
    
    _showNotification: function(title, message) {
        try {
            // Only show notifications in debug mode or for important events
            if (this.debugMode || title.includes("Failed") || title.includes("Error")) {
                let source = new MessageTray.Source("Save Cinnamon Session");
                let notification = new MessageTray.Notification(source, title, message);
                
                // Set a shorter timeout for non-critical notifications
                notification.setTransient(true);
                
                Main.messageTray.add(source);
                source.notify(notification);
            }
        } catch (e) {
            // If notification fails, just log it
            global.log("[" + UUID + "] Notification: " + title + " - " + message);
        }
    },
    
    _cleanupExcessBrowserWindows: function(sessionData) {
        global.log("[" + UUID + "] Starting cleanup of excess browser windows");
        
        // Count expected windows by browser type
        let expectedBrowserWindows = {};
        for (let windowData of sessionData.windows) {
            if (windowData.app === "Brave-browser" || windowData.app === "firefox") {
                if (!expectedBrowserWindows[windowData.app]) {
                    expectedBrowserWindows[windowData.app] = 0;
                }
                expectedBrowserWindows[windowData.app]++;
            }
        }
        
        global.log("[" + UUID + "] Expected browser windows: " + JSON.stringify(expectedBrowserWindows));
        
        // Check current browser windows and close extras
        for (let browserApp in expectedBrowserWindows) {
            let expectedCount = expectedBrowserWindows[browserApp];
            let currentWindows = this._getBrowserWindows(browserApp);
            let currentCount = currentWindows.length;
            
            global.log("[" + UUID + "] " + browserApp + " - Expected: " + expectedCount + ", Current: " + currentCount);
            
            if (currentCount > expectedCount) {
                let excessCount = currentCount - expectedCount;
                global.log("[" + UUID + "] Closing " + excessCount + " excess " + browserApp + " windows");
                
                // Close the newest windows (likely the extra ones created during startup)
                // Sort by creation time or position, prefer closing "New tab" windows
                let windowsToClose = currentWindows
                    .filter(w => w.get_title().includes("New tab") || w.get_title() === "New Tab")
                    .slice(0, excessCount);
                
                // If not enough "New tab" windows, close any excess windows
                if (windowsToClose.length < excessCount) {
                    let remaining = excessCount - windowsToClose.length;
                    let otherWindows = currentWindows
                        .filter(w => !windowsToClose.includes(w))
                        .slice(-remaining); // Take the last ones (newest)
                    windowsToClose = windowsToClose.concat(otherWindows);
                }
                
                for (let i = 0; i < Math.min(excessCount, windowsToClose.length); i++) {
                    let windowToClose = windowsToClose[i];
                    global.log("[" + UUID + "] Closing excess window: " + windowToClose.get_title());
                    try {
                        windowToClose.delete(global.get_current_time());
                    } catch (e) {
                        global.log("[" + UUID + "] Failed to close window: " + e);
                    }
                }
            }
        }
        
        global.log("[" + UUID + "] Browser window cleanup completed");
    },
    
    _getBrowserWindows: function(browserApp) {
        let browserWindows = [];
        let windows = global.get_window_actors();
        
        for (let windowActor of windows) {
            let window = windowActor.get_meta_window();
            if (!window || window.is_skip_taskbar()) continue;
            
            let gtkAppId = window.get_gtk_application_id();
            let wmClass = window.get_wm_class();
            let wmClassInstance = window.get_wm_class_instance();
            
            let matches = false;
            if (browserApp === "Brave-browser") {
                matches = wmClass === "Brave-browser" || wmClassInstance === "brave-browser" || 
                         gtkAppId === "com.brave.Browser";
            } else if (browserApp === "firefox") {
                matches = wmClass === "firefox" || wmClassInstance === "Navigator" || 
                         gtkAppId === "firefox" || wmClass === "Firefox";
            }
            
            if (matches) {
                browserWindows.push(window);
            }
        }
        
        return browserWindows;
    }
};

function init(metadata) {
    extension = new SaveCinnamonSessionExtension();
}

function enable() {
    if (extension) {
        extension.enable();
    }
}

function disable() {
    if (extension) {
        extension.disable();
        extension = null;
    }
}