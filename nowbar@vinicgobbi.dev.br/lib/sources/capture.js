import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GNOME's own screenshot UI: a screen recording going on, a screenshot just
// taken, a recording just saved.

export class CaptureSource extends EventEmitter {
    constructor() {
        super();
        this._ui = Main.screenshotUI;
        this.recording = {active: false, startedAt: 0};
        this.screenshot = null; // {path, name, until}
        this.recorded = null;   // {path, name, until}
        this._ids = [
            this._ui.connect('notify::screencast-in-progress', () => this._onScreencast()),
            this._ui.connect('screenshot-taken', (ui, file) => this._onScreenshot(file)),
        ];
        this._onScreencast();
    }

    _onScreencast() {
        const active = !!this._ui.screencast_in_progress;
        if (active === this.recording.active)
            return;
        this.recording = {active, startedAt: active ? Date.now() : 0};
        if (!active) {
            // The shell keeps where the video went in a private field; read
            // it once the recorder had time to finish the file. Best effort:
            // without it there is simply no "Recording saved" card.
            if (this._savedId)
                GLib.source_remove(this._savedId);
            this._savedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                this._savedId = 0;
                const path = this._ui._screencastPath;
                if (typeof path === 'string' && GLib.file_test(path, GLib.FileTest.IS_REGULAR)) {
                    this.recorded = {path, name: GLib.path_get_basename(path), until: Date.now() + 20000};
                    this.emit('changed');
                }
                return GLib.SOURCE_REMOVE;
            });
        }
        this.emit('changed');
    }

    _onScreenshot(file) {
        const path = file?.get_path();
        if (!path)
            return;
        this.screenshot = {path, name: GLib.path_get_basename(path), until: Date.now() + 15000};
        this.emit('changed');
    }

    // Drops the cards whose few seconds are up; true when one went away.
    prune(now) {
        let changed = false;
        if (this.screenshot && this.screenshot.until <= now) {
            this.screenshot = null;
            changed = true;
        }
        if (this.recorded && this.recorded.until <= now) {
            this.recorded = null;
            changed = true;
        }
        return changed;
    }

    get hasCards() {
        return !!(this.screenshot || this.recorded);
    }

    clearScreenshot() {
        this.screenshot = null;
        this.emit('changed');
    }

    clearRecorded() {
        this.recorded = null;
        this.emit('changed');
    }

    startRecording() {
        this._ui.open(1 /* UIMode.SCREENCAST */).catch(e => console.warn(`Now Bar: ${e.message}`));
    }

    stopRecording() {
        this._ui.stopScreencast();
    }

    destroy() {
        for (const id of this._ids)
            this._ui.disconnect(id);
        if (this._savedId)
            GLib.source_remove(this._savedId);
    }
}

// Puts a PNG/JPEG on the clipboard as an image.
export function copyImage(path, St) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        const type = /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, type, new GLib.Bytes(bytes));
        return true;
    } catch (e) {
        console.warn(`Now Bar: copy ${path}: ${e.message}`);
        return false;
    }
}

export function fileUri(path) {
    return Gio.File.new_for_path(path).get_uri();
}
