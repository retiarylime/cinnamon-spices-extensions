# Custom Application Mappings Feature

## Overview

The Save Cinnamon Session extension now supports custom application mappings for applications that fail to restore automatically. This feature allows users to manually specify launch commands for applications that don't exist in the built-in mapping or fail with the fallback methods.

## How to Use

1. **Open Extension Settings**: Go to Cinnamon Settings → Extensions → Save Cinnamon Session
2. **Find Custom Application Mappings**: Look for the "Custom application mappings" field in the Application Settings section
3. **Add Mappings**: Enter mappings in the format: `AppName:command,AnotherApp:another-command`

## Format

```
AppName:command,AnotherApp:another-command
```

**Important Notes:**
- Use **exact** application names as they appear in the session file
- Separate multiple mappings with commas
- Use colon (`:`) to separate app name from command
- Commands can include full paths, arguments, and flatpak commands

## Examples

### Basic Examples
```
MyCustomApp:mycustomapp
SomeUtility:/usr/local/bin/someutility
```

### Flatpak Applications
```
com.example.MyApp:flatpak run com.example.MyApp
org.mydomain.Tool:flatpak run org.mydomain.Tool
```

### Applications with Arguments
```
MyEditor:myeditor --workspace
CustomBrowser:mybrowser --new-window
```

### Complex Example
```
CustomIDE:flatpak run com.example.IDE,MyTool:/opt/mytool/bin/mytool --config /home/user/.mytool.conf,LocalApp:localapp
```

## How It Works

1. **Session Save**: Applications are saved with their identifiers (GTK App ID, WM Class, etc.)
2. **Session Restore**: Extension tries to launch applications using:
   - Built-in mappings (Code, Firefox, etc.)
   - **Custom mappings (your entries)** - **Higher Priority**
   - Desktop file launching
   - Cinnamon app system
   - Direct executable lookup
3. **Custom Priority**: Custom mappings override built-in mappings for the same application

## Finding Application Names

To find the correct application name to use in mappings:

### Method 1: Check Session File
```bash
cat ~/.cinnamon-session-save.json | jq '.windows[] | {app: .app, title: .title}'
```

### Method 2: Check Extension Logs
Look for lines like:
```
Examining window - gtk_app_id: 'com.example.app', wm_class: 'MyApp'
```

### Method 3: Use the App Name from Session
The most reliable identifier is usually the `app` field from the session data.

## Troubleshooting

### Application Not Launching
1. Check the application name is exactly as it appears in the session
2. Verify the command works when run manually in terminal
3. Check extension logs for error messages
4. Try using full path to executable

### Common Issues
- **Typo in app name**: Must match exactly what's saved in session
- **Invalid command**: Test command manually first
- **Missing executable**: Ensure application is installed and in PATH
- **Flatpak permissions**: Some flatpak apps may need additional permissions

## Testing

1. **Save a session** with the problematic application open
2. **Add custom mapping** for that application
3. **Test restore** using manual restore (Super+Shift+R by default)
4. **Check logs** to see if custom mapping was used

## Benefits

- **Handles edge cases**: Apps with unusual identifiers or launch methods
- **Supports any command**: Flatpak, AppImage, custom scripts, etc.
- **User control**: Override built-in mappings when needed
- **Flexible format**: Support for complex launch commands with arguments

This feature ensures that virtually any application can be properly restored, regardless of how it's packaged or installed.