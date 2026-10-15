import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Weather from 'resource:///org/gnome/shell/misc/weather.js';

import * as Model from '../model.js';

// The weather card, from GNOME's own weather: the shell's WeatherClient
// (GWeather), the same one the calendar menu shows. The place is the one
// picked in the GNOME Weather app (or its automatic location), so there is
// nothing to set up here. Turned into the object Model.weatherActivity takes.

const STALE_ON_OPEN_MS = 10 * 60 * 1000;
const RAINY = /showers|storm|rain|drizzle/;

// One client for the whole session: the calendar menu's when there is one
// (no second set of requests), else ours, kept across enable/disable since
// WeatherClient has no way to be torn down.
let ownClient = null;

function weatherClient() {
    const shared = Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient;
    if (shared)
        return shared;
    ownClient ??= new Weather.WeatherClient();
    return ownClient;
}

// The sky's color for the card and the popup tint, like a cover for media
// (same palette as Model.weatherColor).
function skyColor(icon, night) {
    if (/storm/.test(icon))
        return '#7b5cd6';
    if (/snow/.test(icon))
        return '#9cc3e6';
    if (RAINY.test(icon))
        return '#3d8fe0';
    if (/fog/.test(icon))
        return '#8e9aa8';
    if (/overcast/.test(icon))
        return night ? '#5a6a8f' : '#7d8ea6';
    if (/few-clouds/.test(icon))
        return night ? '#4b5fb5' : '#e8b04a';
    return night ? '#4a56c8' : '#f2a33a';
}

function pad2(n) {
    return (n < 10 ? '0' : '') + n;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export class WeatherSource extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._client = weatherClient();
        this._enabled = false;
        this._clientId = 0;
        this._gweather = new Gio.Settings({schema_id: 'org.gnome.GWeather4'});
        this._ids = [
            [settings, settings.connect('changed::weather-unit', () => {
                this._last = null;
                this.emit('changed');
            })],
            [this._gweather, this._gweather.connect('changed::temperature-unit', () => this.emit('changed'))],
        ];
    }

    setEnabled(on) {
        if (on === this._enabled)
            return;
        this._enabled = on;
        if (on) {
            this._clientId = this._client.connect('changed', () => {
                if (this._client.info.is_valid() && !this._client.loading)
                    this._receivedAt = Date.now();
                this.emit('changed');
            });
            this._client.update();
        } else if (this._clientId) {
            this._client.disconnect(this._clientId);
            this._clientId = 0;
        }
        this.emit('changed');
    }

    // Whether GNOME Weather is installed (where the place is picked).
    get available() {
        return this._client.available;
    }

    get hasLocation() {
        return this._client.hasLocation;
    }

    get fetching() {
        return this._client.loading;
    }

    // When the reading arrived. Not GWeather's "update" time: that is when
    // the station observed it (often an hour back), which would make every
    // reading look stale.
    get fetchedAt() {
        return this._receivedAt || this._lastAt || 0;
    }

    refresh() {
        this._client.update();
    }

    refreshIfStale() {
        if (this._enabled && Date.now() - this.fetchedAt > STALE_ON_OPEN_MS)
            this._client.update();
    }

    openApp() {
        this._client.activateApp();
    }

    _unit() {
        const pref = this._settings.get_string('weather-unit');
        if (pref === 'metric')
            return GWeather.TemperatureUnit.CENTIGRADE;
        if (pref === 'imperial')
            return GWeather.TemperatureUnit.FAHRENHEIT;
        const gw = this._gweather.get_string('temperature-unit');
        if (gw === 'fahrenheit')
            return GWeather.TemperatureUnit.FAHRENHEIT;
        if (gw === 'centigrade')
            return GWeather.TemperatureUnit.CENTIGRADE;
        const locale = GLib.getenv('LC_MEASUREMENT') || GLib.getenv('LANG') || '';
        return Model.useImperial('auto', locale, '') ? GWeather.TemperatureUnit.FAHRENHEIT
            : GWeather.TemperatureUnit.CENTIGRADE;
    }

    // What Model.weatherActivity takes (with GNOME icon names instead of
    // glyphs), or null when there is no reading.
    // The weather now, or the last good reading while GWeather reloads,
    // fails (offline) or briefly loses the automatic location: the card
    // stays, and its age line says how old it is.
    weather(now) {
        if (!this._enabled)
            return null;
        const fresh = this._client.hasLocation ? this._read(now) : null;
        if (fresh) {
            this._last = fresh;
            this._lastAt = this._receivedAt || Date.now();
        }
        return this._last ?? null;
    }

    _read(now) {
        const info = this._client.info;
        if (!info.is_valid())
            return null;
        const unit = this._unit();
        const temp = x => {
            const [ok, v] = x.get_value_temp(unit);
            return ok ? Math.round(v) : null;
        };
        const t = temp(info);
        if (t === null)
            return null;
        const night = !info.is_daytime();
        const icon = info.get_symbolic_icon_name();
        const [okFeels, feels] = info.get_value_apparent(unit);

        // Forecasts: MET Norway gives one an hour. The next hours in 3-hour
        // steps, and per day the range and the icon around noon.
        const hours = [{label: 'Now', hour: new Date(now).getHours(), icon, temp: t, rainy: RAINY.test(icon)}];
        const days = new Map();
        let lastHour = now;
        for (const fc of info.get_forecast_list()) {
            const [ok, ts] = fc.get_value_update();
            const ft = temp(fc);
            if (!ok || ts <= 0 || ft === null)
                continue;
            const ms = ts * 1000;
            const d = new Date(ms);
            const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            const day = days.get(key) ?? {date: d, min: ft, max: ft, icon: fc.get_symbolic_icon_name(), noon: 99};
            day.min = Math.min(day.min, ft);
            day.max = Math.max(day.max, ft);
            const fromNoon = Math.abs(d.getHours() - 12);
            if (fromNoon < day.noon) {
                day.noon = fromNoon;
                day.icon = fc.get_symbolic_icon_name().replace('-night', '');
            }
            days.set(key, day);
            if (ms > now && ms - lastHour >= 3 * 3600 * 1000 - 60000 && hours.length < 8) {
                const fIcon = fc.get_symbolic_icon_name();
                hours.push({label: `${pad2(d.getHours())}h`, hour: d.getHours(), icon: fIcon, temp: ft, rainy: RAINY.test(fIcon)});
                lastHour = ms;
            }
        }
        const today = new Date(now);
        const forecast = [...days.values()].filter(d => d.date >= new Date(today.getFullYear(), today.getMonth(), today.getDate()))
            .slice(0, 3).map((d, i) => ({
                name: i === 0 ? 'Today' : (i === 1 ? 'Tomorrow' : DAY_NAMES[d.date.getDay()]),
                icon: d.icon,
                min: i === 0 ? Math.min(d.min, t) : d.min,
                max: i === 0 ? Math.max(d.max, t) : d.max,
            }));

        const clock = getter => {
            const [ok, ts] = getter.call(info);
            return ok && ts > 0 ? Model.clockAt(ts * 1000) : '';
        };
        return {
            temp: t,
            unit: unit === GWeather.TemperatureUnit.FAHRENHEIT ? '°F' : '°C',
            feels: okFeels ? Math.round(feels) : t,
            desc: Model.clean(info.get_conditions() !== '-' ? info.get_conditions() : info.get_sky(), 40),
            night,
            icon,
            color: skyColor(icon, night),
            humidity: info.get_humidity(),
            wind: info.get_wind(),
            location: Model.clean(info.get_location_name(), 40),
            sunrise: clock(info.get_value_sunrise),
            sunset: clock(info.get_value_sunset),
            hours,
            raining: RAINY.test(icon),
            days: forecast,
            attribution: info.get_attribution(),
        };
    }

    destroy() {
        this.setEnabled(false);
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
    }
}

// Rain on the way: not raining now, and rain in one of the next two 3-hour
// steps. Part of the weather card (a line on it, and "Rain soon" in the pill
// when the card is what the pill shows), never an activity of its own: a
// forecast must not push aside what is actually going on, like music.
// null when there is nothing to tell.
export function rainNote(w, stale) {
    if (!w || stale || w.raining)
        return null;
    for (let i = 1; i < Math.min(3, w.hours.length); i++) {
        const h = w.hours[i];
        if (!h.rainy)
            continue;
        const when = i === 1 ? 'soon' : `around ${pad2(h.hour)}:00`;
        return {icon: h.icon, text: `Rain likely ${when}`, pill: `Rain ${when}`};
    }
    return null;
}
