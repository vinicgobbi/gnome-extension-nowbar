# Now Bar for GNOME

A Samsung-style **Now Bar** for the GNOME top bar, ported from
[omarchy-plugin-nowbar](https://github.com/vinicgobbi/omarchy-plugin-nowbar).
One pill shows what is going on right now (music, a screen recording, the camera in use, charging, the weather). Scroll over it to switch
between activities, and click it for the details and controls.

Everything comes from GNOME itself: MPRIS players, UPower and
power-profiles-daemon, the notification and night light settings, the shell's
own sound mixer, camera monitor, screenshot tool and weather (GNOME Weather).

## Activities

| Activity | Source |
| --- | --- |
| Media player: cover, seek bar, shuffle, previous, play/pause, next, repeat, 10 s back/forward on long media, volume | MPRIS (D-Bus) |
| Screen recording with elapsed time and Stop; then "Recording saved" with Play / Folder | GNOME's screenshot UI |
| Screenshot just taken: Open / Copy / Folder | GNOME's screenshot UI |
| Camera and/or microphone in use, which apps, mute the mic | `Shell.CameraMonitor`, the shell's mixer |
| Do Not Disturb and night light while on, with a button to turn them off | GNOME settings |
| Charging (with time until full); low battery with Power saver | UPower, power-profiles-daemon |
| Weather: now, next hours, 3 days; "Rain likely soon" | GNOME Weather (GWeather), like the calendar menu |
| Anything a script sends | `bin/nowbar push`, `bin/nowbar-run` |

Not ported (Omarchy only): reminders, dictation, the package updates card,
Bluetooth device cards and the media keys takeover (GNOME already handles
media keys).

## Install

```bash
make install
gnome-extensions enable nowbar@vinicgobbi.dev.br
```

On Wayland, log out and back in after the first install so the shell finds
the extension.

The popup follows the shell's light or dark style, and the pill adapts to a
light or dark top bar.

**Weather** uses GNOME's own weather, so the place is the one picked in the
GNOME Weather app (`sudo apt install gnome-weather`, or the Flathub app). With
no place picked there, there is no weather card.

## Usage

| Action | Effect |
| --- | --- |
| Left click | Open/close the popup |
| Scroll | Next / previous activity |
| Middle click | Main action (play/pause, stop the recording, mute the mic...) |
| Right click | Hide the activity until it changes; the eye in the popup brings it back |

Popup keys: ←/→ (h/l) switch, Enter main action, ↑/↓ volume and `[` / `]`
seek on a media card, `x` hide, `u` show hidden, `c` options, `q`/Esc close.

Switches like Do Not Disturb, night light or screen recording are left to
GNOME's Quick Settings; when one is on, the Now Bar shows it as an activity
(with a button to turn it off).

## Scripts and shortcuts

`bin/nowbar` and `bin/nowbar-run` live in this repository, not in the
installed extension (or the extensions.gnome.org zip): run them from a
checkout. `bin/nowbar` talks to the extension over D-Bus (`br.dev.vinicgobbi.NowBar`):

```bash
bin/nowbar next | prev | toggle | primary | dismiss | unhide | weather | settings
bin/nowbar focus media
bin/nowbar act media next
bin/nowbar push build '{"title":"Build #42","subtitle":"Compiling","progress":0.4,"pill":"Build 40%"}'
bin/nowbar remove build
bin/nowbar status
```

Push fields are the same as on Omarchy: `title` (required), `subtitle`,
`pill`, `icon`, `progress` (0–1), `ttl` (seconds), `priority`
(`high`/`normal`/`low`), `urgent`, `state` (`running`/`success`/`error`),
`elapsed`. Pushed activities are text only and gone after a restart.

`bin/nowbar-run` shows any command in the pill while it runs:

```bash
bin/nowbar-run -t "System update" -- sudo apt upgrade
```

For keyboard shortcuts, add custom shortcuts in Settings → Keyboard pointing
at e.g. `~/path/to/bin/nowbar toggle`.

## Development

- `lib/model.js` is generated from the Omarchy plugin's `NowbarModel.js`
  (`make sync-model`), so both share the same logic: edit it there.
- `make test` runs the model checks under GJS.
- `make nested` runs a GNOME Shell in a window with the extension installed.
- `make pack` builds the zip for extensions.gnome.org.

## License

MIT
