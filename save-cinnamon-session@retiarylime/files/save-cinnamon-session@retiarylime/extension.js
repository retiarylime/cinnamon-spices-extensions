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

let extension = null;

function SaveCinnamonSessionExtension() {
    this._init();
}

SaveCinnamonSessionExtension.prototype = {
    
    _init: function() {
        this._signals = new SignalManager.SignalManager(null);
        this._saveTimeout = null;
        this._restoreTimeout = null;
        this._sessionFile = GLib.get_home_dir() + "/.cinnamon-session-save.json";
        
        // Set default values first
        this.autoSaveOnLogout = true;
        this.autoRestoreOnLogin = true;
        this.restoreDelay = 3000; // 3 seconds delay before restoring
        this.excludedApps = "cinnamon-settings,cinnamon-killer-daemon,nemo-desktop";
        this.manualSaveKeybinding = "<Super><Shift>s";
        this.manualRestoreKeybinding = "<Super><Shift>r";
        
        // Settings - try to bind with error handling
        try {
            this.settings = new Settings.ExtensionSettings(this, UUID);
            this.settings.bind("auto-save-logout", "autoSaveOnLogout", this._onSettingsChanged);
            this.settings.bind("auto-restore-login", "autoRestoreOnLogin", this._onSettingsChanged);
            this.settings.bind("restore-delay", "restoreDelay", this._onSettingsChanged);
            this.settings.bind("excluded-apps", "excludedApps", this._onSettingsChanged);
            this.settings.bind("manual-save-keybinding", "manualSaveKeybinding", this._onKeybindingChanged);
            this.settings.bind("manual-restore-keybinding", "manualRestoreKeybinding", this._onKeybindingChanged);
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
        
        // Auto-restore session if enabled and session file exists
        if (this.autoRestoreOnLogin && GLib.file_test(this._sessionFile, GLib.FileTest.EXISTS)) {
            this._scheduleRestore();
        }
    },
    
    disable: function() {
        global.log("[" + UUID + "] Disabling extension");
        
        // Save session on disable if auto-save is enabled
        if (this.autoSaveOnLogout) {
            this._saveSession();
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
        // Connect to Cinnamon's session manager signals
        try {
            // Monitor for session end signals
            this._signals.connect(Main.sessionMode, 'updated', this._onSessionModeChanged, this);
            
            // Monitor for application quit events that might indicate logout
            this._signals.connect(global.display, 'window-created', this._onWindowCreated, this);
            
            global.log("[" + UUID + "] Connected to session signals");
        } catch (e) {
            global.log("[" + UUID + "] Failed to connect session signals: " + e);
        }
    },
    
    _onSessionModeChanged: function() {
        // Save session when session mode changes (could indicate logout)
        if (this.autoSaveOnLogout) {
            global.log("[" + UUID + "] Session mode changed, scheduling save");
            this._scheduleSave();
        }
    },
    
    _onWindowCreated: function(display, window) {
        // Track window creation for session management
        // This could be used to monitor application startup during restore
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
            stream.write(jsonData, null);
            stream.close(null);
            
            global.log("[" + UUID + "] Session saved successfully to " + this._sessionFile);
            global.log("[" + UUID + "] Saved " + sessionData.windows.length + " windows across " + 
                       Object.keys(sessionData.workspaces).length + " workspaces");
        } catch (e) {
            global.logError("[" + UUID + "] Failed to save session: " + e);
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
        
        for (let windowActor of windows) {
            let window = windowActor.get_meta_window();
            if (!window || window.is_skip_taskbar()) continue;
            
            let app = window.get_gtk_application_id() || window.get_wm_class();
            if (!app) continue;
            
            // Skip excluded applications
            if (excludedAppsArray.some(excluded => app.toLowerCase().includes(excluded))) {
                continue;
            }
            
            let frame = window.get_frame_rect();
            let workspaceIndex = window.get_workspace().index();
            
            let windowData = {
                app: app,
                title: window.get_title(),
                x: frame.x,
                y: frame.y,
                width: frame.width,
                height: frame.height,
                workspace: workspaceIndex,
                maximized: window.get_maximized(),
                minimized: window.minimized,
                monitor: window.get_monitor()
            };
            
            sessionData.windows.push(windowData);
            
            // Track workspace usage
            if (!sessionData.workspaces[workspaceIndex]) {
                sessionData.workspaces[workspaceIndex] = {
                    name: window.get_workspace().get_display_name(),
                    windowCount: 0
                };
            }
            sessionData.workspaces[workspaceIndex].windowCount++;
        }
        
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
            
            global.log("[" + UUID + "] Restoring session from " + new Date(sessionData.timestamp));
            global.log("[" + UUID + "] Restoring " + sessionData.windows.length + " windows");
            
            // Restore applications and windows
            this._restoreApplications(sessionData);
            
        } catch (e) {
            global.logError("[" + UUID + "] Failed to restore session: " + e);
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
        
        // Launch applications
        for (let app in appWindows) {
            if (restoredApps.has(app)) continue;
            
            try {
                // Try to launch the application
                Util.spawn_async([app], null);
                restoredApps.add(app);
                global.log("[" + UUID + "] Launched application: " + app);
            } catch (e) {
                // Try alternative launch methods
                try {
                    Util.spawn_command_line_async(app);
                    restoredApps.add(app);
                    global.log("[" + UUID + "] Launched application (alternative): " + app);
                } catch (e2) {
                    global.log("[" + UUID + "] Failed to launch application: " + app + " - " + e2);
                }
            }
        }
        
        // Schedule window positioning after applications have time to start
        Mainloop.timeout_add(5000, () => { // 5 seconds delay
            this._positionWindows(sessionData);
            return false;
        });
    },
    
    _positionWindows: function(sessionData) {
        let positionedCount = 0;
        
        for (let windowData of sessionData.windows) {
            let windows = global.get_window_actors();
            
            for (let windowActor of windows) {
                let window = windowActor.get_meta_window();
                if (!window) continue;
                
                let app = window.get_gtk_application_id() || window.get_wm_class();
                if (app === windowData.app && window.get_title() === windowData.title) {
                    try {
                        // Move to correct workspace
                        let workspace = global.workspace_manager.get_workspace_by_index(windowData.workspace);
                        if (workspace) {
                            window.change_workspace(workspace);
                        }
                        
                        // Position and size the window
                        if (windowData.maximized) {
                            window.maximize(Meta.MaximizeFlags.BOTH);
                        } else {
                            window.unmaximize(Meta.MaximizeFlags.BOTH);
                            window.move_resize_frame(false, windowData.x, windowData.y, 
                                                   windowData.width, windowData.height);
                        }
                        
                        if (windowData.minimized) {
                            window.minimize();
                        }
                        
                        positionedCount++;
                        break;
                    } catch (e) {
                        global.log("[" + UUID + "] Failed to position window: " + windowData.title + " - " + e);
                    }
                }
            }
        }
        
        global.log("[" + UUID + "] Positioned " + positionedCount + " windows");
        
        // Restore active workspace
        if (sessionData.currentWorkspace !== undefined) {
            let workspace = global.workspace_manager.get_workspace_by_index(sessionData.currentWorkspace);
            if (workspace) {
                workspace.activate(global.get_current_time());
            }
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