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
        
        // Set default values first
        this.autoSaveOnLogout = true;
        this.autoRestoreOnLogin = true;
        this.restoreDelay = 3000; // 3 seconds delay before restoring
        this.excludedApps = "cinnamon-settings,cinnamon-killer-daemon,nemo-desktop";
        this.manualSaveKeybinding = "<Super><Shift>s";
        this.manualRestoreKeybinding = "<Super><Shift>r";
        this.debugMode = false;
        
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
        
        // Connect to session management signals
        this._connectSessionSignals();
        
        // Set up keybindings
        this._setupKeybindings();
        
        // Perform an initial save to ensure we have baseline session data
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
        
        // Multiple restoration attempts with increasing delays to handle desktop loading
        let attempts = [
            { delay: this.restoreDelay, description: "Initial attempt" },
            { delay: this.restoreDelay + 5000, description: "Second attempt (if first failed)" },
            { delay: this.restoreDelay + 15000, description: "Final attempt" }
        ];
        
        global.log("[" + UUID + "] Scheduling " + attempts.length + " restoration attempts");
        
        for (let i = 0; i < attempts.length; i++) {
            let attempt = attempts[i];
            Mainloop.timeout_add(attempt.delay, () => {
                global.log("[" + UUID + "] " + attempt.description + " at " + attempt.delay + "ms");
                this._restoreSession();
                return false;
            });
        }
    },
    
    disable: function() {
        global.log("[" + UUID + "] Disabling extension - FORCING SESSION SAVE");
        
        // CRITICAL: Save session IMMEDIATELY on disable - this is our most reliable logout detection
        if (this.autoSaveOnLogout) {
            global.log("[" + UUID + "] LOGOUT DETECTED - Saving session immediately");
            this._saveSession();
            // Also create a backup save
            Mainloop.timeout_add(100, () => {
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
        
        global.log("[" + UUID + "] Extension disabled and session FORCIBLY saved for logout");
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
Name=Cinnamon Session Restore Helper
Comment=Helper to ensure session restoration works on login
Exec=bash -c "sleep 5 && dbus-send --session --type=method_call --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames | grep -q org.Cinnamon && echo 'Session restore ready' || true"
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=5`;
            
            let autostartDir = GLib.get_home_dir() + "/.config/autostart";
            let autostartFile = autostartDir + "/cinnamon-session-restore-helper.desktop";
            
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
            
            global.log("[" + UUID + "] Autostart entry created for session restoration");
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
            let sessionData = this._collectSessionData();
            let jsonData = JSON.stringify(sessionData, null, 2);
            
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
        
        global.log("[" + UUID + "] Collecting session data from " + windows.length + " window actors");
        
        for (let windowActor of windows) {
            let window = windowActor.get_meta_window();
            if (!window || window.is_skip_taskbar()) continue;
            
            // Get application information - try multiple methods
            let app = window.get_gtk_application_id() || 
                     window.get_wm_class() || 
                     window.get_wm_class_instance() ||
                     window.get_title();
            
            if (!app) {
                global.log("[" + UUID + "] Skipping window with no identifiable app");
                continue;
            }
            
            // Skip excluded applications
            if (excludedAppsArray.some(excluded => app.toLowerCase().includes(excluded))) {
                global.log("[" + UUID + "] Excluding application: " + app);
                continue;
            }
            
            let frame = window.get_frame_rect();
            let workspaceIndex = window.get_workspace().index();
            
            // Get additional window information
            let pid = window.get_pid();
            let windowType = window.get_window_type();
            
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
                wmClassInstance: window.get_wm_class_instance()
            };
            
            sessionData.windows.push(windowData);
            
            // Track workspace usage
            if (!sessionData.workspaces[workspaceIndex]) {
                sessionData.workspaces[workspaceIndex] = {
                    name: "Workspace " + (workspaceIndex + 1),
                    windowCount: 0
                };
            }
            sessionData.workspaces[workspaceIndex].windowCount++;
            
            global.log("[" + UUID + "] Captured window: " + app + " (" + windowData.title + ") on workspace " + workspaceIndex);
        }
        
        global.log("[" + UUID + "] Session data collected: " + sessionData.windows.length + " windows, " + Object.keys(sessionData.workspaces).length + " workspaces");
        return sessionData;
    },
    
    _restoreSession: function() {
        try {
            if (!GLib.file_test(this._sessionFile, GLib.FileTest.EXISTS)) {
                global.log("[" + UUID + "] No session file found to restore");
                return;
            }
            
            let file = Gio.File.new_for_path(this._sessionFile);
            let [success, contents] = file.load_contents(null);
            
            if (!success) {
                global.logError("[" + UUID + "] Failed to read session file");
                return;
            }
            
            let sessionData = JSON.parse(contents);
            
            // Validate session data
            if (!sessionData.windows || !Array.isArray(sessionData.windows) || sessionData.windows.length === 0) {
                global.log("[" + UUID + "] Session file contains no valid windows to restore");
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
        }
    },
    
    _restoreApplications: function(sessionData) {
        let restoredApps = new Set();
        
        // Group windows by application
        let appWindows = {};
        for (let windowData of sessionData.windows) {
            if (!appWindows[windowData.app]) {
                appWindows[windowData.app] = [];
            }
            appWindows[windowData.app].push(windowData);
        }
        
        global.log("[" + UUID + "] Attempting to restore " + Object.keys(appWindows).length + " applications");
        
        // Launch applications with enhanced detection
        for (let app in appWindows) {
            if (restoredApps.has(app)) continue;
            
            // Skip if application is already running
            let isAlreadyRunning = this._isApplicationRunning(app);
            if (isAlreadyRunning) {
                global.log("[" + UUID + "] Application already running: " + app);
                restoredApps.add(app);
                continue;
            }
            
            try {
                let launched = this._launchApplication(app);
                if (launched) {
                    restoredApps.add(app);
                } else {
                    global.log("[" + UUID + "] Failed to launch application: " + app);
                }
            } catch (e) {
                global.log("[" + UUID + "] Exception launching application: " + app + " - " + e);
            }
        }
        
        // Schedule window positioning with longer delay for more apps
        let positioningDelay = Math.max(8000, restoredApps.size * 2000); // More time for more apps
        Mainloop.timeout_add(positioningDelay, () => { 
            this._positionWindows(sessionData);
            return false;
        });
        
        global.log("[" + UUID + "] Launched " + restoredApps.size + " applications, positioning in " + positioningDelay + "ms");
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
    
    _launchApplication: function(app) {
        let launched = false;
        
        // Method 1: Try as a desktop file name via Cinnamon's app system
        if (!launched) {
            try {
                let appSystem = Cinnamon.AppSystem.get_default();
                let appInfo = appSystem.lookup_app(app + '.desktop');
                if (!appInfo) {
                    appInfo = appSystem.lookup_app(app);
                }
                if (appInfo) {
                    appInfo.launch([], null);
                    launched = true;
                    global.log("[" + UUID + "] Launched via app system: " + app);
                }
            } catch (e) {
                // Continue to next method
            }
        }
        
        // Method 2: Try desktop file if it looks like an app ID
        if (!launched && app.includes('.')) {
            try {
                Util.spawn_command_line_async('gtk-launch ' + app);
                launched = true;
                global.log("[" + UUID + "] Launched via gtk-launch: " + app);
            } catch (e) {
                // Continue to next method
            }
        }
        
        // Method 3: Try direct command with lowercase
        if (!launched) {
            try {
                Util.spawn_command_line_async(app.toLowerCase());
                launched = true;
                global.log("[" + UUID + "] Launched via command line: " + app);
            } catch (e) {
                // Continue to next method
            }
        }
        
        // Method 4: Try with common name variations
        if (!launched) {
            let commonNames = {
                'Code': 'code',
                'Brave-browser': 'brave-browser',
                'firefox': 'firefox',
                'Terminator': 'terminator',
                'Nemo': 'nemo',
                'org.Nemo': 'nemo',
                'Xlet-settings.py': 'cinnamon-settings'
            };
            
            let cmdName = commonNames[app];
            if (cmdName) {
                try {
                    Util.spawn_command_line_async(cmdName);
                    launched = true;
                    global.log("[" + UUID + "] Launched via name mapping: " + cmdName);
                } catch (e) {
                    // Continue
                }
            }
        }
        
        // Method 5: Try spawn_async
        if (!launched) {
            try {
                Util.spawn_async([app.toLowerCase()], null);
                launched = true;
                global.log("[" + UUID + "] Launched via spawn_async: " + app);
            } catch (e) {
                // Final attempt failed
            }
        }
        
        return launched;
    },
    
    _positionWindows: function(sessionData) {
        let positionedCount = 0;
        
        global.log("[" + UUID + "] Attempting to position " + sessionData.windows.length + " windows");
        
        for (let windowData of sessionData.windows) {
            let windows = global.get_window_actors();
            let windowFound = false;
            
            for (let windowActor of windows) {
                let window = windowActor.get_meta_window();
                if (!window) continue;
                
                // Try multiple matching strategies
                let app = window.get_gtk_application_id() || 
                         window.get_wm_class() || 
                         window.get_wm_class_instance();
                
                let titleMatch = window.get_title() === windowData.title;
                let appMatch = app === windowData.app;
                let wmClassMatch = window.get_wm_class() === windowData.wmClass;
                let wmInstanceMatch = window.get_wm_class_instance() === windowData.wmClassInstance;
                
                // Match based on app and either title or WM class
                if (appMatch && (titleMatch || wmClassMatch || wmInstanceMatch)) {
                    try {
                        global.log("[" + UUID + "] Positioning window: " + windowData.app + " -> " + windowData.title);
                        
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
                        windowFound = true;
                        break;
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