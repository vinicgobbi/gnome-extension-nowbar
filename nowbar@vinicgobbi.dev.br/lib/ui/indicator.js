import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as Model from '../model.js';
import {IDLE, batteryIcon, iconFor} from '../icons.js';
import {PopupContent} from './popup.js';
import {Bar, Equalizer, hbox, label} from './widgets.js';

// The pill in the top bar: the focused activity's icon and text, a thin
// progress line and the 2/4 marker. Left click opens the popup, scroll
// switches, middle click runs the main action, right click hides the
// activity until it changes.

export const NowbarIndicator = GObject.registerClass(
class NowbarIndicator extends PanelMenu.Button {
    _init(service, openPreferences) {
        super._init(0.5, 'Now Bar', false);
        this._service = service;
        this.add_style_class_name('nowbar-button');

        // The panel button's own gesture opens the menu on any button; this
        // one tells them apart.
        this._clickGesture.set_enabled(false);
        this._buttons = new Clutter.ClickGesture();
        this._buttons.set_recognize_on_press(true);
        this._buttons.connect('recognize', g => this._onClick(g.get_button()));
        this.add_action(this._buttons);

        this._scrollAcc = 0;
        this._scrollLast = 0;
        this._scrollQuietUntil = 0;
        this._direction = 0;
        this._shownId = null;
        this._styles = new Map();

        this._pill = new St.Widget({style_class: 'nowbar-pill', layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER});
        // Centered: while the pill eases to a new width, the content stays in
        // the middle instead of hugging the left edge.
        const row = hbox({style_class: 'nowbar-row', x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER});
        this._row = row;
        // Not 'system-status-icon': themes pad that one, and the icon must take
        // the same room as the equalizer that replaces it while music plays.
        this._icon = new St.Icon({style_class: 'nowbar-icon', icon_name: IDLE, y_align: Clutter.ActorAlign.CENTER});
        this._label = label('', 'nowbar-label');
        this._count = label('', 'nowbar-count');
        // Three dancing bars while music plays.
        this._eq = new Equalizer();
        row.add_child(this._eq.actor);
        row.add_child(this._icon);
        row.add_child(this._label);
        row.add_child(this._count);
        this._bar = new Bar('nowbar-pill-progress');
        this._bar.actor.y_align = Clutter.ActorAlign.END;
        this._bar.actor.x_align = Clutter.ActorAlign.FILL;
        this._pill.add_child(row);
        this._pill.add_child(this._bar.actor);
        this.add_child(this._pill);

        this._content = new PopupContent({
            service,
            closeMenu: () => this.menu.close(),
            openPreferences: () => {
                this.menu.close();
                openPreferences();
            },
        });
        this.menu.box.add_child(this._content.actor);
        this.menu.box.add_style_class_name('nowbar-menu');
        this._lockMenuX();
        this.menu.connect('open-state-changed', (m, open) => {
            this._menuX = null;
            service.setPopupOpen(open);
            if (open) {
                this._content.update();
                if (service.prefs.animations)
                    this._content.animateOpen();
            }
        });
        // Keys go to whatever has the focus inside the menu; catch them on
        // the way down so the carousel shortcuts work anywhere in it.
        this.menu.actor.connect('captured-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;
            return this._content.onKey(event);
        });

        // Light or dark top bar (Adwaita's is light in light mode, Yaru's
        // always dark): read from the theme, not guessed from the scheme.
        this.connect('style-changed', () => this._syncTone());

        this._changedId = service.connect('changed', () => this._sync());
        this._sync();
    }

    // The shell centers the popup on the button at every relayout, so a
    // pill that changes width (another activity, a longer text) would drag
    // the open popup sideways. It stays where it opened until it closes.
    _lockMenuX() {
        this._menuX = null;
        const bp = this.menu._boxPointer;
        const reposition = bp._reposition.bind(bp);
        bp._reposition = box => {
            reposition(box);
            if (!this.menu.isOpen)
                return;
            if (this._menuX === null) {
                this._menuX = box.x1;
            } else if (box.x1 !== this._menuX) {
                bp.setArrowOrigin(bp._arrowOrigin + box.x1 - this._menuX);
                box.set_origin(this._menuX, box.y1);
            }
        };
    }

    _onClick(button) {
        const f = this._service.focused;
        if (button === Clutter.BUTTON_MIDDLE) {
            if (f)
                this._service.primary(f.id);
        } else if (button === Clutter.BUTTON_SECONDARY) {
            // The camera/mic card only goes away by its own buttons.
            if (f && f.module !== 'privacy')
                this._service.dismiss(f.id);
        } else {
            this.menu.toggle();
        }
    }

    // One step per notch or per swipe. Clutter sends a scroll twice (smooth,
    // and a discrete copy flagged as emulated): only the smooth one counts.
    // A touchpad swipe adds up until it is worth a step, then waits a bit,
    // so its inertia doesn't run through every activity.
    vfunc_scroll_event(event) {
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        const now = GLib.get_monotonic_time() / 1000;
        const dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
            if (now - this._scrollLast > 300 || Math.sign(d) !== Math.sign(this._scrollAcc))
                this._scrollAcc = 0;
            this._scrollLast = now;
            if (now < this._scrollQuietUntil)
                return Clutter.EVENT_STOP;
            this._scrollAcc += d;
            if (Math.abs(this._scrollAcc) >= 1) {
                delta = Math.sign(this._scrollAcc);
                this._scrollAcc = 0;
                this._scrollQuietUntil = now + 250;
            }
        } else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) {
            delta = 1;
        } else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) {
            delta = -1;
        }
        if (delta) {
            this._direction = delta;
            this._service.step(delta);
        }
        return Clutter.EVENT_STOP;
    }

    togglePopup() {
        this.menu.toggle();
    }

    openPopup() {
        this.menu.open();
    }

    // The activity the pill shows: the focused one, except the weather card
    // when the options say the idle pill shows something else.
    _pillActivity() {
        const f = this._service.focused;
        if (f && f.ambient && this._service.prefs.whenEmpty !== 'brief')
            return null;
        return f;
    }

    // Dark text on the panel means a light panel: the pill's tints go dark.
    _syncTone() {
        const c = this.get_theme_node().get_foreground_color();
        const onLight = 0.299 * c.red + 0.587 * c.green + 0.114 * c.blue < 128;
        if (onLight)
            this._pill.add_style_class_name('on-light');
        else
            this._pill.remove_style_class_name('on-light');
    }

    // Sets a style only when it changes: St redoes the layout on each set.
    _style(actor, style) {
        if (this._styles.get(actor) === style)
            return;
        this._styles.set(actor, style);
        actor.style = style;
    }

    _sync() {
        const s = this._service;
        const p = s.prefs;
        const a = this._pillActivity();
        const n = s.activities.length;
        const animate = p.animations && this.mapped;
        // The width it has now (mid-animation included), before the new
        // content changes it.
        const fromWidth = animate && this._pill.has_allocation() ? this._pill.width : -1;

        this.visible = !!a || p.whenEmpty !== 'hide' || this.menu.isOpen;
        const classes = {urgent: false, charging: false, paused: false, idle: !a};

        const width = p.maxWidth;
        this._style(this._label, p.pillWidth === 'fit' ? `max-width: ${width}px;` : `width: ${width}px;`);

        if (!a) {
            this._icon.icon_name = IDLE;
            this._icon.visible = true;
            this._label.visible = false;
            this._count.visible = false;
            this._bar.set(-1);
            this._eq.stop();
        } else {
            this._label.visible = true;
            this._label.text = a.pillText || a.title;
            if (a.id === 'charging')
                this._icon.icon_name = batteryIcon(a.progress, true);
            else
                this._icon.icon_name = iconFor(a.icon, a.module);
            this._style(this._icon, a.color && p.coverAccent ? `color: ${a.color};` : null);
            classes.urgent = !!a.urgent;
            classes.charging = a.id === 'charging';
            classes.paused = a.module === 'media' && !a.playing;

            const dancing = a.module === 'media' && a.playing && p.animations;
            this._icon.visible = !dancing;
            if (dancing)
                this._eq.start(a.color && p.coverAccent ? a.color : null);
            else
                this._eq.stop();

            this._bar.set(p.showProgress ? a.progress : -1, a.color, animate);
            const i = Model.indexOfId(s.activities, a.id);
            this._count.visible = p.showCount && n > 1;
            this._count.text = `${i + 1}/${n}`;
        }
        for (const [c, on] of Object.entries(classes)) {
            if (on)
                this._pill.add_style_class_name(c);
            else
                this._pill.remove_style_class_name(c);
        }
        this.accessible_name = Model.tooltipLabel(a, s.focusIndex, n);

        const id = a?.id ?? '';
        if (id !== this._shownId) {
            if (this._shownId !== null && animate)
                this._slideIn();
            this._shownId = id;
        }
        this._direction = 0;
        this._easeWidth(fromWidth);
        this._pulseIfNew(a);
        if (this.menu.isOpen)
            this._content.update();
    }

    // Another activity took the pill: its content comes in from the side
    // it was scrolled to (from below when it took the pill by itself).
    _slideIn() {
        const row = this._row;
        row.remove_transition('translation-y');
        row.remove_transition('opacity');
        row.translation_y = (this._direction || 1) * 8;
        row.opacity = 0;
        row.ease({translation_y: 0, opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // The pill goes from the width it had to the one its new content needs
    // instead of jumping, then is left to its natural size again.
    _easeWidth(from) {
        const pill = this._pill;
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
        if (!key || !this._service.prefs.animations || !this.mapped)
            return;
        this._pill.remove_transition('opacity');
        let times = 3;
        const pulse = () => {
            if (times-- <= 0)
                return;
            this._pill.ease({opacity: 110, duration: 220, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                onComplete: () => this._pill.ease({opacity: 255, duration: 220,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD, onComplete: pulse})});
        };
        pulse();
    }

    _onDestroy() {
        this._service.disconnect(this._changedId);
        this._eq.stop();
        this._pill.remove_all_transitions();
        this._row.remove_all_transitions();
        this._content.destroy();
        super._onDestroy();
    }
});
