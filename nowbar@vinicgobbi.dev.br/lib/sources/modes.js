import Gio from 'gi://Gio';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

// Do Not Disturb and night light: GNOME's own settings, switched from its
// Quick Settings. The Now Bar shows them while they are on, with a button
// to turn them off.
//   - Do Not Disturb is org.gnome.desktop.notifications show-banners (off).
//   - Night light is the color plugin's switch; it counts as on while the
//     settings daemon says it is actually tinting the screen.

const ColorIface = `
<node>
  <interface name="org.gnome.SettingsDaemon.Color">
    <property name="NightLightActive" type="b" access="read"/>
    <property name="DisabledUntilTomorrow" type="b" access="readwrite"/>
  </interface>
</node>`;

const ColorProxy = Gio.DBusProxy.makeProxyWrapper(ColorIface);

export class ModesSource extends EventEmitter {
    constructor() {
        super();
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._color = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        this._ids = [
            [this._notifications, this._notifications.connect('changed::show-banners', () => this.emit('changed'))],
            [this._color, this._color.connect('changed::night-light-enabled', () => this.emit('changed'))],
        ];
        this._cancellable = new Gio.Cancellable();
        ColorProxy.newAsync(Gio.DBus.session, 'org.gnome.SettingsDaemon.Color',
            '/org/gnome/SettingsDaemon/Color', this._cancellable).then(proxy => {
            this._colorProxy = proxy;
            this._colorId = proxy.connect('g-properties-changed', () => this.emit('changed'));
            this.emit('changed');
        }).catch(() => {});
    }

    get dnd() {
        return !this._notifications.get_boolean('show-banners');
    }

    get nightlight() {
        if (!this._color.get_boolean('night-light-enabled'))
            return false;
        const active = this._colorProxy?.NightLightActive;
        return typeof active === 'boolean' ? active : true;
    }

    // What Model.modesActivity takes.
    info() {
        return {dnd: this.dnd, stayAwake: false, nightlight: this.nightlight, vpns: []};
    }

    setDnd(on) {
        this._notifications.set_boolean('show-banners', !on);
    }

    // Turning it off while it is active only pauses it until tomorrow, the
    // way the Quick Settings toggle does.
    turnOffNightlight() {
        if (this._colorProxy)
            this._colorProxy.DisabledUntilTomorrow = true;
        else
            this._color.set_boolean('night-light-enabled', false);
    }

    destroy() {
        this._cancellable.cancel();
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
        if (this._colorId)
            this._colorProxy.disconnect(this._colorId);
    }
}
