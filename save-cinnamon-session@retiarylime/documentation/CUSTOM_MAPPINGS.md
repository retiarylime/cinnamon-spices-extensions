# Custom Application Mappings

## 📖 What It Does

The Save Cinnamon Session extension can automatically restore most applications, but some apps may fail to launch. Custom mappings let you specify exactly how to launch these problematic applications.

## 🚀 Quick Setup

1. **Open Extension Settings**: Cinnamon Settings → Extensions → Save Cinnamon Session
2. **Find "Custom application mappings"** in the Application Settings section
3. **Enter your mappings** using this format: `AppName:command`
4. **Save settings** - your mappings are now active

## 📝 Format

```
AppName:command,AnotherApp:another-command
```

**Rules:**
- Use `:` to separate app name from command
- Use `,` to separate multiple mappings
- Use exact app names as they appear in sessions
- Commands can include full paths and arguments

## 📋 Examples

### Simple Applications
```
MyApp:myapp
Calculator:gnome-calculator
```

### Flatpak Applications
```
com.spotify.Client:flatpak run com.spotify.Client
org.gimp.GIMP:flatpak run org.gimp.GIMP
```

### Applications with Arguments
```
Code:/usr/bin/code --new-window
MyEditor:myeditor --workspace ~/projects
```

### Full Example (Multiple Apps)
```
MyCustomIDE:flatpak run com.example.IDE,Calculator:gnome-calculator,MyTool:/opt/mytool/bin/mytool --config ~/.mytool.conf
```

## 🔍 Finding App Names

### Method 1: Check Your Session File
```bash
cat ~/.cinnamon-session-save.json | grep '"app"'
```

### Method 2: Use the Discovery Command
Run this command and look for your application:
```bash
wmctrl -l | awk '{for(i=4;i<=NF;i++) printf "%s ", $i; print ""}'
```

### Method 3: Check Extension Logs
Enable debug mode in settings, then check logs:
```bash
tail -f ~/.xsession-errors | grep "save-cinnamon-session"
```

Look for lines like: `Examining window - gtk_app_id: 'MyApp'`

## ⚙️ How It Works

When restoring your session, the extension tries to launch each application using:

1. **Your custom mappings** (highest priority) ⭐
2. Built-in mappings (Code, Firefox, etc.)
3. Desktop file launching
4. System app database
5. Direct executable search

**Your custom mappings always override built-in commands!**

## 🔧 Troubleshooting

### App Not Launching?
1. **Check the app name** - must match exactly what's in your session
2. **Test the command** - run it manually in terminal first
3. **Check the path** - use full paths if needed (`/usr/bin/myapp`)
4. **Look at logs** - enable debug mode for detailed information

### Common Fixes
| Problem | Solution |
|---------|----------|
| App name typo | Copy exact name from session file |
| Command not found | Use full path: `/usr/bin/myapp` |
| Flatpak won't launch | Use: `flatpak run com.app.Name` |
| Complex launch | Include all args: `myapp --flag value` |

## 📊 Examples by App Type

### Standard Applications
```
Terminator:terminator
Gedit:gedit
Calculator:gnome-calculator
```

### Flatpak Applications
```
com.discordapp.Discord:flatpak run com.discordapp.Discord
com.slack.Slack:flatpak run com.slack.Slack
com.spotify.Client:flatpak run com.spotify.Client
```

### Development Tools
```
Code:/usr/bin/code --new-window
IntelliJ:/opt/idea/bin/idea.sh
Android Studio:/opt/android-studio/bin/studio.sh
```

### System Override Examples
```
firefox:/usr/bin/firefox --new-window
Nemo:nemo --new-window
```

## ✅ Testing Your Mappings

1. **Open the problematic application**
2. **Save session** (Super+Shift+S by default)
3. **Close the application** 
4. **Add your custom mapping** in settings
5. **Test restore** (Super+Shift+R by default)
6. **Check if it launches** correctly

## 🎯 Success Tips

- **Start simple**: Test with basic commands first
- **Use full paths**: More reliable than relying on PATH
- **Check logs**: Enable debug mode for troubleshooting
- **Test manually**: Always verify commands work in terminal
- **One at a time**: Add mappings gradually to isolate issues

## 📚 Advanced Usage

### Conditional Commands
```
MyApp:/usr/bin/myapp --config ~/.myapp.conf --theme dark
GameLauncher:steam -applaunch 12345
```

### Environment Variables
```
MyApp:env CUSTOM_VAR=value /usr/bin/myapp
```

### Scripts
```
MyComplexApp:/home/user/scripts/launch-myapp.sh
```

This feature ensures virtually any application can be restored, regardless of how it's installed or configured!