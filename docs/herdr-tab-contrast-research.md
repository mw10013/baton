# Herdr Tab Contrast Research

## Problem

In Herdr running inside Ghostty on macOS, inactive Herdr tabs are difficult to read. The active tab is visibly highlighted, while inactive tabs have a dark background and dim labels. This is a Herdr UI styling issue, not Ghostty's native tab bar.

The relevant UI is the row containing tabs `1`, `2`, `3`, `4`, `5`, and `+` at the top of the Herdr workspace. Ghostty is only the host terminal.

## Current Herdr Styling

Herdr's tab renderer currently uses these palette tokens:

- Active tab: `accent` background with a contrasting foreground.
- Inactive named tab: `surface0` background with `overlay1` foreground.
- Inactive auto-numbered tab: `surface0` background with `overlay0` foreground and the terminal `DIM` modifier.
- Tab bar: `panel_bg` background.

Auto-numbered inactive tabs are therefore intentionally more subdued than named tabs. There is currently no user configuration option to disable that `DIM` modifier independently.

## Configuration File

Herdr's per-user configuration file is:

```text
~/.config/herdr/config.toml
```

It did not exist in the user's setup. Create it with:

```bash
mkdir -p ~/.config/herdr
touch ~/.config/herdr/config.toml
```

The file can then be opened in an editor, for example:

```bash
open -a TextEdit ~/.config/herdr/config.toml
```

Restart Herdr after changing the file.

## Suggested First Configuration

This makes inactive tabs brighter without changing the overall theme:

```toml
[theme.custom]
surface0 = "#303449"
overlay0 = "#cdd6f4"
overlay1 = "#f0f2ff"
```

Expected effect:

- `surface0` lifts the inactive tab background away from the tab-bar background.
- `overlay0` makes auto-numbered inactive tabs more readable, although Herdr still applies `DIM`.
- `overlay1` improves contrast for manually named inactive tabs.

## Alternative Options

### Try another built-in theme

```toml
[theme]
name = "dracula"
```

Or:

```toml
[theme]
name = "nord"
```

Built-in themes change the entire Herdr palette, not only the tabs.

### Name tabs

Named tabs are rendered brighter and bold, unlike auto-numbered tabs. Rename tabs through Herdr's navigate controls, or make Herdr ask for a name when creating a tab:

```toml
[ui]
prompt_new_tab_name = true
```

### Stronger active-tab separation

The active tab currently uses `accent` as its background. This can also be adjusted:

```toml
[theme.custom]
accent = "#89b4fa"
```

This affects other Herdr highlights and navigation UI as well, so it is not an isolated tab-only setting.

## Limitation / Future Follow-Up

The ideal setting would expose dedicated inactive-tab colors and a switch for dimming auto-numbered tabs, for example:

```toml
[theme.custom]
tab_inactive_bg = "#303449"
tab_inactive_fg = "#cdd6f4"
tab_auto_named_dim = false
```

Those keys are illustrative only and are not currently supported. Herdr would need an upstream feature or local source change for that level of control.

## References

- Herdr configuration documentation: `https://github.com/herdrdev/herdr/blob/master/docs/versions/0.8.2/website/src/content/docs/configuration.mdx`
- Herdr tab renderer: `https://github.com/herdrdev/herdr/blob/master/src/ui/tabs.rs`
- Herdr configuration model: `https://github.com/herdrdev/herdr/blob/master/src/config/model.rs`

## Next Session Checklist

- Create `~/.config/herdr/config.toml` if it is still absent.
- Apply the suggested `[theme.custom]` overrides.
- Restart Herdr and compare inactive tab readability.
- If still insufficient, try a built-in theme or rename tabs.
- Revisit whether Herdr should gain dedicated tab color and dimming settings.
