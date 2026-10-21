import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Model from '../model.js';
import {IDLE, batteryIcon, iconFor} from '../icons.js';
import {MonochromeEffect, appFor, hbox, label, readableOn, symbolicIcon} from './widgets.js';

// The pill itself: an activity's icon and text and the 2/4 marker. Music
// shows the player's app icon (in one color) on the cover's accent color,
// the weather sits on the sky's color. The top bar's button and the lock
// screen both show one; what a click or a scroll does is theirs.

// The cover's accent (and the sky's color) is made to read as text and
// marks on a dark bar (50-70 % light); filling the pill, the same hue goes
// deeper, and not neon.
function pillColor(hex) {
    const m = /^#(..)(..)(..)$/.exec(hex);
    if (!m)
        return hex;
    const {h, s, l} = Model.rgbToHsl(...[m[1], m[2], m[3]].map(x => parseInt(x, 16) / 255));
    return Model.hslToHex(h, Math.min(0.8, s), Math.min(0.4, l));
}

// `a` toward `b` by `t` (#rrggbb).
function mixHex(a, b, t) {
    const ch = (h, i) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
    return `#${[0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t)
        .toString(16).padStart(2, '0')).join('')}`;
}

// Scrolling over a pill switches activities: `onStep(±1)` once per notch
// or per swipe. Clutter sends a scroll twice (smooth, and a discrete copy
// flagged as emulated): only the smooth one counts. A touchpad swipe adds
// up until it is worth a step, then waits a bit, so its inertia doesn't run
// through every activity.
export class ScrollStepper {
    constructor(onStep) {
        this._onStep = onStep;
        this._acc = 0;
        this._last = 0;
        this._quietUntil = 0;
    }

    // Returns what the scroll handler returns: the scroll stops here.
    handle(event) {
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        const now = GLib.get_monotonic_time() / 1000;
        const dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
            if (now - this._last > 300 || Math.sign(d) !== Math.sign(this._acc))
                this._acc = 0;
            this._last = now;
            if (now < this._quietUntil)
                return Clutter.EVENT_STOP;
            this._acc += d;
            if (Math.abs(this._acc) >= 1) {
                delta = Math.sign(this._acc);
                this._acc = 0;
                this._quietUntil = now + 250;
            }
        } else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) {
            delta = 1;
        } else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) {
            delta = -1;
        }
        if (delta)
            this._onStep(delta);
        return Clutter.EVENT_STOP;
    }
}

export class Pill {
    // `widthScale`: the text's width is the options' one times this.
    constructor(service, {styleClass = '', widthScale = 1} = {}) {
        this._service = service;
        this._widthScale = widthScale;
        this._styles = new Map();
        this._shownId = null;
        this._lit = false;
        // Which way the carousel was just scrolled (-1, 0, 1): the new
        // content comes in from that side.
        this.direction = 0;

        this.actor = new St.Widget({style_class: `nowbar-pill ${styleClass}`.trim(),
            layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        // Centered: while the pill eases to a new width, the content stays in
        // the middle instead of hugging the left edge.
        const row = hbox({style_class: 'nowbar-row', x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER});
        this._row = row;
        // Not 'system-status-icon': themes pad that one.
        this._icon = new St.Icon({style_class: 'nowbar-icon', icon_name: IDLE, y_align: Clutter.ActorAlign.CENTER});
        this._label = label('', 'nowbar-label');
        this._count = label('', 'nowbar-count');
        row.add_child(this._icon);
        row.add_child(this._label);
        row.add_child(this._count);
        this.actor.add_child(row);
    }

    // Sets a style only when it changes: St redoes the layout on each set.
    _style(actor, style) {
        if (this._styles.get(actor) === style)
            return;
        this._styles.set(actor, style);
        actor.style = style;
    }

    // Dark text around means a light bar: the pill's tints go dark.
    setOnLight(on) {
        if (on)
            this.actor.add_style_class_name('on-light');
        else
            this.actor.remove_style_class_name('on-light');
    }

    // Hovered or open: a tinted pill lights up a little.
    setLit(lit) {
        this._lit = lit;
        this._syncTint();
    }

    // Shows `a` (null: the empty pill).
    show(a) {
        const s = this._service;
        const p = s.prefs;
        const n = s.activities.length;
        const animate = p.animations && this.actor.mapped;
        // The width it has now (mid-animation included), before the new
        // content changes it.
        const fromWidth = animate && this.actor.has_allocation() ? this.actor.width : -1;

        const classes = {urgent: false, charging: false, paused: false, idle: !a};

        const width = Math.round(p.maxWidth * this._widthScale);
        this._style(this._label, p.pillWidth === 'fit' ? `max-width: ${width}px;` : `width: ${width}px;`);

        if (!a) {
            this._icon.icon_name = IDLE;
            this._icon.visible = true;
            this._label.visible = false;
            this._count.visible = false;
            this._setMonochrome(false);
            this._tint = null;
        } else {
            this._label.visible = true;
            this._label.text = a.pillText || a.title;
            const media = a.module === 'media';
            const appIcon = media ? this._appIcon(a) : null;
            if (appIcon)
                this._icon.gicon = appIcon.gicon;
            else if (a.id === 'charging')
                this._icon.icon_name = batteryIcon(a.progress, true);
            else
                this._icon.icon_name = iconFor(a.icon, a.module);
            this._icon.visible = true;
            this._setMonochrome(!!appIcon?.colored);
            // Music and the weather: the whole pill in the cover's or the
            // sky's color; the rest: just the icon.
            const themed = media || a.module === 'weather';
            this._tint = themed && a.color && p.coverAccent && !a.urgent ? pillColor(a.color) : null;
            this._style(this._icon, !this._tint && a.color && p.coverAccent ? `color: ${a.color};` : null);
            classes.urgent = !!a.urgent;
            classes.charging = a.id === 'charging';
            classes.paused = media && !a.playing;

            const i = Model.indexOfId(s.activities, a.id);
            this._count.visible = p.showCount && n > 1;
            this._count.text = `${i + 1}/${n}`;
        }
        classes.tinted = !!this._tint;
        classes['tint-light'] = !!this._tint && readableOn(this._tint) !== '#ffffff';
        this._syncTint();
        for (const [c, on] of Object.entries(classes)) {
            if (on)
                this.actor.add_style_class_name(c);
            else
                this.actor.remove_style_class_name(c);
        }

        const id = a?.id ?? '';
        if (id !== this._shownId) {
            if (this._shownId !== null && animate)
                this._slideIn();
            this._shownId = id;
        }
        this.direction = 0;
        this._easeWidth(fromWidth);
        this._pulseIfNew(a);
    }

    // Another activity took the pill: its content comes in from the side
    // it was scrolled to (from below when it took the pill by itself).
    _slideIn() {
        const row = this._row;
        row.remove_transition('translation-y');
        row.remove_transition('opacity');
        row.translation_y = (this.direction || 1) * 8;
        row.opacity = 0;
        row.ease({translation_y: 0, opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // The player's app icon: its symbolic one, or its colored one to be
    // painted in one color; null when the app isn't found.
    _appIcon(a) {
        const key = `${a.desktopEntry ?? ''}\u0000${a.playerName ?? ''}`;
        if (key !== this._appKey) {
            this._appKey = key;
            const app = appFor(a.desktopEntry, a.playerName);
            const symbolic = symbolicIcon(app);
            const gicon = symbolic ?? app?.get_icon() ?? null;
            this._appIconCache = gicon ? {gicon, colored: !symbolic} : null;
        }
        return this._appIconCache;
    }

    _setMonochrome(on) {
        if (on && !this._mono) {
            this._mono = new MonochromeEffect();
            this._icon.add_effect(this._mono);
        } else if (!on && this._mono) {
            this._icon.remove_effect(this._mono);
            this._mono = null;
        }
    }

    // The cover's color behind a music pill, a bit lighter while lit; text
    // and icon in black or white, whichever reads on it.
    _syncTint() {
        const c = this._tint;
        let style = null;
        if (c) {
            const bg = this._lit ? mixHex(c, '#ffffff', 0.15) : c;
            style = `background-color: ${bg}; color: ${readableOn(c)};`;
        }
        this._style(this.actor, style);
    }

    // The pill goes from the width it had to the one its new content needs
    // instead of jumping, then is left to its natural size again.
    _easeWidth(from) {
        const pill = this.actor;
        if (from <= 0) {
            pill.remove_transition('width');
            pill.width = -1;
            this._widthTo = null;
            return;
        }
        const running = pill.get_transition('width');
        const current = pill.natural_width_set ? pill.width : -1;
        pill.width = -1;
        const [, to] = pill.get_preferred_width(-1);
        if (running && to === this._widthTo) {
            pill.width = current;
            return;
        }
        pill.remove_transition('width');
        pill.width = -1;
        this._widthTo = to;
        if (Math.abs(from - to) < 1)
            return;
        pill.width = from;
        pill.ease({width: to, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => (pill.width = -1)});
    }

    // Something urgent that just showed up: the pill pulses a few times.
    _pulseIfNew(a) {
        const key = a?.urgent ? `${a.id}:${a.signature}` : '';
        if (key === this._pulsed)
            return;
        this._pulsed = key;
        if (!key || !this._service.prefs.animations || !this.actor.mapped)
            return;
        this.actor.remove_transition('opacity');
        let times = 3;
        const pulse = () => {
            if (times-- <= 0)
                return;
            this.actor.ease({opacity: 110, duration: 220, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                onComplete: () => this.actor.ease({opacity: 255, duration: 220,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD, onComplete: pulse})});
        };
        pulse();
    }

    destroy() {
        this.actor.remove_all_transitions();
        this._row.remove_all_transitions();
        this.actor.destroy();
    }
}
