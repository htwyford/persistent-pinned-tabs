# Persistent Pinned Tabs

Arc-style pinned tabs for Firefox.

- **Your pinned tabs come back on every launch**, even if Firefox is set to start with a blank window instead of restoring your last session. Pins that aren't open get reopened, unloaded until you click them.
- **Closing a pinned tab resets it** to the URL you pinned instead of losing it, like Arc. Unpin a tab (right-click → Unpin Tab) to remove it for good. You can switch to Firefox's normal close behavior in the extension's settings.
- **Right-click a pinned tab** for *Reset to Pinned URL* and *Make This the Pinned URL*. You can assign a keyboard shortcut to the reset action in `about:addons` → ⚙︎ → Manage Extension Shortcuts.
- If you close your last window on macOS and open a new one, your pinned tabs come back.

Your pinned set and its order are stored locally in the extension. Nothing leaves your machine.

## How it works

The extension keeps a list of pins (URL, title, order). On startup it waits for Firefox's session restore to finish, then matches each pin to an open pinned tab by exact URL, then by site, then by position. Any pin that's left over gets reopened.

## Development

```bash
npx web-ext run      # launch a temporary Firefox profile with the extension
npx web-ext lint
```

## Signing

```bash
npx web-ext sign     # unlisted channel; needs WEB_EXT_API_KEY / WEB_EXT_API_SECRET
```

MIT licensed.
