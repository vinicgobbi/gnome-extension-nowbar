import Gio from 'gi://Gio';

// The Now Bar on the session bus, for scripts and keyboard shortcuts: what
// `omarchy-shell nowbar <method>` does on Omarchy.
//
//   gdbus call --session --dest br.dev.vinicgobbi.NowBar \
//     --object-path /br/dev/vinicgobbi/NowBar --method br.dev.vinicgobbi.NowBar.Next

export const BUS_NAME = 'br.dev.vinicgobbi.NowBar';
export const OBJECT_PATH = '/br/dev/vinicgobbi/NowBar';

const Iface = `
<node>
  <interface name="br.dev.vinicgobbi.NowBar">
    <method name="Next"><arg type="b" direction="out"/></method>
    <method name="Prev"><arg type="b" direction="out"/></method>
    <method name="Toggle"/>
    <method name="Focus"><arg type="s" name="id" direction="in"/><arg type="b" direction="out"/></method>
    <method name="Primary"><arg type="b" direction="out"/></method>
    <method name="Act">
      <arg type="s" name="activity" direction="in"/>
      <arg type="s" name="action" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
    <method name="Dismiss"><arg type="b" direction="out"/></method>
    <method name="Unhide"><arg type="b" direction="out"/></method>
    <method name="Weather"><arg type="b" direction="out"/></method>
    <method name="Settings"/>
    <method name="Push">
      <arg type="s" name="id" direction="in"/>
      <arg type="s" name="json" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="Remove"><arg type="s" name="id" direction="in"/><arg type="b" direction="out"/></method>
    <method name="Status"><arg type="s" direction="out"/></method>
  </interface>
</node>`;

export class NowbarDBus {
    // `ui` = {togglePopup(), openPopupOn(id), openPreferences()}
    constructor(service, ui) {
        this._service = service;
        this._ui = ui;
        this._impl = Gio.DBusExportedObject.wrapJSObject(Iface, this);
        this._impl.export(Gio.DBus.session, OBJECT_PATH);
        this._ownerId = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
            null, null, () => console.warn(`Now Bar: could not own ${BUS_NAME}`));
    }

    Next() {
        return this._service.step(1);
    }

    Prev() {
        return this._service.step(-1);
    }

    Toggle() {
        this._ui.togglePopup();
    }

    Focus(id) {
        return this._service.focusOn(id);
    }

    Primary() {
        const f = this._service.focused;
        return f ? this._service.primary(f.id) : false;
    }

    Act(activity, action) {
        return this._service.act(activity, action);
    }

    Dismiss() {
        const f = this._service.focused;
        // The camera/mic card only goes away with a click on it.
        return f && f.module !== 'privacy' ? this._service.dismiss(f.id) : false;
    }

    Unhide() {
        return this._service.showHidden();
    }

    Weather() {
        if (!this._service.focusOn('brief'))
            return false;
        this._ui.openPopup();
        return true;
    }

    Settings() {
        this._ui.openPreferences();
    }

    Push(id, json) {
        return this._service.push(id, json);
    }

    Remove(id) {
        return this._service.removePush(id);
    }

    Status() {
        return this._service.statusJson();
    }

    destroy() {
        Gio.bus_unown_name(this._ownerId);
        this._impl.unexport();
    }
}
