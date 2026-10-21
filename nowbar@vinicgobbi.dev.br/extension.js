import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NowbarService} from './lib/service.js';
import {NowbarIndicator} from './lib/ui/indicator.js';
import {LockScreenNowbar} from './lib/ui/lockscreen.js';
import {NowbarDBus} from './lib/dbus.js';
import {destroySession} from './lib/net.js';

const ROLE = 'nowbar';

// Enabled in the 'unlock-dialog' session mode too (metadata.json), for the
// pill on the lock screen: locking doesn't disable the extension, so the
// top bar's pill is taken down here while the session is locked and put
// back when it is unlocked.
export default class NowbarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._service = new NowbarService(this._settings);
        this._dbus = new NowbarDBus(this._service, {
            togglePopup: () => this._indicator?.togglePopup(),
            openPopup: () => this._indicator?.openPopup(),
            openPreferences: () => {
                if (!Main.sessionMode.isLocked)
                    this.openPreferences();
            },
        });
        // Moving the pill rebuilds it where it was asked for.
        this._placeIds = ['panel-box', 'panel-index'].map(k =>
            this._settings.connect(`changed::${k}`, () => {
                if (!this._indicator)
                    return;
                this._indicator.destroy();
                this._addIndicator();
            }));
        this._lockId = this._settings.connect('changed::lock-screen', () => this._syncMode());
        Main.sessionMode.connectObject('updated', () => this._syncMode(), this);
        this._syncMode();
    }

    _addIndicator() {
        this._indicator = new NowbarIndicator(this._service, () => this.openPreferences());
        const box = this._settings.get_string('panel-box');
        Main.panel.addToStatusArea(ROLE, this._indicator, this._settings.get_int('panel-index'), box);
    }

    _syncMode() {
        const locked = Main.sessionMode.isLocked;
        this._service.setLocked(locked);
        if (locked) {
            this._indicator?.destroy();
            this._indicator = null;
        } else if (!this._indicator) {
            this._addIndicator();
        }
        // On unlocking, the pill stays in the dialog while it slides away,
        // and goes with it.
        const dialog = locked && this._settings.get_boolean('lock-screen') ? Main.screenShield?._dialog : null;
        if (locked && this._lock?.dialog !== dialog) {
            this._lock?.destroy();
            this._lock = dialog ? new LockScreenNowbar(this._service, dialog, () => (this._lock = null)) : null;
        }
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        this._settings.disconnect(this._lockId);
        for (const id of this._placeIds ?? [])
            this._settings.disconnect(id);
        this._placeIds = null;
        this._dbus?.destroy();
        this._dbus = null;
        this._lock?.destroy();
        this._lock = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._service?.destroy();
        this._service = null;
        destroySession();
        this._settings = null;
    }
}
