# Changelog

All notable changes to the Save Cinnamon Session extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2025-11-08

### Added
- ✅ **NEW** - Dynamic exclusion management with automatic session cleanup
- ✅ **NEW** - Custom application mappings for applications that fail to restore
- ✅ **NEW** - Automatic cleanup script creation at `~/.local/bin/cleanup-session-files.sh`
- ✅ **NEW** - Enhanced session tracking file management (keeps only 5 newest files)
- ✅ **NEW** - Multiple logout/login detection methods for maximum reliability
- ✅ **NEW** - Automatic systemd user service creation for logout detection
- ✅ **NEW** - Automatic autostart entry creation for login marker detection
- ✅ **NEW** - Session file cleanup to prevent home directory accumulation
- ✅ **NEW** - Comprehensive application launch fallback system
- ✅ **NEW** - Enhanced debugging and logging capabilities
- ✅ **NEW** - Custom mapping parser with robust error handling
- ✅ **NEW** - Priority-based application launch system (custom > built-in > fallback)

### Enhanced
- 🔧 **IMPROVED** - Session saving now automatically removes excluded apps from existing sessions
- 🔧 **IMPROVED** - Application launching with custom mapping priority override
- 🔧 **IMPROVED** - More robust session detection and restoration timing
- 🔧 **IMPROVED** - Better error handling and user feedback through notifications
- 🔧 **IMPROVED** - Settings tooltips with discovery commands and detailed usage examples
- 🔧 **IMPROVED** - Extension initialization creates all necessary helper files automatically
- 🔧 **IMPROVED** - Session restoration with multiple timing attempts for reliability
- 🔧 **IMPROVED** - Application identification with comprehensive matching methods

### Technical Features
- 🎯 **CORE** - Auto-creation of all helper scripts and configuration files during extension enable
- 🎯 **CORE** - Custom application mapping parser with format validation and error recovery
- 🎯 **CORE** - Dynamic exclusion change detection with real-time session modification
- 🎯 **CORE** - Session tracking file lifecycle management with automatic cleanup
- 🎯 **CORE** - Multiple redundant session detection mechanisms (signals, systemd, autostart, polling)
- 🎯 **CORE** - Enhanced application launch system with flatpak, desktop file, and direct executable support
- 🎯 **CORE** - Comprehensive logging system for troubleshooting and debugging

### Settings & Configuration
- ⚙️ **SETTINGS** - Custom application mappings entry field with comprehensive tooltip
- ⚙️ **SETTINGS** - Enhanced excluded applications tooltip with usage examples
- ⚙️ **SETTINGS** - Real-time exclusion change detection and session cleanup
- ⚙️ **SETTINGS** - Settings validation and error handling
- ⚙️ **SETTINGS** - Dynamic settings binding with automatic updates

### File Management
- 📁 **FILES** - Automatic creation of `~/.local/bin/cleanup-session-files.sh` with full functionality
- 📁 **FILES** - Automatic creation of `~/.config/autostart/cinnamon-session-restore.desktop`
- 📁 **FILES** - Automatic creation of `~/.config/systemd/user/cinnamon-session-save.service`
- 📁 **FILES** - Session tracking files (`~/.cinnamon-session-running-*`) with automatic cleanup
- 📁 **FILES** - Login marker file (`~/.cinnamon-session-login-marker`) for restoration detection
- 📁 **FILES** - Logout trigger file (`~/.cinnamon-logout-trigger`) for session save detection

### Custom Application Mappings
- 🔗 **MAPPINGS** - Support for basic application commands: `MyApp:myapp`
- 🔗 **MAPPINGS** - Support for full path executables: `MyTool:/usr/local/bin/mytool`
- 🔗 **MAPPINGS** - Support for flatpak applications: `com.example.App:flatpak run com.example.App`
- 🔗 **MAPPINGS** - Support for applications with arguments: `MyEditor:myeditor --workspace`
- 🔗 **MAPPINGS** - Priority override system (custom mappings override built-in mappings)
- 🔗 **MAPPINGS** - Comprehensive error handling for malformed entries
- 🔗 **MAPPINGS** - Real-time parsing and application without extension restart

### Session Management Enhancements
- 💾 **SESSION** - Dynamic exclusion detection with automatic session file modification
- 💾 **SESSION** - Enhanced session data validation and error recovery
- 💾 **SESSION** - Improved window identification and matching algorithms
- 💾 **SESSION** - Better handling of edge-case applications and window types
- 💾 **SESSION** - Enhanced workspace preservation and restoration logic
- 💾 **SESSION** - Automatic session age validation (skips sessions older than 24 hours)

### Verified Working
- ✅ Dynamic exclusion removes apps from saved sessions immediately
- ✅ Custom mappings launch problematic applications successfully
- ✅ Cleanup script automatically created and functional on extension enable
- ✅ All helper files created automatically during installation
- ✅ Session tracking files properly managed and cleaned up
- ✅ Multiple detection methods ensure reliable logout/login handling
- ✅ Custom mapping parser handles various command formats correctly
- ✅ Extension validation passes all spice testing requirements

## [1.0.0] - 2025-11-04

### Added
- ✅ **NEW** - Automatic session saving on logout/shutdown
- ✅ **NEW** - Automatic session restoration on login
- ✅ **NEW** - Window position and size preservation across sessions
- ✅ **NEW** - Workspace assignment restoration and active workspace switching
- ✅ **NEW** - Application launching and intelligent window positioning
- ✅ **NEW** - Configurable restore delay to ensure desktop stability
- ✅ **NEW** - Application exclusion list for system and unwanted applications
- ✅ **NEW** - Manual save/restore keyboard shortcuts (Super+Shift+S/R)
- ✅ **NEW** - Maximized and minimized window state preservation
- ✅ **NEW** - Multi-workspace support with full workspace context
- ✅ **NEW** - Session data persistence via JSON file in home directory
- ✅ **NEW** - Comprehensive settings panel with real-time configuration
- ✅ **NEW** - Smart application identification and matching
- ✅ **NEW** - Session timestamp tracking and validation

### Technical Features
- 🎯 **CORE** - Uses native Cinnamon APIs for window management (`global.get_window_actors()`)
- 🎯 **CORE** - Implements proper extension lifecycle (init, enable, disable)
- 🎯 **CORE** - Robust session data collection and serialization
- 🎯 **CORE** - Smart application launching with fallback methods
- 🎯 **CORE** - Window positioning with timing considerations
- 🎯 **CORE** - Signal management for session events
- 🎯 **CORE** - Memory efficient with automatic cleanup
- 🎯 **CORE** - Compatible with Cinnamon 4.0 through 6.2
- 🎯 **CORE** - Follows Cinnamon extension development best practices
- 🎯 **CORE** - Comprehensive error handling and logging

### Settings & Configuration
- ⚙️ **SETTINGS** - Auto-save session on logout/shutdown toggle
- ⚙️ **SETTINGS** - Auto-restore session on login toggle
- ⚙️ **SETTINGS** - Configurable restore delay (1-30 seconds)
- ⚙️ **SETTINGS** - Excluded applications text field with comma separation
- ⚙️ **SETTINGS** - Manual save session keybinding
- ⚙️ **SETTINGS** - Manual restore session keybinding
- ⚙️ **SETTINGS** - Real-time settings updates without restart
- ⚙️ **SETTINGS** - Descriptive tooltips for all configuration options

### Session Management
- 💾 **SESSION** - Window geometry capture (position, size, monitor)
- 💾 **SESSION** - Window state preservation (maximized, minimized, focused)
- 💾 **SESSION** - Application identification via GTK app ID and WM class
- 💾 **SESSION** - Workspace index tracking and assignment
- 💾 **SESSION** - Current workspace preservation and restoration
- 💾 **SESSION** - Session timestamp for validation and debugging
- 💾 **SESSION** - Excluded application filtering during save/restore
- 💾 **SESSION** - JSON-based session data format for readability

### Verified Working
- ✅ Session saving captures all window states and positions accurately
- ✅ Session restoration launches applications and positions windows correctly
- ✅ Workspace assignments are preserved and restored properly
- ✅ Manual save/restore keyboard shortcuts function immediately
- ✅ Settings panel allows real-time configuration changes
- ✅ Application exclusion list filters unwanted applications effectively
- ✅ Restore delay prevents timing issues with slow-loading applications
- ✅ Maximized and minimized states are preserved across sessions
- ✅ Multi-monitor setups maintain window positions correctly
- ✅ Extension cleanup properly removes all signals and timeouts

### Documentation
- 📖 **DOCS** - Comprehensive README with installation and usage instructions
- 📖 **DOCS** - Detailed feature descriptions and technical implementation notes
- 📖 **DOCS** - Troubleshooting guide with common issues and solutions
- 📖 **DOCS** - Settings explanation with tooltips and descriptions
- 📖 **DOCS** - Session data format documentation
- 📖 **DOCS** - Privacy and data handling information
- 📖 **DOCS** - Limitations and known issues documentation