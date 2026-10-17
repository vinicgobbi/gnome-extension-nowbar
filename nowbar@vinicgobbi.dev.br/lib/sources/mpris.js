import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

// Every MPRIS player on the session bus, as plain objects the service turns
// into media activities (see Model.mediaActivity). MPRIS doesn't push the
// position, so the service asks for it (refreshPositions) once a second while
// something plays.

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

const RootIface = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const PlayerIface = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek"><arg direction="in" type="x" name="Offset"/></method>
    <method name="SetPosition">
      <arg direction="in" type="o" name="TrackId"/>
      <arg direction="in" type="x" name="Position"/>
    </method>
    <signal name="Seeked"><arg type="x" name="Position"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

const RootProxy = Gio.DBusProxy.makeProxyWrapper(RootIface);
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);

function unpack(v) {
    return v instanceof GLib.Variant ? v.recursiveUnpack() : v;
}

class Player extends EventEmitter {
    constructor(busName) {
        super();
        this.busName = busName;
        this.position = 0;
        this._cancellable = new Gio.Cancellable();
        this._ready = false;
        this._init().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Now Bar: MPRIS ${busName}: ${e.message}`);
        });
    }

    async _init() {
        const flags = Gio.DBusProxyFlags.NONE;
        this._root = await RootProxy.newAsync(Gio.DBus.session, this.busName, MPRIS_PATH, this._cancellable, flags);
        this._player = await PlayerProxy.newAsync(Gio.DBus.session, this.busName, MPRIS_PATH, this._cancellable, flags);
        this._propsId = this._player.connect('g-properties-changed', (proxy, changed, invalidated) => {
            const keys = Object.keys(changed.deepUnpack()).concat(invalidated);
            if (keys.includes('Metadata'))
                this._metadata = null;
            if (keys.includes('Metadata') || keys.includes('PlaybackStatus'))
                this.refreshPosition();
            this.emit('changed');
        });
        this._seekedId = this._player.connectSignal('Seeked', (proxy, sender, [pos]) => {
            this._setPosition(Number(pos) / 1e6);
            this.emit('changed');
        });
        this._ready = true;
        this.refreshPosition();
        this.emit('changed');
    }

    get ready() {
        return this._ready;
    }

    get identity() {
        return this._root?.Identity ?? '';
    }

    get desktopEntry() {
        return this._root?.DesktopEntry ?? '';
    }

    // What the service and the model know players by.
    get key() {
        return this.busName;
    }

    get isProxy() {
        return this.busName.toLowerCase().includes('playerctld');
    }

    get playing() {
        return this._player?.PlaybackStatus === 'Playing';
    }

    // Unpacked once per change: it is read several times a second.
    get metadata() {
        if (this._metadata)
            return this._metadata;
        const m = this._player?.Metadata;
        if (!m)
            return {};
        const out = {};
        for (const [k, v] of Object.entries(m))
            out[k] = unpack(v);
        this._metadata = out;
        return out;
    }

    // The track's length in seconds, 0 when unknown. Firefox drops
    // mpris:length from the metadata after a seek (until play or pause),
    // which would take the seek bar away: the same track keeps the last
    // length it had.
    get length() {
        const m = this.metadata;
        const track = [m['mpris:trackid'], m['xesam:title'], m['xesam:url']].join('\u0000');
        const length = Number(m['mpris:length'] ?? 0) / 1e6;
        if (length > 0) {
            this._known = {track, length};
            return length;
        }
        return this._known?.track === track ? this._known.length : 0;
    }

    // Firefox after a seek: no length in the metadata, and Position reads 0.
    // Only the Seeked signal had it right.
    get _lostPosition() {
        return !(Number(this.metadata['mpris:length'] ?? 0) > 0) && this.length > 0;
    }

    // Where the track is, and when that was, to count on from there while
    // the player can't tell.
    _setPosition(pos) {
        this.position = pos;
        this._positionAt = GLib.get_monotonic_time();
    }

    _estimatedPosition() {
        const elapsed = this.playing && this._positionAt ? (GLib.get_monotonic_time() - this._positionAt) / 1e6 : 0;
        return Math.min(this.length, this.position + elapsed);
    }

    get artUrl() {
        const url = this.metadata['mpris:artUrl'];
        return typeof url === 'string' ? url : '';
    }

    // The plain object Model.mediaActivity() takes.
    info() {
        const p = this._player;
        const m = this.metadata;
        const artist = Array.isArray(m['xesam:artist']) ? m['xesam:artist'].slice(0, 8).join(', ')
            : String(m['xesam:artist'] ?? '');
        const length = this.length;
        const canControl = p.CanControl !== false;
        const loop = p.LoopStatus;
        return {
            key: this.key,
            title: String(m['xesam:title'] ?? ''),
            artist,
            album: String(m['xesam:album'] ?? ''),
            player: this.identity || this.desktopEntry || '',
            playing: this.playing,
            canToggle: !!(p.CanPlay || p.CanPause),
            canPrevious: !!p.CanGoPrevious,
            canNext: !!p.CanGoNext,
            canSeek: !!p.CanSeek && length > 0,
            position: this.position,
            length: length > 0 ? length : 0,
            volumeSupported: typeof p.Volume === 'number' && canControl,
            volume: typeof p.Volume === 'number' ? p.Volume : 0,
            shuffleSupported: typeof p.Shuffle === 'boolean' && canControl,
            shuffle: !!p.Shuffle,
            loopSupported: typeof loop === 'string' && canControl,
            loop: loop === 'Track' ? 'track' : (loop === 'Playlist' ? 'playlist' : 'none'),
            canRaise: !!this._root?.CanRaise,
        };
    }

    hasTrack() {
        if (!this._ready)
            return false;
        const m = this.metadata;
        return !!(m['xesam:title'] || (Array.isArray(m['xesam:artist']) ? m['xesam:artist'].length : m['xesam:artist']));
    }

    // Asks the player where it is. Resolves once it answered (or didn't);
    // `quiet` leaves telling anyone to the caller.
    refreshPosition(quiet = false) {
        if (!this._ready)
            return Promise.resolve();
        return new Promise(resolve => {
            Gio.DBus.session.call(this.busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
                null, Gio.DBusCallFlags.NONE, 500, this._cancellable, (conn, res) => {
                    try {
                        const [v] = conn.call_finish(res).deepUnpack();
                        const lost = this._lostPosition;
                        const pos = lost ? this._estimatedPosition() : Number(v.unpack()) / 1e6;
                        if (pos !== this.position) {
                            this._setPosition(pos);
                            if (!quiet)
                                this.emit('changed');
                        }
                    } catch {
                        // Not every player has a position.
                    }
                    resolve();
                });
        });
    }

    playPause() {
        const p = this._player;
        if (!p)
            return;
        if (p.CanPlay && p.CanPause)
            p.PlayPauseAsync().catch(() => {});
        else if (this.playing && p.CanPause)
            p.PauseAsync().catch(() => {});
        else if (p.CanPlay)
            p.PlayAsync().catch(() => {});
    }

    play() {
        this._player?.PlayAsync().catch(() => {});
    }

    pause() {
        this._player?.PauseAsync().catch(() => {});
    }

    next() {
        if (this._player?.CanGoNext)
            this._player.NextAsync().catch(() => {});
    }

    previous() {
        if (this._player?.CanGoPrevious)
            this._player.PreviousAsync().catch(() => {});
    }

    // Seconds from the start, clamped to the track.
    seekTo(seconds) {
        const p = this._player;
        const m = this.metadata;
        const len = this.length;
        if (!p?.CanSeek || !(len > 0))
            return;
        const to = Math.max(0, Math.min(len - 1, seconds));
        const trackId = m['mpris:trackid'];
        if (typeof trackId === 'string' && trackId.startsWith('/'))
            p.SetPositionAsync(trackId, Math.round(to * 1e6)).catch(() => {});
        else
            p.SeekAsync(Math.round((to - this.position) * 1e6)).catch(() => {});
        this._setPosition(to);
        this.emit('changed');
    }

    seekBy(seconds) {
        this.seekTo(this.position + seconds);
    }

    setVolume(v) {
        if (this._player)
            this._player.Volume = Math.max(0, Math.min(1, v));
    }

    toggleShuffle() {
        if (this._player)
            this._player.Shuffle = !this._player.Shuffle;
    }

    setLoop(loop) {
        if (this._player)
            this._player.LoopStatus = loop === 'track' ? 'Track' : (loop === 'playlist' ? 'Playlist' : 'None');
    }

    raise() {
        this._root?.RaiseAsync().catch(() => {});
    }

    destroy() {
        this._cancellable.cancel();
        if (this._propsId)
            this._player.disconnect(this._propsId);
        if (this._seekedId)
            this._player.disconnectSignal(this._seekedId);
        this._ready = false;
    }
}

export class MprisSource extends EventEmitter {
    constructor() {
        super();
        this._players = new Map();
        this._cancellable = new Gio.Cancellable();
        this._ownerId = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this._remove(name);
                if (newOwner)
                    this._add(name);
            });
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    for (const n of names) {
                        if (n.startsWith(MPRIS_PREFIX))
                            this._add(n);
                    }
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Now Bar: listing MPRIS players: ${e.message}`);
                }
            });
    }

    get players() {
        return [...this._players.values()].filter(p => p.ready);
    }

    player(key) {
        return this._players.get(key) ?? null;
    }

    _add(name) {
        if (this._players.has(name))
            return;
        const p = new Player(name);
        p.connect('changed', () => this.emit('changed'));
        this._players.set(name, p);
    }

    _remove(name) {
        const p = this._players.get(name);
        if (!p)
            return;
        p.destroy();
        this._players.delete(name);
        this.emit('changed');
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._ownerId);
        for (const p of this._players.values())
            p.destroy();
        this._players.clear();
    }
}
