import GLib from 'gi://GLib';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import * as Model from './model.js';
import {launchUri, showInFolder, Timeout} from './util.js';
import {MprisSource} from './sources/mpris.js';
import {PowerSource} from './sources/power.js';
import {ModesSource} from './sources/modes.js';
import {PrivacySource} from './sources/privacy.js';
import {CaptureSource, copyImage, fileUri} from './sources/capture.js';
import {WeatherSource, rainNote} from './sources/weather.js';
import {ArtSource} from './sources/art.js';

// Collects every live source into one list of activities (see model.js) and
// keeps which one has the focus. A port of the Omarchy plugin's Service.qml:
// the same rules, with GNOME's own services as the sources. Emits 'changed'
// whenever the list, the focus or anything shown changes.

// Players: every one playing (playerctld's proxy only when no real player
// is), plus up to 3 that played this session and are paused now.
const MAX_PAUSED_CARDS = 3;
const MAX_PLAYING_CARDS = 6;
// After a switch by hand, newcomers don't take the pill for this long.
const MANUAL_MS = 8000;

function camel(key) {
    return key.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
}

export class NowbarService extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.prefs = this._readPrefs();
        this.now = Date.now();

        this.pushes = {};
        this.dismissed = {};
        this.heldOrder = [];
        this.focusId = '';
        this.knownIds = {};
        this.manualUntil = 0;
        this.popupOpen = false;
        // On the lock screen: nothing that opens a window or reaches the
        // session's files (see _lockSafe).
        this.locked = false;
        this.allActivities = [];
        this.activities = [];
        this.hiddenList = [];

        this._playedKeys = {};
        this._pausedAt = {};
        this._preferredMediaKey = '';

        this.mpris = new MprisSource();
        this.power = new PowerSource();
        this.modes = new ModesSource();
        this.privacy = new PrivacySource();
        this.capture = new CaptureSource();
        this.weather = new WeatherSource(settings);
        this.art = new ArtSource();
        this._sources = [this.mpris, this.power, this.modes, this.privacy, this.capture, this.weather, this.art];
        this._sourceIds = this._sources.map(s => s.connect('changed', () => {
            if (s === this.mpris)
                this._syncLastPlaying();
            this._queueUpdate();
        }));

        this._settingsId = settings.connect('changed', () => {
            this.prefs = this._readPrefs();
            this.weather.setEnabled(this.prefs.modules.weather);
            if (!this.prefs.modules.push)
                this.pushes = {};
            this._queueUpdate();
        });
        this.weather.setEnabled(this.prefs.modules.weather);

        this._ticker = new Timeout(1000, () => this._tick(), true);
        this._staleMedia = new Timeout(30000, () => this._releaseStaleMedia(), true);
        this._staleMedia.start();

        this._update();
    }

    // The settings, as the preference names NowbarModel.js knows.
    _readPrefs() {
        const raw = {};
        for (const key of this._settings.settings_schema.list_keys())
            raw[camel(key)] = this._settings.get_value(key).recursiveUnpack();
        const prefs = Model.normalizePrefs(raw);
        prefs.panelBox = raw.panelBox;
        prefs.panelIndex = raw.panelIndex;
        return prefs;
    }

    // --- media ---------------------------------------------------------------

    _syncLastPlaying() {
        const t = Date.now();
        const players = this.mpris.players;
        const alive = new Set(players.map(p => p.key));
        const played = {};
        const paused = {};
        for (const k in this._playedKeys) {
            if (alive.has(k))
                played[k] = this._playedKeys[k];
        }
        for (const p of players) {
            if (p.playing && !p.isProxy && p.hasTrack())
                played[p.key] = t;
            else if (!p.playing)
                paused[p.key] = this._pausedAt[p.key] ?? t;
        }
        this._playedKeys = played;
        this._pausedAt = paused;
    }

    _isIgnored(p) {
        return Model.isIgnoredPlayer(this.prefs.ignoredPlayers, [p.identity, p.desktopEntry, p.busName]);
    }

    get mediaPlayers() {
        let playing = [];
        const proxies = [];
        const paused = [];
        for (const p of this.mpris.players) {
            if (!p.hasTrack() || this._isIgnored(p))
                continue;
            if (p.playing)
                (p.isProxy ? proxies : playing).push(p);
            else if (!p.isProxy && this._playedKeys[p.key] !== undefined)
                paused.push(p);
        }
        if (playing.length === 0)
            playing = proxies.slice(0, 1);
        playing = playing.slice(0, MAX_PLAYING_CARDS);
        paused.sort((a, b) => this._playedKeys[b.key] - this._playedKeys[a.key]);
        return playing.concat(paused.slice(0, MAX_PAUSED_CARDS));
    }

    // Names of the players around now, for the options' list.
    get playerNames() {
        const out = [];
        for (const p of this.mpris.players) {
            const n = (p.identity || p.desktopEntry || '').trim();
            if (n && !p.isProxy && !out.includes(n))
                out.push(n);
        }
        return out;
    }

    pauseAllMedia() {
        for (const p of this.mpris.players) {
            if (p.playing)
                p.pause();
        }
    }

    _mediaAction(key, action) {
        const p = this.mpris.player(key);
        if (!p)
            return;
        this._preferredMediaKey = key;
        const info = p.info();
        if (action === 'playPause')
            p.playPause();
        else if (action === 'next')
            p.next();
        else if (action === 'previous')
            p.previous();
        else if (action === 'back10')
            p.seekBy(-10);
        else if (action === 'forward10')
            p.seekBy(10);
        else if (action === 'shuffle')
            p.toggleShuffle();
        else if (action === 'loop')
            p.setLoop(Model.nextLoop(info.loop));
        else if (action === 'raise')
            p.raise();
    }

    // The seek bar and volume slider of a media card; `fraction` is 0..1.
    seek(activityId, fraction) {
        const a = this._find(activityId);
        if (!a || a.module !== 'media' || !a.seekable)
            return;
        this.mpris.player(a.target)?.seekTo(fraction * a.length);
    }

    setVolume(activityId, value) {
        const a = this._find(activityId);
        if (a && a.module === 'media' && a.volume >= 0)
            this.mpris.player(a.target)?.setVolume(value);
    }

    // A paused player that has had the pill for a while gives it to the most
    // important other activity; it stays in the carousel.
    _releaseStaleMedia() {
        const a = this.focused;
        const t = Date.now();
        const minutes = this.prefs.mediaPausedMinutes;
        if (!a || t < this.manualUntil || this.popupOpen || !Model.staleMedia(a, this._pausedAt[a.target], t, minutes))
            return;
        const next = this.activities.find(b => b.id !== a.id && !Model.staleMedia(b, this._pausedAt[b.target], t, minutes));
        if (next) {
            this.focusId = next.id;
            this._update();
        }
    }

    _freshenMedia(a) {
        if (a && a.module === 'media' && !a.playing && this._pausedAt[a.target] !== undefined)
            this._pausedAt[a.target] = Date.now();
    }

    // --- pushed by scripts -------------------------------------------------

    push(id, json) {
        // Off in the options: nothing is kept (or ticks) for it.
        if (!this.prefs.modules.push)
            return 'scripts are turned off in the Now Bar options';
        const r = Model.sanitizePush(id, json, Date.now());
        if (!r.ok)
            return r.error;
        this.pushes = Model.upsertPush(this.pushes, r.item);
        this._update();
        return 'ok';
    }

    removePush(id) {
        if (!(id in this.pushes))
            return false;
        const next = {...this.pushes};
        delete next[id];
        this.pushes = next;
        this._update();
        return true;
    }

    // --- the list -------------------------------------------------------------

    // Actions the Omarchy model offers that mean something else (or nothing)
    // on GNOME.
    _gnomeActions(a) {
        if (a.id === 'screenshot') {
            a.actions = [
                {id: 'open', label: 'Open', icon: '\u{f03cc}', opensApp: true},
                {id: 'copy', label: 'Copy', icon: '\u{f018f}'},
                {id: 'folder', label: 'Folder', icon: '\u{f0770}', opensApp: true},
            ];
        } else if (a.id === 'recorded') {
            a.actions = a.actions.filter(x => x.id !== 'copy');
        }
        return a;
    }

    _collect() {
        const t = this.now;
        let list = [];
        list.push(Model.recordingActivity(this.capture.recording, t));
        if (this.capture.recorded)
            list.push(this._gnomeActions(Model.recordedActivity(this.capture.recorded)));
        if (this.capture.screenshot)
            list.push(this._gnomeActions(Model.screenshotActivity(this.capture.screenshot)));
        list.push(Model.privacyActivity(this.privacy.info(Model.cameraAppNames)));
        list.push(Model.modesActivity(this.modes.info()));
        const power = this.power.info();
        list.push(Model.chargingActivity(power));
        list.push(Model.batteryActivity(power));
        for (const p of this.mediaPlayers) {
            const info = p.info();
            const a = Model.mediaActivity(info);
            if (!a)
                continue;
            // The card shows where the sound comes from (app icon and name)
            // and the artist on a line of its own.
            a.playerName = Model.clean(info.player, 40);
            a.desktopEntry = p.desktopEntry;
            a.artist = Model.clean(info.artist);
            // The pill shows the song alone; the artist is on the card.
            a.pillText = a.title;
            a.art = this.prefs.modules.media ? this.art.get(p.artUrl) : null;
            if (this.prefs.coverAccent && a.art?.accent) {
                a.color = a.art.accent;
                a.surface = a.art.base;
            }
            list.push(a);
        }
        if (this.prefs.modules.weather) {
            const w = this.weather.weather(t);
            const age = Model.weatherAge(this.weather.fetchedAt, t);
            const card = Model.weatherActivity(w, false);
            if (card) {
                card.age = age;
                card.fetching = this.weather.fetching;
                card.rain = rainNote(w, age.stale);
                if (card.rain)
                    card.pillText = `${w.temp}° · ${card.rain.pill}`;
                if (!this.prefs.coverAccent)
                    delete card.color;
            }
            list.push(card);
        }
        for (const k in this.pushes)
            list.push(Model.pushActivity(this.pushes[k], t));
        list = list.filter(a => !!a);
        return this.locked ? list.map(a => this._lockSafe(a)) : list;
    }

    // What the lock screen may do with an activity: no action that opens an
    // app or a folder (it would open behind the lock), no copying a
    // screenshot, no raising a player. act() only runs the actions left.
    _lockSafe(a) {
        a.actions = a.actions.filter(x => !x.opensApp && x.id !== 'copy');
        a.canRaise = false;
        return a;
    }

    setLocked(locked) {
        if (this.locked === locked)
            return;
        this.locked = locked;
        this._update();
    }

    _queueUpdate() {
        if (this._queued)
            return;
        this._queued = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._queued = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        this.allActivities = this._collect();
        const pruned = Model.pruneDismissed(this.dismissed, this.allActivities);
        if (pruned !== this.dismissed)
            this.dismissed = pruned;
        this.activities = Model.keepOrder(Model.visibleActivities(this.allActivities, this.prefs, this.dismissed), this.heldOrder);
        this.hiddenList = Model.hiddenActivities(this.allActivities, this.prefs, this.dismissed);

        const now = Date.now();
        this.focusId = Model.resolveFocus({
            list: this.activities,
            focusId: this.focusId,
            knownIds: this.knownIds,
            autoFocus: this.prefs.autoFocus,
            onlyAlerts: this.heldOrder.length > 0,
            manualUntil: this.manualUntil,
            now,
        });
        this._preferPlaying(now);
        this._rememberKnown(now);
        this._ticker.setRunning(this._needsTick());
        this.emit('changed');
    }

    // Whether newcomers can't take the pill right now: just after a switch
    // by hand, or while the popup is open (only alerts move the card then).
    _holding(now) {
        return now < this.manualUntil || this.heldOrder.length > 0;
    }

    // What the next update compares against to spot newcomers. One that
    // couldn't take the pill because of a hold stays a newcomer, so it takes
    // the pill once the hold is over (a player that started playing while
    // you were scrolling, or with the popup open), instead of being taken
    // for known and never showing up.
    _rememberKnown(now) {
        const held = this.prefs.autoFocus && this._holding(now);
        const ids = {};
        let pending = false;
        for (const a of this.activities) {
            const known = this.knownIds[a.id];
            if (held && a.id !== this.focusId && (known === undefined || a.priority < known)) {
                pending = true;
                if (known !== undefined)
                    ids[a.id] = known;
            } else {
                ids[a.id] = a.priority;
            }
        }
        this.knownIds = ids;
        // Nothing else may update once the switch by hand wears off (all
        // players paused: no ticking), so look again then.
        if (this._pendingId)
            GLib.source_remove(this._pendingId);
        this._pendingId = 0;
        if (pending && now < this.manualUntil) {
            this._pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.manualUntil - now + 50, () => {
                this._pendingId = 0;
                this._update();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // A paused player doesn't keep the pill while another one plays: the
    // one playing takes it (unless you just picked the paused one by hand,
    // or the popup is open).
    _preferPlaying(now) {
        const f = this.focused;
        if (!this.prefs.autoFocus || !f || f.module !== 'media' || f.playing || this._holding(now))
            return;
        const playing = this.activities.find(a => a.module === 'media' && a.playing);
        if (playing)
            this.focusId = playing.id;
    }

    _needsTick() {
        const s = this;
        return s.capture.recording.active || s.capture.hasCards ||
            Object.keys(s.pushes).length > 0 ||
            s.mpris.players.some(p => p.playing);
    }

    // Once a second: the players' positions are asked for, and the list
    // updated once they're all in (not once now and again per answer).
    _tick() {
        const asked = this.mpris.players.filter(p => p.playing).map(p => p.refreshPosition(true));
        Promise.all(asked).then(() => {
            if (this._destroyed)
                return;
            this.now = Date.now();
            this.capture.prune(this.now);
            this.pushes = Model.prunePushes(this.pushes, this.now);
            this._update();
        });
    }

    get focusIndex() {
        return Model.indexOfId(this.activities, this.focusId);
    }

    get focused() {
        const i = this.focusIndex;
        return i >= 0 ? this.activities[i] : null;
    }

    _find(id) {
        return this.allActivities.find(a => a.id === id) ?? null;
    }

    // While the popup is open the carousel keeps its order and only alerts
    // move the card being read.
    setPopupOpen(open) {
        this.popupOpen = open;
        this.heldOrder = open ? this.activities.map(a => a.id) : [];
        if (open)
            this.weather.refreshIfStale();
        this._update();
    }

    step(delta) {
        const i = Model.nextIndex(this.activities.length, this.focusIndex, delta);
        if (i < 0)
            return false;
        this.focusId = this.activities[i].id;
        this.manualUntil = Date.now() + MANUAL_MS;
        this._freshenMedia(this.activities[i]);
        this._update();
        return true;
    }

    // An activity id, or a module name / push id ("media" is the focused
    // media card if there is one, else the first).
    resolveId(idOrModule) {
        const key = String(idOrModule || '');
        const list = this.activities;
        if (list.some(a => a.id === key))
            return key;
        if (this.focused?.module === key)
            return this.focused.id;
        return list.find(a => a.module === key || a.id === `push:${key}`)?.id ?? '';
    }

    focusOn(idOrModule) {
        const id = this.resolveId(idOrModule);
        if (!id)
            return false;
        this.focusId = id;
        this.manualUntil = Date.now() + MANUAL_MS;
        this._freshenMedia(this._find(id));
        this._update();
        return true;
    }

    dismiss(activityId) {
        const a = this.activities.find(x => x.id === activityId);
        // The camera/mic card only goes away by its own buttons (mute,
        // or the app letting go): never hidden by a key, a click or D-Bus.
        if (!a || a.ambient || a.module === 'privacy')
            return false;
        if (a.module === 'push')
            return this.removePush(a.id.slice(5));
        this.dismissed = {...this.dismissed, [a.id]: a.signature};
        this._update();
        return true;
    }

    showHidden() {
        const first = this.hiddenList[0]?.id;
        if (!first)
            return false;
        this.dismissed = {};
        this.focusId = first;
        this.manualUntil = Date.now() + MANUAL_MS;
        this._update();
        return true;
    }

    _offers(activityId, actionId) {
        return !!this._find(activityId)?.actions.some(x => x.id === actionId);
    }

    // Runs one of an activity's actions (the ids from model.js).
    act(activityId, actionId) {
        activityId = this.resolveId(activityId) || activityId;
        if (!this._offers(activityId, actionId))
            return false;
        const a = this._find(activityId);
        if (activityId === 'screenshot') {
            const path = this.capture.screenshot?.path;
            if (!path)
                return false;
            if (actionId === 'open')
                launchUri(fileUri(path));
            else if (actionId === 'copy')
                copyImage(path, St);
            else if (actionId === 'folder')
                showInFolder(path);
            return true;
        } else if (activityId === 'recorded') {
            const path = this.capture.recorded?.path;
            if (!path)
                return false;
            if (actionId === 'open')
                launchUri(fileUri(path));
            else if (actionId === 'folder')
                showInFolder(path);
            return true;
        } else if (activityId === 'recording' && actionId === 'stop') {
            this.capture.stopRecording();
            return true;
        } else if (activityId === 'battery' && actionId === 'powerSaver') {
            this.power.setPowerSaver();
            return true;
        } else if (activityId === 'privacy' && (actionId === 'muteMic' || actionId === 'unmuteMic')) {
            this.privacy.setMicMuted(actionId === 'muteMic');
            return true;
        } else if (activityId === 'modes') {
            if (actionId === 'dnd')
                this.modes.setDnd(false);
            else if (actionId === 'nightlight')
                this.modes.turnOffNightlight();
            return true;
        } else if (a?.module === 'media') {
            this._mediaAction(a.target, actionId);
            return true;
        } else if (activityId.startsWith('push:') && actionId === 'remove') {
            return this.removePush(activityId.slice(5));
        }
        return false;
    }

    // The primary action: middle click on the pill, Enter in the popup.
    primary(activityId) {
        const a = this.activities.find(x => x.id === activityId);
        return a && a.actions.length > 0 ? this.act(a.id, a.actions[0].id) : false;
    }

    // --- status (D-Bus Status) ----------------------------------------------

    statusJson() {
        return JSON.stringify({
            focused: this.focusId,
            count: this.activities.length,
            activities: this.activities.map(a => ({
                id: a.id, module: a.module, title: a.title, subtitle: a.subtitle, pill: a.pillText,
                progress: a.progress, urgent: !!a.urgent, actions: a.actions.map(x => x.id),
            })),
            hidden: this.hiddenList.map(a => a.id),
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._queued)
            GLib.source_remove(this._queued);
        if (this._pendingId)
            GLib.source_remove(this._pendingId);
        this._ticker.stop();
        this._staleMedia.stop();
        this._settings.disconnect(this._settingsId);
        this._sources.forEach((s, i) => {
            s.disconnect(this._sourceIds[i]);
            s.destroy();
        });
    }
}
