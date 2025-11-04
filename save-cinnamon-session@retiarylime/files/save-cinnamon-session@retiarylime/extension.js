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
        this._restoredAppsThisSession = new Set(); // track apps restored in this login session        // Set default values first
        this.autoSaveOnLogout = true;
        this.autoRestoreOnLogin = true;
        this.restoreDelay = 5000; // 5 seconds delay before restoring
        this.excludedApps = "cinnamon-settings,cinnamon-killer-daemon";
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
            this.settings.bind("manual-save-keybinding", "manualSaveKeybinding", this._onKeybindingChanged);
            this.settings.bind("manual-restore-keybinding", "manualRestoreKeybinding", this._onKeybindingChanged);
            this.settings.bind("debug-mode", "debugMode", this._onSettingsChanged);
        } catch (e) {
            global.log("[" + UUID + "] Settings binding failed, using defaults: " + e);
        }
        
        global.log("[" + UUID + "] Extension initialized with auto-save: " + this.autoSaveOnLogout + 
                   ", auto-restore: " + this.autoRestoreOnLogin + ", delay: " + this.restoreDelay + "ms");
    },
    
    enable: function() {
        global.log("[" + UUID + "] Enabling extension");
        // Mark that we are in startup restore phase to avoid auto-saving and overwriting
        this._restoring = true;
        
        // Connect to session management signals
        this._connectSessionSignals();
        
        // Set up keybindings
        this._setupKeybindings();
        
        // Schedule an initial save, but _saveSession will skip writes while this._restoring is true
        Mainloop.timeout_add(3000, () => {
            this._saveSession();
            return false;
        });
        
        // Check for login restoration with multiple attempts for reliability
        this._attemptSessionRestore();
    },
    
    _attemptSessionRestore: function() {
        if (!this.autoRestoreOnLogin) {
            global.log("[" + UUID + "] Auto-restore on login is disabled");
            return;
        }
        
        if (!GLib.file_test(this._sessionFile, GLib.FileTest.EXISTS)) {
            global.log("[" + UUID + "] No session file found for restoration");
            return;
        }
        
        global.log("[" + UUID + "] SESSION RESTORE STARTING");
        
        // Start restoration process with staggered timing for reliability
        let restoreAttempts = [
            { delay: 3000, name: "Quick restore" },      // 3 seconds - catch early desktop
            { delay: 8000, name: "Main restore" },       // 8 seconds - main attempt  
            { delay: 15000, name: "Delayed restore" },   // 15 seconds - after full desktop load
            { delay: 25000, name: "Final restore" }      // 25 seconds - final safety net
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
                   ", auto-restore: " + this.autoRestoreOnLogin + ", delay: " + this.restoreDelay + "ms");
    },
    
    _onKeybindingChanged: function() {
        // Clean up old keybindings and set up new ones
        this._cleanupKeybindings();
        this._setupKeybindings();
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
    
    _setupExitHooks: function() {
        // Set up additional exit detection methods
        try {
            // Create a PID file that will be cleaned up on clean shutdown
            this._pidFile = GLib.get_home_dir() + "/.cinnamon-session-running-" + GLib.get_real_time();
            let pidFile = Gio.File.new_for_path(this._pidFile);
            let stream = pidFile.create(Gio.FileCreateFlags.NONE, null);
            stream.close(null);
            
            // Set up a periodic check to save session data
            this._periodicSaveId = Mainloop.timeout_add_seconds(30, () => { // Every 30 seconds
                if (this.autoSaveOnLogout) {
                    this._saveSession();
                }
                return true;
            });
            
            // Create an autostart entry to help with restoration
            this._createAutostartEntry();
            
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
        // Create an autostart entry that triggers session restoration
        try {
            let autostartContent = `[Desktop Entry]
Type=Application
Name=Cinnamon Session Restore
Comment=Restore saved Cinnamon session on login
Exec=bash -c "sleep 8 && if [ -f ~/.cinnamon-session-save.json ]; then dbus-send --session --type=method_call --dest=org.Cinnamon /org/Cinnamon org.Cinnamon.RestoreSession 2>/dev/null || ~/.cinnamon-session-restore.sh; fi"
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=8
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
            
            global.log("[" + UUID + "] Enhanced autostart entry created for session restoration");
        } catch (e) {
            global.log("[" + UUID + "] Could not create autostart entry: " + e);
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
                this._restoreSession();
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
            
            // Skip excluded applications - be more lenient with exclusions
            let shouldExclude = excludedAppsArray.some(excluded => {
                return app.toLowerCase().includes(excluded) || 
                       title.toLowerCase().includes(excluded);
            });
            
            if (shouldExclude) {
                global.log("[" + UUID + "] Excluding application: " + app + " (title: " + title + ")");
                continue;
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
            
            // Create a unique key for duplicate detection
            let windowKey = app + "|" + windowData.title + "|" + frame.x + "|" + frame.y + "|" + frame.width + "|" + frame.height;
            
            if (seenWindows.has(windowKey)) {
                global.log("[" + UUID + "] Skipping duplicate window: " + app + " (" + windowData.title + ")");
                continue;
            }
            seenWindows.add(windowKey);
            
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
        
        // Restore each window individually
        let windowsToRestore = sessionData.windows.slice(); // Copy array
        let restoredCount = 0;
        
        for (let i = 0; i < windowsToRestore.length; i++) {
            let windowData = windowsToRestore[i];
            let windowId = windowData.app + "_" + windowData.title + "_" + windowData.x + "_" + windowData.y;
            
            if (restoredWindows.has(windowId)) {
                global.log("[" + UUID + "] Skipping duplicate window: " + windowId);
                continue;
            }
            
            // Check if we already restored this app in this session (but allow multiple windows)
            let currentWindowCount = this._countApplicationWindows(windowData.app);
            let expectedWindowCount = appWindows[windowData.app].length;
            
            global.log("[" + UUID + "] Restoring window " + (i + 1) + "/" + windowsToRestore.length + ": " + 
                      windowData.app + " (" + windowData.title + ") - Current: " + currentWindowCount + ", Expected: " + expectedWindowCount);
            
            try {
                // For applications that support multiple windows, we need to launch them multiple times
                // or use specific launch parameters
                let launched = this._launchApplicationWindow(windowData);
                if (launched) {
                    restoredWindows.add(windowId);
                    restoredCount++;
                    this._restoredAppsThisSession.add(windowData.app);
                    global.log("[" + UUID + "] Successfully launched window: " + windowData.app + " (" + windowData.title + ")");
                } else {
                    global.log("[" + UUID + "] Failed to launch window: " + windowData.app + " (" + windowData.title + ")");
                }
            } catch (e) {
                global.log("[" + UUID + "] Exception launching window: " + windowData.app + " - " + e);
            }
            
            // Add delay between window launches to avoid overwhelming the system
            if (i < windowsToRestore.length - 1) {
                // We'll use setTimeout to add delays, but for now continue synchronously
            }
        }
        
        // Schedule window positioning with longer delay based on number of windows
        let positioningDelay = Math.max(10000, restoredCount * 2000); // More time for more windows
        Mainloop.timeout_add(positioningDelay, () => { 
            this._positionWindows(sessionData);
            // Release restoration lock after positioning is complete
            this._restorationInProgress = false;
            global.log("[" + UUID + "] Restoration complete - lock released");
            return false;
        });
        
        global.log("[" + UUID + "] Launched " + restoredCount + " windows, positioning in " + positioningDelay + "ms");
    },
    
    _isApplicationRunning: function(appName) {
        let windows = global.get_window_actors();
        for (let windowActor of windows) {
            let window = windowActor.get_meta_window();
            if (!window) continue;
            
            let app = window.get_gtk_application_id() || 
                     window.get_wm_class() || 
                     window.get_wm_class_instance();
            
            if (app === appName) {
                return true;
            }
        }
        return false;
    },
    
    _countApplicationWindows: function(appName) {
        let count = 0;
        let windows = global.get_window_actors();
        for (let windowActor of windows) {
            let window = windowActor.get_meta_window();
            if (!window) continue;
            
            let app = window.get_gtk_application_id() || 
                     window.get_wm_class() || 
                     window.get_wm_class_instance();
            
            if (app === appName) {
                count++;
            }
        }
        return count;
    },
    
    _launchApplication: function(app) {
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
            'Xlet-settings.py': ['cinnamon-settings extensions'],
            'gnome-terminal-server': ['gnome-terminal', '/usr/bin/gnome-terminal'],
            'thunderbird': ['thunderbird', '/usr/bin/thunderbird'],
            'libreoffice': ['libreoffice', '/usr/bin/libreoffice'],
            'gedit': ['gedit', '/usr/bin/gedit'],
            'nautilus': ['nautilus', '/usr/bin/nautilus']
        };
        
        // Get possible commands for this app
        let commands = appCommands[app] || [app, app.toLowerCase()];
        
        // Method 1: Try known command mappings
        for (let cmd of commands) {
            if (launched) break;
            try {
                if (cmd.includes('/')) {
                    // Full path command
                    Util.spawn_async([cmd], null);
                } else {
                    // Regular command
                    Util.spawn_command_line_async(cmd);
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
                        Util.spawn_command_line_async('gtk-launch ' + desktopFile);
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
    
    _launchApplicationWindow: function(windowData) {
        let launched = false;
        let app = windowData.app;
        
        global.log("[" + UUID + "] Attempting to launch window: " + app + " (" + windowData.title + ")");
        
        // Special handling for applications that support specific window opening
        if (app === "org.Nemo" || app === "Nemo") {
            // For file manager, try to open the specific location
            try {
                let path = this._extractPathFromTitle(windowData.title);
                if (path) {
                    Util.spawn_command_line_async('nemo "' + path + '"');
                    launched = true;
                    global.log("[" + UUID + "] Launched Nemo with path: " + path);
                } else {
                    Util.spawn_command_line_async('nemo');
                    launched = true;
                    global.log("[" + UUID + "] Launched Nemo (default location)");
                }
            } catch (e) {
                global.log("[" + UUID + "] Failed to launch Nemo: " + e);
            }
        } else if (app === "Code") {
            // For VS Code, try to open with workspace or file
            try {
                let workspace = this._extractWorkspaceFromTitle(windowData.title);
                if (workspace) {
                    Util.spawn_command_line_async('code "' + workspace + '"');
                    launched = true;
                    global.log("[" + UUID + "] Launched VS Code with workspace: " + workspace);
                } else {
                    Util.spawn_command_line_async('code');
                    launched = true;
                    global.log("[" + UUID + "] Launched VS Code (new window)");
                }
            } catch (e) {
                global.log("[" + UUID + "] Failed to launch VS Code: " + e);
            }
        } else if (app === "Terminator") {
            // For terminal, open new window
            try {
                Util.spawn_command_line_async('terminator --new-tab');
                launched = true;
                global.log("[" + UUID + "] Launched Terminator (new window)");
            } catch (e) {
                try {
                    Util.spawn_command_line_async('terminator');
                    launched = true;
                    global.log("[" + UUID + "] Launched Terminator (fallback)");
                } catch (e2) {
                    global.log("[" + UUID + "] Failed to launch Terminator: " + e2);
                }
            }
        } else if (app === "firefox" || app === "Firefox") {
            // For Firefox, open new window
            try {
                Util.spawn_command_line_async('firefox --new-window');
                launched = true;
                global.log("[" + UUID + "] Launched Firefox (new window)");
            } catch (e) {
                try {
                    Util.spawn_command_line_async('firefox');
                    launched = true;
                    global.log("[" + UUID + "] Launched Firefox (fallback)");
                } catch (e2) {
                    global.log("[" + UUID + "] Failed to launch Firefox: " + e2);
                }
            }
        } else {
            // For other applications, use the general launch method
            launched = this._launchApplication(app);
        }
        
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
        // Pattern: "filename - workspace (Workspace) - Visual Studio Code"
        if (title.includes(" - ") && title.includes("(Workspace)")) {
            let parts = title.split(" - ");
            if (parts.length >= 2) {
                let workspace = parts[1].replace(" (Workspace)", "");
                return workspace;
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