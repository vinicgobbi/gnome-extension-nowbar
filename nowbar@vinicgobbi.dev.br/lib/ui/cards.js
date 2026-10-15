import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import * as Model from '../model.js';
import {iconFor} from '../icons.js';
import {Bar, button, hbox, imageStyle, label, vbox} from './widgets.js';

// The popup's cards, one kind per look: Card for most activities,
// MediaCard for a player, WeatherCard for the Now Brief. Each is built once
// for an activity and then `update(a)`d every second, so nothing under the
// pointer is rebuilt while it counts.
//
// `ctx` = {service, closeMenu()}

function actionsKey(a) {
    return a.actions.map(x => `${x.id}:${x.label}`).join('|');
}

// Runs an action from a card: windows opened by it come up over a closed
// popup.
function runAction(ctx, a, action) {
    if (action.opensApp)
        ctx.closeMenu();
    ctx.service.act(a.id, action.id);
}

export class Card {
    constructor(ctx, a) {
        this._ctx = ctx;
        this.actor = vbox({style_class: 'nowbar-card', x_expand: true});

        const head = hbox({style_class: 'nowbar-card-head'});
        this._iconBin = new St.Bin({style_class: 'nowbar-card-icon-bin', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'nowbar-card-icon'});
        this._iconBin.set_child(this._icon);
        head.add_child(this._iconBin);
        const texts = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = label('', 'nowbar-card-title');
        this._subtitle = label('', 'nowbar-card-subtitle');
        texts.add_child(this._title);
        texts.add_child(this._subtitle);
        head.add_child(texts);
        this.actor.add_child(head);

        this._image = new St.Widget({style_class: 'nowbar-card-image', x_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._image);
        this._bar = new Bar('nowbar-card-progress');
        this.actor.add_child(this._bar.actor);
        this._details = vbox({style_class: 'nowbar-card-details'});
        this.actor.add_child(this._details);
        this._actions = hbox({style_class: 'nowbar-card-actions', x_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._actions);
        this._actionsKey = null;
        this.update(a);
    }

    update(a) {
        this._icon.icon_name = iconFor(a.icon, a.module);
        this._iconBin.style = a.color ? `background-color: ${a.color};` : null;
        this.actor.remove_style_class_name('urgent');
        if (a.urgent)
            this.actor.add_style_class_name('urgent');
        this._title.text = a.title;
        this._subtitle.text = a.subtitle || '';
        this._subtitle.visible = !!a.subtitle;

        this._image.visible = !!a.image;
        if (a.image && this._imagePath !== a.image) {
            this._imagePath = a.image;
            this._image.style = imageStyle(a.image, 300, 168);
        }
        this._bar.set(a.progress, a.color, this._ctx.service.prefs.animations && this.actor.mapped);

        const details = a.details.join('\n');
        if (details !== this._detailsKey) {
            this._detailsKey = details;
            this._details.destroy_all_children();
            for (const d of a.details)
                this._details.add_child(label(d, 'nowbar-card-detail'));
        }
        this._details.visible = a.details.length > 0;

        const key = actionsKey(a);
        if (key !== this._actionsKey) {
            this._actionsKey = key;
            this._actions.destroy_all_children();
            a.actions.forEach((action, i) => {
                this._actions.add_child(button({
                    icon: iconFor(action.icon, a.module),
                    text: action.label,
                    styleClass: i === 0 ? 'primary' : '',
                    onClick: () => runAction(this._ctx, this._a, action),
                }));
            });
        }
        this._actions.visible = a.actions.length > 0;
        this._a = a;
    }

    destroy() {
        this.actor.destroy();
    }
}

// --- media -------------------------------------------------------------------

function seconds(s) {
    return Model.formatDuration(Math.max(0, s) * 1000);
}

// Black or white, whichever reads on `hex`.
function readableOn(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
    if (!m)
        return null;
    const [r, g, b] = [m[1], m[2], m[3]].map(x => parseInt(x, 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#1a1a1a' : '#ffffff';
}

// The card's background from the cover's base color: the same hue, toned
// down to sit behind the theme's text (dark or light), a bit deeper at the
// bottom.
function surfaceGradient(base) {
    const dark = Main.getStyleVariant() !== 'light';
    const top = Model.surfaceTint(base, dark);
    if (!top)
        return null;
    const m = /^#(..)(..)(..)$/.exec(top);
    const hsl = Model.rgbToHsl(...[m[1], m[2], m[3]].map(x => parseInt(x, 16) / 255));
    const bottom = Model.hslToHex(hsl.h, hsl.s * 0.7, dark ? hsl.l * 0.7 : Math.min(0.97, hsl.l + 0.04));
    return `background-gradient-direction: vertical; background-gradient-start: ${top};` +
        ` background-gradient-end: ${bottom};`;
}

// The app playing: its icon, from its desktop entry.
function appFor(entry) {
    if (!entry)
        return null;
    const apps = Shell.AppSystem.get_default();
    const id = entry.endsWith('.desktop') ? entry : `${entry}.desktop`;
    return apps.lookup_app(id) ?? apps.lookup_heuristic_basename(id) ?? null;
}

export class MediaCard {
    constructor(ctx, a) {
        this._ctx = ctx;
        this.actor = vbox({style_class: 'nowbar-card nowbar-media', x_expand: true});

        // Where the sound comes from; a click opens the player.
        this._source = new St.Button({style_class: 'nowbar-media-source', x_align: Clutter.ActorAlign.START,
            can_focus: true});
        const sourceBox = hbox({style_class: 'nowbar-media-source-box'});
        this._appIcon = new St.Icon({style_class: 'nowbar-media-app-icon', fallback_icon_name: 'audio-x-generic-symbolic'});
        this._sourceLabel = label('', 'nowbar-media-source-label');
        this._sourceOpen = new St.Icon({icon_name: 'go-next-symbolic', style_class: 'nowbar-media-source-open'});
        sourceBox.add_child(this._appIcon);
        sourceBox.add_child(this._sourceLabel);
        sourceBox.add_child(this._sourceOpen);
        this._source.set_child(sourceBox);
        this._source.connect('clicked', () => this._raise());
        this.actor.add_child(this._source);

        const head = hbox({style_class: 'nowbar-card-head nowbar-media-head'});
        this._head = head;
        this._cover = new St.Button({style_class: 'nowbar-cover', can_focus: true, accessible_name: 'Open player'});
        this._coverIcon = new St.Icon({icon_name: 'folder-music-symbolic', style_class: 'nowbar-cover-icon'});
        this._cover.set_child(this._coverIcon);
        this._cover.connect('clicked', () => this._raise());
        head.add_child(this._cover);
        const texts = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'nowbar-media-texts'});
        this._title = label('', 'nowbar-media-title');
        this._artist = label('', 'nowbar-media-artist');
        this._album = label('', 'nowbar-media-album');
        texts.add_child(this._title);
        texts.add_child(this._artist);
        texts.add_child(this._album);
        head.add_child(texts);
        this.actor.add_child(head);

        // Seek bar, with the elapsed and remaining time under its ends.
        this._seekBox = vbox({style_class: 'nowbar-seek-box'});
        this._seek = new Slider.Slider(0);
        this._seek.x_expand = true;
        this._seek.add_style_class_name('nowbar-slider');
        const times = hbox({style_class: 'nowbar-times'});
        this._elapsed = label('', 'nowbar-time', {x_expand: true});
        this._remaining = label('', 'nowbar-time');
        times.add_child(this._elapsed);
        times.add_child(this._remaining);
        this._seekBox.add_child(this._seek);
        this._seekBox.add_child(times);
        this.actor.add_child(this._seekBox);
        this._dragging = false;
        this._seek.connect('drag-begin', () => {
            this._dragging = true;
        });
        this._seek.connect('drag-end', () => {
            this._dragging = false;
            ctx.service.seek(this._a.id, this._seek.value);
        });
        this._seek.connect('scroll-event', () => {
            this._queueSeek();
            return Clutter.EVENT_PROPAGATE;
        });

        const controls = hbox({style_class: 'nowbar-media-controls', x_align: Clutter.ActorAlign.CENTER});
        const ctl = (icon, action, name, cls = '') => {
            // Centered, not stretched to the row's height: every one stays a circle.
            const b = button({icon, styleClass: `nowbar-round ${cls}`, accessibleName: name,
                onClick: () => ctx.service.act(this._a.id, action)});
            b.y_align = Clutter.ActorAlign.CENTER;
            controls.add_child(b);
            return b;
        };
        this._shuffle = ctl('media-playlist-shuffle-symbolic', 'shuffle', 'Shuffle', 'small');
        this._back = ctl('media-seek-backward-symbolic', 'back10', '10 seconds back', 'small');
        this._prev = ctl('media-skip-backward-symbolic', 'previous', 'Previous');
        this._play = ctl('media-playback-start-symbolic', 'playPause', 'Play or pause', 'big');
        this._next = ctl('media-skip-forward-symbolic', 'next', 'Next');
        this._forward = ctl('media-seek-forward-symbolic', 'forward10', '10 seconds forward', 'small');
        this._loop = ctl('media-playlist-repeat-symbolic', 'loop', 'Repeat', 'small');
        this.actor.add_child(controls);

        this._volumeRow = hbox({style_class: 'nowbar-volume-row'});
        this._volumeIcon = new St.Icon({icon_name: 'audio-volume-medium-symbolic', style_class: 'nowbar-volume-icon'});
        this._volumeRow.add_child(this._volumeIcon);
        this._volume = new Slider.Slider(0);
        this._volume.x_expand = true;
        this._volume.add_style_class_name('nowbar-slider');
        this._volumeRow.add_child(this._volume);
        // While the user moves it, and for a moment after, the player's own
        // value (which lags behind) doesn't pull the slider back.
        this._volumeHeldUntil = 0;
        this._volume.connect('drag-begin', () => {
            this._volumeDragging = true;
        });
        this._volume.connect('drag-end', () => {
            this._volumeDragging = false;
            this._volumeHeldUntil = Date.now() + 1500;
        });
        this._volume.connect('notify::value', () => {
            this._syncVolumeIcon(this._volume.value);
            if (this._settingVolume)
                return;
            this._volumeHeldUntil = Date.now() + 1500;
            ctx.service.setVolume(this._a.id, this._volume.value);
        });
        this.actor.add_child(this._volumeRow);
        this._styles = new Map();
        this.update(a);
    }

    _raise() {
        if (this._a?.canRaise) {
            this._ctx.closeMenu();
            this._ctx.service.act(this._a.id, 'raise');
        }
    }

    // Sets a style only when it changes (St relayouts on every set).
    _style(actor, style) {
        if (this._styles.get(actor) === style)
            return;
        this._styles.set(actor, style);
        actor.style = style;
    }

    _syncVolumeIcon(v) {
        this._volumeIcon.icon_name = v <= 0 ? 'audio-volume-muted-symbolic'
            : v < 0.34 ? 'audio-volume-low-symbolic'
                : v < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
    }

    _slideTrack() {
        const head = this._head;
        head.remove_transition('opacity');
        head.remove_transition('translation-x');
        head.opacity = 0;
        head.translation_x = 28;
        head.ease({opacity: 255, translation_x: 0, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _queueSeek() {
        if (this._seekTimeout)
            GLib.source_remove(this._seekTimeout);
        this._seekTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._seekTimeout = 0;
            this._ctx.service.seek(this._a.id, this._seek.value);
            return GLib.SOURCE_REMOVE;
        });
    }

    _has(a, id) {
        return a.actions.some(x => x.id === id);
    }

    // Present but faded when the player can't do it: the row keeps its
    // shape from one track (or player) to the next.
    _enable(btn, on) {
        btn.reactive = btn.can_focus = on;
        btn.opacity = on ? 255 : 90;
    }

    _setChecked(btn, on) {
        if (on)
            btn.add_style_pseudo_class('checked');
        else
            btn.remove_style_pseudo_class('checked');
    }

    update(a) {
        // A new track slides in.
        const track = `${a.title}\u0000${a.artist}`;
        if (this._track !== undefined && track !== this._track && this._ctx.service.prefs.animations)
            this._slideTrack();
        this._track = track;
        this._a = a;

        // Source: app icon and name.
        if (a.desktopEntry !== this._entry) {
            this._entry = a.desktopEntry;
            const app = appFor(a.desktopEntry);
            this._appIcon.gicon = app?.get_icon() ?? null;
        }
        this._sourceLabel.text = a.playerName || 'Media';
        this._sourceOpen.visible = !!a.canRaise;
        this._source.reactive = this._source.can_focus = this._source.track_hover = !!a.canRaise;
        this._source.accessible_name = a.canRaise ? `Open ${a.playerName || 'the player'}` : '';

        this._title.text = a.title;
        this._artist.text = a.artist || '';
        this._artist.visible = !!a.artist;
        this._album.text = a.album && a.album !== a.title ? a.album : '';
        this._album.visible = !!this._album.text;

        this._cover.reactive = this._cover.can_focus = this._cover.track_hover = !!a.canRaise;
        const path = a.art?.path ?? '';
        if (path !== this._coverPath) {
            this._coverPath = path;
            this._style(this._cover, path ? imageStyle(path, 96, 96, 16) : null);
            this._coverIcon.visible = !path;
        }
        // Paused: the cover rests a little.
        const coverOpacity = a.playing ? 255 : 165;
        if (this._coverOpacity !== coverOpacity) {
            this._coverOpacity = coverOpacity;
            this._cover.remove_transition('opacity');
            this._cover.ease({opacity: coverOpacity, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }

        // The cover's colors: card background, bars, play button, toggles.
        const accent = a.color ?? null;
        this._style(this.actor, a.surface ? surfaceGradient(a.surface) : null);
        const bar = accent ? `-barlevel-active-background-color: ${accent}; color: ${accent};` : null;
        this._style(this._seek, bar);
        this._style(this._volume, bar);
        this._style(this._play, accent ? `background-color: ${accent}; color: ${readableOn(accent)};` : null);
        const toggle = accent ? `color: ${accent};` : null;
        this._style(this._shuffle, a.shuffle ? toggle : null);
        this._style(this._loop, a.loop === 'track' || a.loop === 'playlist' ? toggle : null);

        this._seekBox.visible = a.length > 0;
        if (a.length > 0) {
            this._elapsed.text = seconds(a.position);
            this._remaining.text = `-${seconds(a.length - a.position)}`;
            this._seek.reactive = a.seekable;
            this._seek.opacity = a.seekable ? 255 : 110;
            if (!this._dragging && !this._seekTimeout)
                this._seek.value = a.position / a.length;
        }

        this._play.child.get_first_child().icon_name = a.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._play.accessible_name = a.playing ? 'Pause' : 'Play';
        this._enable(this._prev, this._has(a, 'previous'));
        this._enable(this._next, this._has(a, 'next'));
        this._back.visible = this._forward.visible = !!a.long;
        this._shuffle.visible = a.shuffle !== null;
        this._setChecked(this._shuffle, !!a.shuffle);
        this._loop.visible = !!a.loop;
        this._setChecked(this._loop, a.loop === 'track' || a.loop === 'playlist');
        this._loop.child.get_first_child().icon_name = a.loop === 'track'
            ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';

        this._volumeRow.visible = a.volume >= 0;
        if (a.volume >= 0 && !this._volumeDragging && Date.now() > this._volumeHeldUntil) {
            this._settingVolume = true;
            this._volume.value = a.volume;
            this._settingVolume = false;
            this._syncVolumeIcon(a.volume);
        }
    }

    // Keys in the popup: ↑/↓ volume, [ / ] seek.
    volumeBy(delta) {
        if (this._a.volume >= 0)
            this._ctx.service.setVolume(this._a.id, Math.max(0, Math.min(1, this._a.volume + delta)));
    }

    destroy() {
        if (this._seekTimeout)
            GLib.source_remove(this._seekTimeout);
        this.actor.destroy();
    }
}

// --- weather -------------------------------------------------------------------

export class WeatherCard {
    constructor(ctx, a) {
        this._ctx = ctx;
        this.actor = vbox({style_class: 'nowbar-card nowbar-weather', x_expand: true});

        const head = hbox({style_class: 'nowbar-card-head'});
        this._icon = new St.Icon({style_class: 'nowbar-weather-icon'});
        head.add_child(this._icon);
        const texts = vbox({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._temp = label('', 'nowbar-weather-temp');
        this._desc = label('', 'nowbar-card-subtitle');
        texts.add_child(this._temp);
        texts.add_child(this._desc);
        head.add_child(texts);
        const side = vbox({y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.END});
        // The place: a click opens GNOME Weather, where it is picked.
        this._place = button({icon: 'mark-location-symbolic', styleClass: 'flat nowbar-place',
            onClick: () => {
                ctx.closeMenu();
                ctx.service.weather.openApp();
            }});
        this._placeLabel = label('', 'nowbar-btn-label');
        this._place.child.add_child(this._placeLabel);
        this._range = label('', 'nowbar-card-detail', {x_align: Clutter.ActorAlign.END});
        side.add_child(this._place);
        side.add_child(this._range);
        head.add_child(side);
        this.actor.add_child(head);

        // Rain on the way.
        this._rain = hbox({style_class: 'nowbar-weather-rain'});
        this._rainIcon = new St.Icon({style_class: 'nowbar-weather-rain-icon'});
        this._rainLabel = label('', 'nowbar-weather-rain-label');
        this._rain.add_child(this._rainIcon);
        this._rain.add_child(this._rainLabel);
        this.actor.add_child(this._rain);

        this._facts = hbox({style_class: 'nowbar-weather-facts'});
        this.actor.add_child(this._facts);
        this._hours = hbox({style_class: 'nowbar-weather-hours'});
        this.actor.add_child(this._hours);
        this._days = vbox({style_class: 'nowbar-weather-days'});
        this.actor.add_child(this._days);

        const foot = hbox({style_class: 'nowbar-weather-foot'});
        this._age = label('', 'nowbar-card-detail', {x_expand: true});
        foot.add_child(this._age);
        foot.add_child(button({icon: 'view-refresh-symbolic', styleClass: 'flat', accessibleName: 'Refresh',
            onClick: () => ctx.service.weather.refresh()}));
        this.actor.add_child(foot);
        this.update(a);
    }

    update(a) {
        const w = a.weather;
        this._icon.icon_name = iconFor(w.icon, 'weather');
        this._icon.style = a.color ? `color: ${a.color};` : null;
        this._temp.text = `${w.temp}${w.unit}`;
        this._desc.text = [w.desc, w.feels !== w.temp ? `feels like ${w.feels}°` : ''].filter(x => x).join(' · ');
        this._placeLabel.text = w.location || 'Pick a place';
        const canPick = this._ctx.service.weather.available;
        this._place.reactive = this._place.can_focus = this._place.track_hover = canPick;
        this._rain.visible = !!a.rain;
        if (a.rain) {
            this._rainIcon.icon_name = iconFor(a.rain.icon, 'weather');
            this._rainLabel.text = a.rain.text;
        }
        const today = w.days[0];
        this._range.text = today ? `H ${today.max}°  L ${today.min}°` : '';

        const key = JSON.stringify([w.wind, w.humidity, w.sunset, w.sunrise, w.hours, w.days]);
        if (key === this._key) {
            this._age.text = a.fetching ? 'Updating…' : a.age?.text ?? '';
            return;
        }
        this._key = key;

        this._facts.destroy_all_children();
        const fact = (icon, text) => {
            if (!text)
                return;
            const b = hbox({style_class: 'nowbar-fact'});
            b.add_child(new St.Icon({icon_name: icon, style_class: 'nowbar-fact-icon'}));
            b.add_child(label(text, 'nowbar-card-detail'));
            this._facts.add_child(b);
        };
        fact('weather-windy-symbolic', w.wind);
        fact('weather-showers-scattered-symbolic', w.humidity ? `${w.humidity}` : '');
        fact(w.night ? 'daytime-sunrise-symbolic' : 'daytime-sunset-symbolic', w.night ? w.sunrise : w.sunset);

        this._hours.destroy_all_children();
        for (const h of w.hours) {
            const col = vbox({style_class: 'nowbar-hour', x_expand: true});
            col.add_child(label(h.label, 'nowbar-hour-label', {x_align: Clutter.ActorAlign.CENTER}));
            col.add_child(new St.Icon({icon_name: iconFor(h.icon, 'weather'), style_class: 'nowbar-hour-icon',
                x_align: Clutter.ActorAlign.CENTER}));
            col.add_child(label(`${h.temp}°`, 'nowbar-hour-temp', {x_align: Clutter.ActorAlign.CENTER}));
            this._hours.add_child(col);
        }
        this._hours.visible = w.hours.length > 1;

        // Each day's range on a bar shared by all of them.
        this._days.destroy_all_children();
        const lo = Math.min(...w.days.map(d => d.min));
        const hi = Math.max(...w.days.map(d => d.max));
        const span = Math.max(1, hi - lo);
        const BAR = 110;
        for (const d of w.days) {
            const row = hbox({style_class: 'nowbar-day'});
            row.add_child(label(d.name, 'nowbar-day-name'));
            row.add_child(new St.Icon({icon_name: iconFor(d.icon, 'weather'), style_class: 'nowbar-day-icon'}));
            row.add_child(label(`${d.min}°`, 'nowbar-day-temp', {x_expand: true, x_align: Clutter.ActorAlign.END}));
            const track = new St.Widget({style_class: 'nowbar-day-track', style: `width: ${BAR}px;`,
                y_align: Clutter.ActorAlign.CENTER});
            const left = Math.round((d.min - lo) / span * BAR);
            const width = Math.max(6, Math.round((d.max - d.min) / span * BAR));
            track.add_child(new St.Widget({style_class: 'nowbar-day-fill',
                style: `margin-left: ${left}px; width: ${Math.min(width, BAR - left)}px;`}));
            row.add_child(track);
            row.add_child(label(`${d.max}°`, 'nowbar-day-temp'));
            this._days.add_child(row);
        }
        this._age.text = a.fetching ? 'Updating…' : a.age?.text ?? '';
    }

    destroy() {
        this.actor.destroy();
    }
}

export function cardKind(a) {
    if (a.module === 'media')
        return MediaCard;
    if (a.id === 'brief' && a.weather)
        return WeatherCard;
    return Card;
}
