import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Model from './lib/model.js';

// The Omarchy plugin's options that make sense on GNOME: Activities, Look
// and Weather.

const MODULES = [
    ['media', 'Media players', 'One card per player, with its controls'],
    ['recording', 'Screen recording', 'While recording, and the video just saved'],
    ['privacy', 'Camera and microphone', 'Which apps are using them'],
    ['modes', 'Modes', 'Do Not Disturb and night light, while they are on'],
    ['charging', 'Battery', 'Charging, and low battery'],
    ['screenshot', 'Screenshots', 'The screenshot just taken'],
    ['weather', 'Weather', 'From GNOME Weather; shown when nothing else is going on'],
    ['push', 'Scripts', 'Activities sent over D-Bus (the Push method)'],
];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, min, max, subtitle = '') {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1, page_increment: 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// A choice between a few string values.
function comboRow(settings, key, title, choices, subtitle = '') {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(choices.map(c => c[1]))});
    const sync = () => {
        const i = choices.findIndex(c => c[0] === settings.get_string(key));
        row.selected = Math.max(0, i);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
    return row;
}

// The players around now (from the session bus) and the ones already
// hidden, each with a switch. A hidden player stays out of the Now Bar but
// still answers the media keys.
function playersGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Players',
        description: 'Players playing now or hidden before. A hidden one still answers the media keys.',
    });
    const rows = new Map();
    const addRow = name => {
        const key = name.toLowerCase();
        if (rows.has(key))
            return;
        const row = new Adw.SwitchRow({title: name});
        const sync = () => {
            row.active = !Model.parseIgnoredPlayers(settings.get_string('media-ignore')).includes(key);
        };
        sync();
        settings.connect('changed::media-ignore', sync);
        row.connect('notify::active', () => {
            const next = Model.toggleIgnoredPlayer(settings.get_string('media-ignore'), name, !row.active);
            if (next !== settings.get_string('media-ignore'))
                settings.set_string('media-ignore', next);
        });
        rows.set(key, row);
        group.add(row);
    };
    for (const name of Model.parseIgnoredPlayers(settings.get_string('media-ignore')))
        addRow(name);

    // Each MPRIS player's own name (Identity), the one the Now Bar matches.
    const bus = Gio.DBus.session;
    bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
        null, null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
            let names = [];
            try {
                [names] = conn.call_finish(res).deepUnpack();
            } catch {
                return;
            }
            for (const busName of names.filter(n => n.startsWith('org.mpris.MediaPlayer2.') && !/playerctld/i.test(n))) {
                bus.call(busName, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Get',
                    new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2', 'Identity']), null,
                    Gio.DBusCallFlags.NONE, 1000, null, (c, r) => {
                        try {
                            const name = Model.clean(c.call_finish(r).deepUnpack()[0].unpack(), 60);
                            if (name)
                                addRow(name);
                        } catch {}
                    });
            }
        });

    const add = new Adw.EntryRow({title: 'Hide another player by name', show_apply_button: true});
    add.connect('apply', () => {
        const name = Model.clean(add.text, 60);
        if (!name)
            return;
        settings.set_string('media-ignore', Model.toggleIgnoredPlayer(settings.get_string('media-ignore'), name, true));
        addRow(name);
        add.text = '';
    });
    group.add(add);
    return group;
}

export default class NowbarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(640, 720);

        // --- Activities
        const activities = new Adw.PreferencesPage({title: 'Activities', icon_name: 'view-reveal-symbolic'});
        const shown = new Adw.PreferencesGroup({title: 'Show in the Now Bar'});
        for (const [id, title, subtitle] of MODULES)
            shown.add(switchRow(s, `module-${id}`, title, subtitle));
        activities.add(shown);
        const focus = new Adw.PreferencesGroup({title: 'Behavior'});
        focus.add(switchRow(s, 'auto-focus', 'New activities take the pill',
            'When they matter more than the one shown'));
        activities.add(focus);
        // media-paused-minutes is a number; a few fixed steps read better.
        const media2 = new Adw.PreferencesGroup({title: 'Media'});
        const steps = [[5, '5 minutes'], [15, '15 minutes'], [60, '1 hour'], [0, 'Always']];
        const paused = new Adw.ComboRow({title: 'A paused player keeps the pill',
            model: Gtk.StringList.new(steps.map(x => x[1]))});
        const syncPaused = () => {
            const i = steps.findIndex(x => x[0] === s.get_int('media-paused-minutes'));
            paused.selected = i >= 0 ? i : 1;
        };
        syncPaused();
        s.connect('changed::media-paused-minutes', syncPaused);
        paused.connect('notify::selected', () => s.set_int('media-paused-minutes', steps[paused.selected][0]));
        media2.add(paused);
        activities.add(media2);
        activities.add(playersGroup(s));
        window.add(activities);

        // --- Look
        const look = new Adw.PreferencesPage({title: 'Look', icon_name: 'applications-graphics-symbolic'});
        const place = new Adw.PreferencesGroup({title: 'Place'});
        place.add(comboRow(s, 'panel-box', 'Part of the top bar',
            [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]));
        place.add(spinRow(s, 'panel-index', 'Position', 0, 20, '0 is the first'));
        look.add(place);
        const pill = new Adw.PreferencesGroup({title: 'Pill'});
        pill.add(comboRow(s, 'pill-width', 'Width', [['fixed', 'Fixed'], ['fit', 'Fit the text, up to the width']]));
        pill.add(spinRow(s, 'max-width', 'Text width (px)', 80, 600));
        pill.add(comboRow(s, 'when-empty', 'When nothing is going on',
            [['brief', 'Show the weather'], ['icon', 'An empty pill'], ['hide', 'Hide the pill']]));
        pill.add(switchRow(s, 'show-count', 'Position marker (2/4)'));
        pill.add(switchRow(s, 'cover-accent', 'Colors from the album cover and the sky'));
        pill.add(switchRow(s, 'animations', 'Animations'));
        look.add(pill);
        const lock = new Adw.PreferencesGroup({title: 'Lock screen'});
        lock.add(switchRow(s, 'lock-screen', 'Show the pill on the lock screen',
            'At the top; a click opens the cards. Anything that would open an app stays off until you unlock'));
        look.add(lock);
        window.add(look);

        // --- Weather
        const weather = new Adw.PreferencesPage({title: 'Weather', icon_name: 'weather-few-clouds-symbolic'});
        const wg = new Adw.PreferencesGroup({
            title: 'Weather',
            description: 'The weather comes from GNOME (the same as the calendar menu): the place is the one ' +
                'picked in the GNOME Weather app, or its automatic location.',
        });
        wg.add(comboRow(s, 'weather-unit', 'Temperature',
            [['auto', 'As GNOME Weather'], ['metric', '°C'], ['imperial', '°F']]));
        const app = GioUnix.DesktopAppInfo.new('org.gnome.Weather.desktop');
        const placeRow = new Adw.ActionRow({
            title: 'Place',
            subtitle: app ? 'Pick it in GNOME Weather' : 'Install GNOME Weather (gnome-weather) to pick a place',
        });
        if (app) {
            const open = new Gtk.Button({label: 'Open GNOME Weather', valign: Gtk.Align.CENTER});
            open.connect('clicked', () => app.launch([], null));
            placeRow.add_suffix(open);
        }
        wg.add(placeRow);
        weather.add(wg);
        window.add(weather);
    }
}
