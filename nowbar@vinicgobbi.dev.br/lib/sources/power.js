import Gio from 'gi://Gio';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

// UPower's display device (the battery the system shows) and
// power-profiles-daemon, for the charging and low battery activities.

const DeviceIface = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Type" type="u" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="TimeToEmpty" type="x" access="read"/>
    <property name="TimeToFull" type="x" access="read"/>
  </interface>
</node>`;

const UPowerIface = `
<node>
  <interface name="org.freedesktop.UPower">
    <property name="OnBattery" type="b" access="read"/>
  </interface>
</node>`;

const ProfilesIface = `
<node>
  <interface name="org.freedesktop.UPower.PowerProfiles">
    <property name="ActiveProfile" type="s" access="readwrite"/>
  </interface>
</node>`;

const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(DeviceIface);
const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPowerIface);
const ProfilesProxy = Gio.DBusProxy.makeProxyWrapper(ProfilesIface);

const STATE_CHARGING = 1;
const STATE_FULL = 4;
const TYPE_BATTERY = 2;

export class PowerSource extends EventEmitter {
    constructor() {
        super();
        this._cancellable = new Gio.Cancellable();
        this._proxies = [];
        this._init().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Now Bar: UPower: ${e.message}`);
        });
    }

    async _watch(Wrapper, name, path) {
        const proxy = await Wrapper.newAsync(Gio.DBus.system, name, path, this._cancellable);
        const id = proxy.connect('g-properties-changed', () => this.emit('changed'));
        this._proxies.push([proxy, id]);
        return proxy;
    }

    async _init() {
        this._upower = await this._watch(UPowerProxy, 'org.freedesktop.UPower', '/org/freedesktop/UPower');
        this._device = await this._watch(DeviceProxy, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice');
        try {
            this._profiles = await this._watch(ProfilesProxy, 'org.freedesktop.UPower.PowerProfiles',
                '/org/freedesktop/UPower/PowerProfiles');
        } catch {
            this._profiles = null;
        }
        this.emit('changed');
    }

    // What Model.chargingActivity / batteryActivity take, or null with no battery.
    info() {
        const d = this._device;
        if (!d || !d.IsPresent || d.Type !== TYPE_BATTERY)
            return null;
        const profile = this._profiles?.ActiveProfile;
        return {
            present: true,
            charging: d.State === STATE_CHARGING,
            full: d.State === STATE_FULL,
            onBattery: !!this._upower?.OnBattery,
            percentage: (d.Percentage ?? 0) / 100,
            timeToFull: Number(d.TimeToFull ?? 0),
            timeToEmpty: Number(d.TimeToEmpty ?? 0),
            canPowerSave: typeof profile === 'string' && profile !== '',
            powerSaver: profile === 'power-saver',
        };
    }

    setPowerSaver() {
        if (this._profiles)
            this._profiles.ActiveProfile = 'power-saver';
    }

    destroy() {
        this._cancellable.cancel();
        for (const [proxy, id] of this._proxies)
            proxy.disconnect(id);
        this._proxies = [];
    }
}
