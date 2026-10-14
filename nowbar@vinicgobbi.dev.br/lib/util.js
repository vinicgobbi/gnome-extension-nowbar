import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function cacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'nowbar-gnome']);
}

export function launchUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        return true;
    } catch (e) {
        console.warn(`Now Bar: could not open ${uri}: ${e.message}`);
        return false;
    }
}

// Shows `file` in the file manager, selected when the file manager can do
// that (Nautilus's FileManager1 interface), else opens its folder.
export function showInFolder(path) {
    const uri = Gio.File.new_for_path(path).get_uri();
    Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[uri], '']),
        null, Gio.DBusCallFlags.NONE, 2000, null, (conn, res) => {
            try {
                conn.call_finish(res);
            } catch {
                launchUri(Gio.File.new_for_path(GLib.path_get_dirname(path)).get_uri());
            }
        });
}

// A GLib timeout that is easy to restart and to clean up.
export class Timeout {
    constructor(ms, callback, repeat = false) {
        this._ms = ms;
        this._callback = callback;
        this._repeat = repeat;
        this._id = 0;
    }

    get running() {
        return this._id !== 0;
    }

    start() {
        if (this._id)
            return;
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._ms, () => {
            if (!this._repeat)
                this._id = 0;
            this._callback();
            return this._repeat ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    restart() {
        this.stop();
        this.start();
    }

    stop() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
    }

    setRunning(on) {
        if (on)
            this.start();
        else
            this.stop();
    }
}
