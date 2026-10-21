import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as Model from '../model.js';
import {Pill, ScrollStepper} from './pill.js';
import {PopupContent} from './popup.js';

// The pill in the top bar (see pill.js); progress is left to the popup.
// Left click opens the popup, scroll switches, middle click runs the main
// action, right click hides the activity until it changes.

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

        this._pill = new Pill(service);
        this._scroll = new ScrollStepper(delta => {
            this._pill.direction = delta;
            service.step(delta);
        });
        this.add_child(this._pill.actor);

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
            this._syncLit();
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
        // A tinted pill lights up a little under the pointer, as the others.
        this.connect('notify::hover', () => this._syncLit());

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
            if (f)
                this._service.dismiss(f.id);
        } else {
            this.menu.toggle();
        }
    }

    vfunc_scroll_event(event) {
        return this._scroll.handle(event);
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
        this._pill.setOnLight(0.299 * c.red + 0.587 * c.green + 0.114 * c.blue < 128);
    }

    _syncLit() {
        this._pill.setLit(this.hover || this.menu.isOpen);
    }

    _sync() {
        const s = this._service;
        const a = this._pillActivity();
        this.visible = !!a || s.prefs.whenEmpty !== 'hide' || this.menu.isOpen;
        this._pill.show(a);
        this.accessible_name = Model.tooltipLabel(a, s.focusIndex, s.activities.length);
        if (this.menu.isOpen)
            this._content.update();
    }

    _onDestroy() {
        this._service.disconnect(this._changedId);
        this._pill.destroy();
        this._content.destroy();
        super._onDestroy();
    }
});
