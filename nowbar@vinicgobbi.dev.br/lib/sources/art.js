import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import * as Model from '../model.js';
import {fetchBytes} from '../net.js';
import {cacheDir} from '../util.js';

// Cover art for the media cards, and the colors taken from it. The URL comes
// from whatever is playing (a web page, through the browser), so the same
// rules as the Omarchy plugin apply: https to a public host or a local file
// only (Model.safeArtUrl), at most 8 MB and 4096 px, a real PNG/JPEG/GIF/WebP
// by its first bytes, and no redirects. Only then is it handed to St.

Gio._promisify(Gio.Resolver.prototype, 'lookup_by_name_async');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const KEEP = 6;

function imageKind(bytes) {
    const b = bytes.slice(0, 12);
    const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    if (hex.startsWith('89504e470d0a1a0a'))
        return 'png';
    if (hex.startsWith('ffd8ff'))
        return 'jpeg';
    if (hex.startsWith('474946383761') || hex.startsWith('474946383961'))
        return 'gif';
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250')
        return 'webp';
    return '';
}

function isPublicAddress(addr) {
    if (addr.is_loopback || addr.is_link_local || addr.is_site_local || addr.is_multicast || addr.is_any)
        return false;
    const s = addr.to_string();
    // Model.isPrivateHost knows the IPv4 ranges GLib doesn't flag (CGNAT,
    // benchmarking); IPv6 must be global unicast.
    if (addr.get_family() === Gio.SocketFamily.IPV4)
        return !Model.isPrivateHost(s);
    return /^[23]/.test(s) && !s.startsWith('::ffff:');
}

// Builds the "count: (r,g,b) #RRGGBB" lines Model.accentFromHistogram reads
// (ImageMagick's histogram format), from a small copy of the cover.
function histogram(path) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 48, 48, true);
    const n = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    const px = pixbuf.get_pixels();
    const counts = new Map();
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * n;
            if (n === 4 && px[i + 3] < 128)
                continue;
            // 4 bits per channel: 4096 buckets, close to ImageMagick's -colors.
            const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([key, count]) => {
        const c = [(key >> 8) & 15, (key >> 4) & 15, key & 15].map(v => v * 17);
        const hex = c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
        return `${count}: (${c.join(',')}) #${hex}`;
    }).join('\n');
}

export class ArtSource extends EventEmitter {
    constructor() {
        super();
        this._cache = new Map(); // url -> {path, accent, base, remote} | null (failed)
        this._pending = new Set();
        this._cancellable = new Gio.Cancellable();
        this._dir = GLib.build_filenamev([cacheDir(), 'covers']);
        // Anything left behind by a previous session.
        this._clearDir();
        GLib.mkdir_with_parents(this._dir, 0o700);
    }

    // {path, accent, base} for `url` when it is ready, else null (and the
    // fetch starts; 'changed' is emitted when it lands).
    get(url) {
        const safe = Model.safeArtUrl(url);
        if (!safe)
            return null;
        if (this._cache.has(safe))
            return this._cache.get(safe);
        if (!this._pending.has(safe)) {
            this._pending.add(safe);
            this._load(safe).then(entry => this._store(safe, entry)).catch(e => {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    console.debug(`Now Bar: cover ${safe}: ${e.message}`);
                    this._store(safe, null);
                }
            }).finally(() => this._pending.delete(safe));
        }
        return null;
    }

    _store(url, entry) {
        this._cache.set(url, entry);
        while (this._cache.size > KEEP) {
            const [oldUrl, old] = this._cache.entries().next().value;
            this._cache.delete(oldUrl);
            if (old?.remote)
                GLib.unlink(old.path);
        }
        this.emit('changed');
    }

    async _load(url) {
        let path, remote = false;
        if (/^file:\/\/\//i.test(url)) {
            const file = Gio.File.new_for_uri(url);
            path = file.get_path();
            const info = file.query_info('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > MAX_BYTES)
                throw new Error('not a regular file, or too large');
            const stream = file.read(null);
            const head = stream.read_bytes(12, null).toArray();
            stream.close(null);
            if (!imageKind(head))
                throw new Error('not an image');
        } else {
            const host = /^https:\/\/([^/?#:@]+)/i.exec(url)[1];
            // Best effort against a public name pointing into the local
            // network: every address it resolves to must be public.
            const addrs = await Gio.Resolver.get_default().lookup_by_name_async(host, this._cancellable);
            if (!addrs.length || !addrs.every(isPublicAddress))
                throw new Error('host resolves to a local address');
            const bytes = await fetchBytes(url, {maxBytes: MAX_BYTES, noRedirect: true, cancellable: this._cancellable});
            const data = bytes.toArray();
            const kind = imageKind(data);
            if (!kind)
                throw new Error('not an image');
            path = GLib.build_filenamev([this._dir, `${GLib.uuid_string_random()}.${kind}`]);
            GLib.file_set_contents(path, data);
            remote = true;
        }
        const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
        if (!format || width > MAX_DIMENSION || height > MAX_DIMENSION || width <= 0 || height <= 0) {
            if (remote)
                GLib.unlink(path);
            throw new Error('unsupported or oversized image');
        }
        const hist = histogram(path);
        const accent = Model.accentFromHistogram(hist);
        return {path, remote, accent, base: accent ? Model.baseFromHistogram(hist) : ''};
    }

    _clearDir() {
        try {
            const dir = GLib.Dir.open(this._dir, 0);
            let name;
            while ((name = dir.read_name()) !== null)
                GLib.unlink(GLib.build_filenamev([this._dir, name]));
            dir.close();
        } catch {}
    }

    destroy() {
        this._cancellable.cancel();
        this._clearDir();
        this._cache.clear();
    }
}
