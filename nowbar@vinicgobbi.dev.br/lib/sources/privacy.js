import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

// Camera and microphone in use. The microphone comes from the shell's own
// mixer (the apps recording, and whether the default input is muted); the
// camera from Shell.CameraMonitor, the same thing the system's camera
// indicator follows. Which app holds the camera is read from /proc (only
// this user's processes, no root), when the camera turns on.

// Apps that show the input level, so they always "record"; same list as
// the shell's volume indicator.
const SKIPPED_APPS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

function videoUsers() {
    const names = [];
    let dir;
    try {
        dir = GLib.Dir.open('/proc', 0);
    } catch {
        return names;
    }
    let pid;
    while ((pid = dir.read_name()) !== null) {
        if (!/^\d+$/.test(pid))
            continue;
        let fds;
        try {
            fds = GLib.Dir.open(`/proc/${pid}/fd`, 0);
        } catch {
            continue; // someone else's process
        }
        let fd, uses = false;
        while (!uses && (fd = fds.read_name()) !== null) {
            try {
                uses = /^\/dev\/video\d+$/.test(GLib.file_read_link(`/proc/${pid}/fd/${fd}`));
            } catch {}
        }
        fds.close();
        if (!uses)
            continue;
        try {
            const [, comm] = GLib.file_get_contents(`/proc/${pid}/comm`);
            names.push(new TextDecoder().decode(comm).trim());
        } catch {}
    }
    dir.close();
    return names;
}

export class PrivacySource extends EventEmitter {
    constructor() {
        super();
        this._control = Volume.getMixerControl();
        this._controlIds = [
            this._control.connect('stream-added', () => this._sync()),
            this._control.connect('stream-removed', () => this._sync()),
            this._control.connect('default-source-changed', () => this._watchSource()),
        ];
        this._watchSource();

        this._camera = new Shell.CameraMonitor();
        this._cameraApps = [];
        this._cameraId = this._camera.connect('notify::cameras-in-use', () => this._onCamera());
        this._onCamera();
    }

    _watchSource() {
        if (this._source && this._sourceId)
            this._source.disconnect(this._sourceId);
        this._source = this._control.get_default_source();
        this._sourceId = this._source?.connect('notify::is-muted', () => this._sync()) ?? 0;
        this._sync();
    }

    _onCamera() {
        if (this._idle)
            GLib.source_remove(this._idle);
        // Off the signal handler: reading /proc takes a moment.
        this._idle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._idle = 0;
            this._cameraApps = this.cameraActive ? videoUsers() : [];
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        this.emit('changed');
    }

    get cameraActive() {
        return !!this._camera.cameras_in_use;
    }

    get micApps() {
        return this._control.get_source_outputs()
            .filter(o => !SKIPPED_APPS.includes(o.get_application_id()))
            .map(o => o.get_name() || o.get_application_id() || 'App')
            .filter(n => n);
    }

    // What Model.privacyActivity takes; PipeWire's daemons are left out of
    // the camera's names by Model.cameraAppNames.
    info(cameraAppNames) {
        return {
            micApps: this.micApps,
            micMuted: !!this._source?.is_muted,
            cameraActive: this.cameraActive,
            cameraApps: cameraAppNames(this._cameraApps),
        };
    }

    setMicMuted(muted) {
        this._source?.change_is_muted(muted);
    }

    destroy() {
        for (const id of this._controlIds)
            this._control.disconnect(id);
        if (this._sourceId)
            this._source.disconnect(this._sourceId);
        this._camera.disconnect(this._cameraId);
        this._camera = null;
        if (this._idle)
            GLib.source_remove(this._idle);
    }
}
