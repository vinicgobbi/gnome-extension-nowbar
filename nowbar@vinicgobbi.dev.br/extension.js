import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NowbarService} from './lib/service.js';
import {NowbarIndicator} from './lib/ui/indicator.js';
import {NowbarDBus} from './lib/dbus.js';
import {destroySession} from './lib/net.js';

const ROLE = 'nowbar';

export default class NowbarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._service = new NowbarService(this._settings);
        this._addIndicator();
        this._dbus = new NowbarDBus(this._service, {
            togglePopup: () => this._indicator?.togglePopup(),
            openPopup: () => this._indicator?.openPopup(),
            openPreferences: () => this.openPreferences(),
        });
        // Moving the pill rebuilds it where it was asked for.
        this._placeIds = ['panel-box', 'panel-index'].map(k =>
            this._settings.connect(`changed::${k}`, () => {
                this._indicator?.destroy();
                this._addIndicator();
            }));
    }

    _addIndicator() {
        this._indicator = new NowbarIndicator(this._service, () => this.openPreferences());
        const box = this._settings.get_string('panel-box');
        Main.panel.addToStatusArea(ROLE, this._indicator, this._settings.get_int('panel-index'), box);
    }

    disable() {
        for (const id of this._placeIds ?? [])
            this._settings.disconnect(id);
        this._placeIds = null;
        this._dbus?.destroy();
        this._dbus = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._service?.destroy();
        this._service = null;
        destroySession();
        this._settings = null;
    }
}
