import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {cardKind, MediaCard} from './cards.js';
import {button, easeToNatural, hbox, label, vbox} from './widgets.js';

// What the pill's menu holds: the carousel (‹ dots ›, one card at a time).
// Switches (Do Not Disturb, night light...) are left to GNOME's Quick
// Settings. Keys: ←/→ (h/l) switch,
// Enter the main action, ↑/↓ volume and [ / ] seek on a media card, x hide,
// u show hidden, c options, q close.

export class PopupContent {
    // ctx = {service, closeMenu(), openPreferences(), locked}. On the lock
    // screen (`locked`): no options, the lock screen's cards, and the dots
    // alone, under the card (scroll switches).
    constructor(ctx) {
        this._ctx = ctx;
        this._service = ctx.service;
        this.actor = vbox({style_class: 'nowbar-popup', x_expand: true});

        // ‹ dots › … hidden, options
        const nav = hbox({style_class: 'nowbar-nav'});
        this._prev = button({icon: 'go-previous-symbolic', styleClass: 'flat', accessibleName: 'Previous activity',
            onClick: () => this._step(-1)});
        this._dots = hbox({style_class: 'nowbar-dots', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this._next = button({icon: 'go-next-symbolic', styleClass: 'flat', accessibleName: 'Next activity',
            onClick: () => this._step(1)});
        this._hidden = button({icon: 'view-reveal-symbolic', styleClass: 'flat', text: '0', accessibleName: 'Show hidden activities',
            onClick: () => this._service.showHidden()});
        const gear = button({icon: 'emblem-system-symbolic', styleClass: 'flat', accessibleName: 'Options',
            onClick: () => ctx.openPreferences()});
        gear.visible = !!ctx.openPreferences;
        nav.add_child(this._prev);
        nav.add_child(this._dots);
        nav.add_child(this._next);
        nav.add_child(this._hidden);
        nav.add_child(gear);
        this._nav = nav;
        if (ctx.locked) {
            this._prev.hide();
            this._next.hide();
            nav.add_style_class_name('below');
        } else {
            this.actor.add_child(nav);
        }

        // Clipped: while its height eases between two cards, the new one is
        // uncovered instead of squeezed.
        this._cardBin = new St.Bin({style_class: 'nowbar-card-bin', x_expand: true, clip_to_allocation: true});
        this.actor.add_child(this._cardBin);
        this._empty = label('Nothing going on right now', 'nowbar-empty', {x_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._empty);
        if (ctx.locked)
            this.actor.add_child(nav);
        this._card = null;
        this._cardId = '';
        this._cardKind = null;

    }

    _step(delta) {
        this._direction = delta;
        this._service.step(delta);
    }

    update() {
        const s = this._service;
        const list = s.activities;
        const focused = s.focused;

        // Dots.
        if (this._dots.get_n_children() !== list.length || this._dotsKey !== list.map(a => a.id).join()) {
            this._dotsKey = list.map(a => a.id).join();
            this._dots.destroy_all_children();
            for (const a of list) {
                const dot = new St.Button({style_class: 'nowbar-dot', can_focus: false, accessible_name: a.title,
                    y_align: Clutter.ActorAlign.CENTER});
                dot.connect('clicked', () => {
                    // The card slides in from the dot's side.
                    this._direction = Math.sign(s.activities.findIndex(x => x.id === a.id) - s.focusIndex);
                    s.focusOn(a.id);
                });
                dot._id = a.id;
                this._dots.add_child(dot);
            }
        }
        // The long dot stretches over to the new card instead of jumping:
        // one shrinks while the other grows, so the row doesn't move.
        const animate = this._animating();
        for (const dot of this._dots.get_children()) {
            const on = dot._id === s.focusId;
            if (on === dot.has_style_pseudo_class('checked'))
                continue;
            const from = animate && dot.has_allocation() ? dot.width : -1;
            if (on)
                dot.add_style_pseudo_class('checked');
            else
                dot.remove_style_pseudo_class('checked');
            easeToNatural(dot, 'width', from);
        }
        this._dots.visible = list.length > 1;
        this._prev.visible = this._next.visible = this._dots.visible && !this._ctx.locked;
        this._hidden.visible = s.hiddenList.length > 0;
        this._hidden.child.get_last_child().text = `${s.hiddenList.length}`;

        // The card.
        this._empty.visible = !focused;
        if (!focused) {
            this._card?.destroy();
            this._card = null;
            this._cardId = '';
        } else {
            const Kind = cardKind(focused, !!this._ctx.locked);
            if (this._cardId === focused.id && this._cardKind === Kind) {
                this._card.update(focused);
            } else {
                const fromHeight = this._animating() && this._cardBin.has_allocation() ? this._cardBin.height : -1;
                this._card?.destroy();
                this._card = new Kind(this._ctx, focused);
                this._cardId = focused.id;
                this._cardKind = Kind;
                this._card.actor.y_align = Clutter.ActorAlign.START;
                this._cardBin.set_child(this._card.actor);
                this._slideIn();
                // Cards differ in height: the popup grows or shrinks to the new one.
                easeToNatural(this._cardBin, 'height', fromHeight);
            }
        }
        this.actor.remove_style_class_name('urgent');
        if (focused?.urgent)
            this.actor.add_style_class_name('urgent');

    }

    // The popup opening: its parts come down one after the other.
    animateOpen() {
        [this._nav, this._cardBin, this._empty].forEach((part, i) => {
            part.remove_transition('opacity');
            part.remove_transition('translation-y');
            part.opacity = 0;
            part.translation_y = -10;
            part.ease({opacity: 255, translation_y: 0, delay: i * 50, duration: 220,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    _animating() {
        return this._service.prefs.animations && this.actor.mapped;
    }

    _slideIn() {
        const dir = this._direction ?? 0;
        this._direction = 0;
        if (!this._animating())
            return;
        const card = this._card.actor;
        card.opacity = 0;
        card.translation_x = dir * 24;
        card.ease({opacity: 255, translation_x: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Called by the indicator for every key pressed while the menu is open.
    onKey(event) {
        const s = this._service;
        const sym = event.get_key_symbol();
        const ch = String.fromCodePoint(Clutter.keysym_to_unicode(sym) || 32).toLowerCase();
        const focused = s.focused;
        if (sym === Clutter.KEY_Left || ch === 'h')
            this._step(-1);
        else if (sym === Clutter.KEY_Right || ch === 'l')
            this._step(1);
        else if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) && focused &&
                 !(global.stage.get_key_focus() instanceof St.Button))
            s.primary(focused.id);
        else if ((sym === Clutter.KEY_Up || ch === 'k') && this._card instanceof MediaCard)
            this._card.volumeBy(0.05);
        else if ((sym === Clutter.KEY_Down || ch === 'j') && this._card instanceof MediaCard)
            this._card.volumeBy(-0.05);
        else if (ch === '[' && focused?.module === 'media')
            s.act(focused.id, 'back10');
        else if (ch === ']' && focused?.module === 'media')
            s.act(focused.id, 'forward10');
        else if (ch === 'x' && focused)
            s.dismiss(focused.id);
        else if (ch === 'u')
            s.showHidden();
        else if (ch === 'c' && this._ctx.openPreferences)
            this._ctx.openPreferences();
        else if (ch === 'q')
            this._ctx.closeMenu();
        else
            return Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_STOP;
    }

    destroy() {
        this._cardBin.remove_all_transitions();
        this._card?.destroy();
        this.actor.destroy();
    }
}
