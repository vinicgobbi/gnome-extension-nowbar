import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const CHUNK = 64 * 1024;

let session = null;

function getSession() {
    session ??= new Soup.Session({user_agent: 'gnome-extension-nowbar', timeout: 15});
    return session;
}

// GET `url`; resolves to GLib.Bytes. The body is read in chunks and the
// request dropped as soon as it goes over `maxBytes` (a lying or missing
// Content-Length can't make the shell hold more than that). With
// `noRedirect`, any redirect is refused: a checked host can't bounce the
// request somewhere else. `checkAddress(GInetAddress)`, when given, sees
// the address actually connected to (after DNS, so a name that resolves
// to something else the second time is caught too); returning false drops
// the request before anything is sent. A kept-alive connection reused from
// an earlier request is checked again once it answers.
export async function fetchBytes(url, {maxBytes = 1024 * 1024, noRedirect = false, cancellable = null,
    checkAddress = null} = {}) {
    const msg = Soup.Message.new('GET', url);
    if (!msg)
        throw new Error(`invalid URL ${url}`);
    if (noRedirect)
        msg.set_flags(Soup.MessageFlags.NO_REDIRECT);

    // Our own cancellable, to drop this request alone (g_cancellable_connect:
    // runs at once when `cancellable` already is).
    const own = new Gio.Cancellable();
    const linkId = cancellable?.connect(() => own.cancel()) ?? 0;
    let refused = false;
    if (checkAddress) {
        msg.connect('network-event', (m, event, conn) => {
            if (event !== Gio.SocketClientEvent.CONNECTED || !(conn instanceof Gio.SocketConnection))
                return;
            let ok = false;
            try {
                ok = checkAddress(conn.get_remote_address().get_address());
            } catch {}
            if (!ok) {
                refused = true;
                own.cancel();
            }
        });
    }

    let stream = null;
    try {
        stream = await getSession().send_async(msg, GLib.PRIORITY_DEFAULT, own);
        const remote = msg.get_remote_address();
        if (checkAddress && remote instanceof Gio.InetSocketAddress && !checkAddress(remote.get_address())) {
            refused = true;
            throw new Error();
        }
        const status = msg.get_status();
        if (status < 200 || status >= 300)
            throw new Error(`HTTP ${status}`);
        if (msg.get_response_headers().get_content_length() > maxBytes)
            throw new Error('answer too large');
        const chunks = [];
        let total = 0;
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const chunk = await stream.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT, own);
            const n = chunk.get_size();
            if (n === 0)
                break;
            total += n;
            if (total > maxBytes)
                throw new Error('answer too large');
            chunks.push(chunk.toArray());
        }
        const out = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
            out.set(c, at);
            at += c.length;
        }
        return new GLib.Bytes(out);
    } catch (e) {
        if (refused)
            throw new Error('host is on the local network');
        throw e;
    } finally {
        if (linkId)
            cancellable.disconnect(linkId);
        stream?.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
}

export function destroySession() {
    session?.abort();
    session = null;
}
