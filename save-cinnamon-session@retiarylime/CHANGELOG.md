# Changelog

All notable changes to the Save Cinnamon Session extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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