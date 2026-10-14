import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

let session = null;

function getSession() {
    if (!session) {
        // wttr.in answers JSON to ?format=j1 whatever the agent; a curl-like
        // one keeps it from guessing a browser and sending HTML.
        session = new Soup.Session({user_agent: 'curl/8.0 (gnome-extension-nowbar)', timeout: 15});
    }
    return session;
}

// GET `url`; resolves to GLib.Bytes. Refuses an answer bigger than
// `maxBytes`, and (with `noRedirect`) any redirect: a checked host can't
// bounce the request somewhere else.
export async function fetchBytes(url, {maxBytes = 1024 * 1024, noRedirect = false, cancellable = null} = {}) {
    const msg = Soup.Message.new('GET', url);
    if (!msg)
        throw new Error(`invalid URL ${url}`);
    if (noRedirect)
        msg.set_flags(Soup.MessageFlags.NO_REDIRECT);
    const bytes = await getSession().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
    const status = msg.get_status();
    if (status < 200 || status >= 300)
        throw new Error(`HTTP ${status}`);
    const length = msg.get_response_headers().get_content_length();
    if (length > maxBytes || bytes.get_size() > maxBytes)
        throw new Error('answer too large');
    return bytes;
}

export async function fetchText(url, options = {}) {
    return new TextDecoder().decode((await fetchBytes(url, options)).toArray());
}

export function destroySession() {
    session?.abort();
    session = null;
}
