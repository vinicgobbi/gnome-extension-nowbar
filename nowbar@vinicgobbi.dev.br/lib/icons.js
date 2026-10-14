// NowbarModel.js names its icons with Nerd Font glyphs (that's what the
// Omarchy bar draws). GNOME draws symbolic icons from the theme, so each
// glyph the model uses is mapped to one here. A glyph that isn't known (one a
// script pushed, say) falls back to the activity's module.

const GLYPHS = {
    // actions
    '\u{f03e4}': 'media-playback-pause-symbolic',
    '\u{f040a}': 'media-playback-start-symbolic',
    '\u{f0415}': 'list-add-symbolic',
    '\u{f0156}': 'window-close-symbolic',
    '\u{f012c}': 'object-select-symbolic',
    '\u{f0456}': 'media-playlist-repeat-symbolic',
    '\u{f0458}': 'media-playlist-repeat-song-symbolic',
    '\u{f049d}': 'media-playlist-shuffle-symbolic',
    '\u{f04ae}': 'media-skip-backward-symbolic',
    '\u{f04ad}': 'media-skip-forward-symbolic',
    '\u{f0d2a}': 'media-seek-backward-symbolic',
    '\u{f0d71}': 'media-seek-forward-symbolic',
    '\u{f04db}': 'media-playback-stop-symbolic',
    '\u{f023b}': 'bookmark-new-symbolic',
    '\u{f099b}': 'edit-undo-symbolic',
    '\u{f03cc}': 'go-jump-symbolic',
    '\u{f018f}': 'edit-copy-symbolic',
    '\u{f03eb}': 'document-edit-symbolic',
    '\u{f0770}': 'folder-open-symbolic',
    '\u{f032a}': 'power-profile-power-saver-symbolic',
    // media
    '\u{f075a}': 'folder-music-symbolic',
    // recording, screenshot
    '\u{f044a}': 'media-record-symbolic',
    '\u{f0e51}': 'camera-photo-symbolic',
    '\u{f0fce}': 'camera-video-symbolic',
    // privacy
    '\u{f0100}': 'camera-web-symbolic',
    '\u{f036c}': 'audio-input-microphone-symbolic',
    '\u{f036d}': 'microphone-disabled-symbolic',
    // modes
    '\u{f009b}': 'notifications-disabled-symbolic',
    '\u{f0594}': 'night-light-symbolic',
    '\u{f0582}': 'network-vpn-symbolic',
    // battery
    '\u{f0084}': 'battery-good-charging-symbolic',
    '\u{f007a}': 'battery-low-symbolic',
    '\u{f0083}': 'battery-caution-symbolic',
    // pushed: running, success, error
    '\u{f0996}': 'emblem-synchronizing-symbolic',
    '\u{f05e0}': 'object-select-symbolic',
    '\u{f0028}': 'dialog-error-symbolic',
    // updates
    '\u{f06b0}': 'software-update-available-symbolic',
    // weather (wttr.in codes, see Model.weatherIcon)
    '\u{e30d}': 'weather-clear-symbolic',
    '\u{e32b}': 'weather-clear-night-symbolic',
    '\u{e302}': 'weather-few-clouds-symbolic',
    '\u{e32e}': 'weather-few-clouds-night-symbolic',
    '\u{e33d}': 'weather-overcast-symbolic',
    '\u{e313}': 'weather-fog-symbolic',
    '\u{e346}': 'weather-fog-symbolic',
    '\u{e308}': 'weather-showers-scattered-symbolic',
    '\u{e333}': 'weather-showers-scattered-symbolic',
    '\u{e318}': 'weather-showers-symbolic',
    '\u{e30a}': 'weather-snow-symbolic',
    '\u{e327}': 'weather-snow-symbolic',
    '\u{e31a}': 'weather-snow-symbolic',
    '\u{e3ad}': 'weather-snow-symbolic',
    '\u{e31d}': 'weather-storm-symbolic',
};

const MODULES = {
    media: 'folder-music-symbolic',
    recording: 'media-record-symbolic',
    privacy: 'camera-web-symbolic',
    modes: 'notifications-disabled-symbolic',
    charging: 'battery-good-charging-symbolic',
    push: 'emblem-synchronizing-symbolic',
    screenshot: 'camera-photo-symbolic',
    weather: 'weather-overcast-symbolic',
};

export const FALLBACK = 'view-reveal-symbolic';

// The pill with nothing going on.
export const IDLE = 'view-more-horizontal-symbolic';

export function iconFor(glyph, module) {
    if (typeof glyph === 'string' && glyph.endsWith('-symbolic'))
        return glyph;
    return GLYPHS[glyph] || MODULES[module] || FALLBACK;
}

// The pill's charging icon follows the charge, like the system's.
export function batteryIcon(fraction, charging) {
    const level = Math.max(0, Math.min(100, Math.round(fraction * 10) * 10));
    return `battery-level-${level}${charging ? (level === 100 ? '-charged' : '-charging') : ''}-symbolic`;
}
