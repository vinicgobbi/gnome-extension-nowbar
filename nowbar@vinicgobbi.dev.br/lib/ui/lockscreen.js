import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Pill, ScrollStepper} from './pill.js';
import {PopupContent} from './popup.js';
import {vbox} from './widgets.js';

// The Now Bar on the lock screen: a bigger pill at the top, in the middle
// of the main monitor. A click opens it as on One UI's lock screen: the
// clock shrinks up under the pill and the card takes the middle of the
// screen, on the wallpaper, with the carousel's dots under it (the popup's
// content, minus what opens apps: see NowbarService._lockSafe). Another
// click on the pill, or the password prompt coming up, closes it. Scroll
// over the pill or the card switches activities.
//
// It lives inside GNOME's unlock dialog, so it goes away with it.

const EXPAND_MS = 260;
// The clock's size while the card is open (the date a bit bigger than the
// time), and the room around it.
const CLOCK_SCALE = 0.5;
const DATE_SCALE = 1.5;
const GAP = 16;
// The card's width: this much of the monitor, within these bounds (in
// logical pixels); the cover takes the height left, up to a square.
const WIDTH_SHARE = 0.32;
const MIN_WIDTH = 400;
const MAX_WIDTH = 600;
const MIN_COVER = 200;
// What a music card needs under its cover: seek bar, controls, dots.
const UNDER_COVER = 200;

export class LockScreenNowbar {
    // `onGone()`: the dialog it was in is gone, and it with it.
    constructor(service, dialog, onGone) {
        this._service = service;
        this.dialog = dialog;
        this._expanded = false;

        // As big as the main monitor but not reactive: clicks around the
        // pill and the card reach the lock screen under it. Its children
        // are placed by hand, centered across.
        this.actor = new St.Widget({style_class: 'nowbar-lock'});
        this.actor.add_constraint(new Layout.MonitorConstraint({primary: true}));
        const centered = actor => actor.add_constraint(new Clutter.AlignConstraint({source: this.actor,
            align_axis: Clutter.AlignAxis.X_AXIS, factor: 0.5}));

        this._box = vbox({style_class: 'nowbar-lock-box'});
        centered(this._box);
        this._pill = new Pill(service, {styleClass: 'nowbar-lock-pill', widthScale: 1.4});
        this._button = new St.Button({style_class: 'nowbar-lock-button', child: this._pill.actor,
            accessible_name: 'Now Bar'});
        this._button.connect('clicked', () => this._setExpanded(!this._expanded));
        this._button.connect('notify::hover', () => this._syncLit());
        this._scroll = new ScrollStepper(delta => {
            this._pill.direction = delta;
            service.step(delta);
        });
        this._button.connect('scroll-event', (b, event) => this._scroll.handle(event));
        this._box.add_child(this._button);
        this.actor.add_child(this._box);

        // `coverHeight` is set on each opening (see _fit).
        this._ctx = {
            service,
            locked: true,
            coverHeight: 0,
            closeMenu: () => this._setExpanded(false),
        };
        this._content = new PopupContent(this._ctx);
        this._view = new St.Bin({style_class: 'nowbar-lock-view', child: this._content.actor,
            reactive: true, visible: false});
        centered(this._view);
        // Scrolling over the card switches, and isn't the lock screen's swipe.
        this._view.connect('scroll-event', (v, event) => this._scroll.handle(event));
        this.actor.add_child(this._view);

        dialog.add_child(this.actor);
        // The password prompt and the clock share one stack: while the card
        // is open the stack shrinks out of its way, and the prompt showing
        // closes the card.
        dialog._promptBox?.connectObject('notify::visible', () => {
            if (dialog._promptBox.visible)
                this._setExpanded(false);
        }, this);
        dialog.connectObject('destroy', () => {
            this.destroy();
            onGone();
        }, this);

        this._changedId = service.connect('changed', () => this._sync());
        this._sync();
    }

    _sync() {
        const a = this._service.focused;
        this._box.visible = !!a;
        if (!a) {
            this._setExpanded(false);
            return;
        }
        this._pill.show(a);
        if (this._expanded)
            this._content.update();
    }

    _syncLit() {
        this._pill.setLit(this._button.hover || this._expanded);
    }

    _setExpanded(on) {
        if (on === this._expanded)
            return;
        this._expanded = on;
        this._service.setPopupOpen(on);
        this._syncLit();
        const animate = this._service.prefs.animations;
        const view = this._view;
        view.remove_all_transitions();
        // Opened from the password prompt: the clock comes back to sit
        // above the card.
        if (on && this.dialog._activePage === this.dialog._promptBox)
            this.dialog._showClock?.();
        const clockBottom = this._moveClock(on, animate);
        if (on) {
            const top = Math.round(clockBottom + GAP);
            this._fit(top);
            this._content.update();
            view.y = top;
            view.show();
            if (animate) {
                view.opacity = 0;
                view.translation_y = 24;
                view.ease({opacity: 255, translation_y: 0, duration: EXPAND_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        } else if (animate && view.mapped) {
            view.ease({opacity: 0, translation_y: 24, duration: EXPAND_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => view.hide()});
        } else {
            view.hide();
        }
    }

    // The card as big as the screen allows: wider on a wider monitor, and
    // the cover down to the native notifications (or the bottom).
    _fit(top) {
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // The monitor, not this actor: it may not be laid out yet.
        const monitor = Main.layoutManager.primaryMonitor;
        const width = Math.max(MIN_WIDTH * s, Math.min(MAX_WIDTH * s, monitor.width * WIDTH_SHARE));
        this._content.actor.style = `width: ${Math.round(width / s)}px;`;
        let bottom = monitor.height - 2 * GAP * s;
        const notes = this.dialog._notificationsBox;
        if (notes?.visible && notes.height > 0) {
            const [, notesY] = notes.get_transformed_position();
            const [, originY] = this.actor.get_transformed_position();
            bottom = notesY - originY - GAP * s;
        }
        const cover = bottom - top - UNDER_COVER * s;
        this._ctx.coverHeight = Math.round(Math.max(MIN_COVER * s, Math.min(width, cover)));
    }

    // The clock (and the date under it) shrinks up to just under the pill,
    // or goes back; its "click to unlock" hint, too small then, is hidden
    // (by its text color: the dialog eases its opacity itself). The dialog
    // moves the clock itself between it and the prompt, so the stack around
    // it is the one moved. Returns where the shrunk date ends, in this
    // actor's coordinates.
    _moveClock(up, animate) {
        const stack = this.dialog._stack;
        const clock = this.dialog._clock;
        if (!stack || !clock)
            return this._box.y + this._box.height;
        const [, originY] = this.actor.get_transformed_position();
        const [, parentY] = stack.get_parent().get_transformed_position();
        const top = parentY - originY + stack.get_allocation_box().y1;
        const target = this._box.y + this._box.height + GAP / 2;
        // Where the date ends inside the stack (the clock fills it), grown
        // from its top.
        const date = clock._date ?? clock;
        const dateBox = date.get_allocation_box();
        const dateScale = date === clock ? 1 : DATE_SCALE;
        const dateBottom = clock.get_allocation_box().y1 + dateBox.y1 + (dateBox.y2 - dateBox.y1) * dateScale;
        stack.set_pivot_point(0.5, 0);
        date.set_pivot_point(0.5, 0);
        const moves = [
            [stack, up
                ? {scale_x: CLOCK_SCALE, scale_y: CLOCK_SCALE, translation_y: target - top}
                : {scale_x: 1, scale_y: 1, translation_y: 0}],
            [date, {scale_x: up ? dateScale : 1, scale_y: up ? dateScale : 1}],
        ];
        for (const [actor, props] of moves) {
            for (const k in props)
                actor.remove_transition(k.replace('_', '-'));
            if (animate)
                actor.ease({...props, duration: EXPAND_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                actor.set(props);
        }
        if (up)
            clock._hint?.add_style_class_name('nowbar-lock-hidden');
        else
            clock._hint?.remove_style_class_name('nowbar-lock-hidden');
        return target + dateBottom * CLOCK_SCALE;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._service.disconnect(this._changedId);
        if (this._expanded) {
            this._service.setPopupOpen(false);
            this._moveClock(false, false);
        }
        this.dialog._promptBox?.disconnectObject(this);
        this.dialog.disconnectObject(this);
        this._view.remove_all_transitions();
        this._content.destroy();
        this._pill.destroy();
        this.actor.destroy();
    }
}
