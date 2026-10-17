import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

// Small building blocks shared by the pill and the popup.

export function vbox(params = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, ...params});
}

export function hbox(params = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.HORIZONTAL, ...params});
}

// An actor goes from the width or height it had (from) to the one its new
// content or style asks for, then is left to its natural size again. No
// animation when from <= 0.
export function easeToNatural(actor, prop, from, duration = 200) {
    actor.remove_transition(prop);
    actor[prop] = -1;
    if (from <= 0)
        return;
    const [, to] = prop === 'width' ? actor.get_preferred_width(-1) : actor.get_preferred_height(actor.width);
    if (Math.abs(from - to) < 1)
        return;
    actor[prop] = from;
    actor.ease({[prop]: to, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => (actor[prop] = -1)});
}

export function label(text, styleClass, params = {}) {
    const l = new St.Label({text: text ?? '', style_class: styleClass ?? '', y_align: Clutter.ActorAlign.CENTER, ...params});
    l.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
    return l;
}

// A button with an icon and/or a label.
export function button({icon, text, styleClass = '', accessibleName, onClick, iconSize}) {
    const box = hbox({style_class: 'nowbar-btn-box', x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER});
    if (icon) {
        box.add_child(new St.Icon({icon_name: icon, style_class: 'nowbar-btn-icon',
            ...(iconSize ? {icon_size: iconSize} : {})}));
    }
    if (text)
        box.add_child(label(text, 'nowbar-btn-label'));
    const b = new St.Button({
        style_class: `nowbar-btn ${styleClass}`,
        child: box,
        can_focus: true,
        accessible_name: accessibleName ?? text ?? '',
    });
    if (onClick)
        b.connect('clicked', () => onClick(b));
    return b;
}

// A thin bar: `set(fraction)` fills it, `-1` hides it. The fill spans the
// whole bar and is scaled from its left edge: changing it never touches the
// layout (resizing it from a size notification relayouts the top bar on
// every tick).
export class Bar {
    constructor(styleClass) {
        this.actor = new St.Widget({style_class: `nowbar-bar ${styleClass}`, x_expand: true,
            layout_manager: new Clutter.BinLayout()});
        this.fill = new St.Widget({style_class: 'nowbar-bar-fill', x_expand: true, y_expand: true,
            pivot_point: new Graphene.Point({x: 0, y: 0.5}), scale_x: 0});
        this.actor.add_child(this.fill);
        this._fraction = -1;
        this._color = null;
    }

    set(fraction, color, animate = false) {
        this.actor.visible = fraction >= 0;
        if (color !== this._color) {
            this._color = color;
            this.fill.style = color ? `background-color: ${color};` : null;
        }
        const f = Math.max(0, Math.min(1, fraction));
        if (f === this._fraction)
            return;
        // Small steps (a countdown's seconds) glide; jumps to another
        // activity's progress snap.
        const glide = animate && this._fraction >= 0 && Math.abs(f - this._fraction) < 0.25;
        this._fraction = f;
        this.fill.remove_transition('scale-x');
        if (glide)
            this.fill.ease({scale_x: f, duration: 600, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this.fill.scale_x = f;
    }
}

// An image file drawn by St (cover art, a screenshot), cropped to fill.
// (St takes only lengths for background-position; cover centers anyway.)
export function backgroundStyle(path) {
    const uri = GLib.filename_to_uri(path, null).replace(/"/g, '%22');
    return `background-image: url("${uri}"); background-size: cover;`;
}

export function imageStyle(path, width, height, radius = 12) {
    return `${backgroundStyle(path)} width: ${width}px; height: ${height}px; border-radius: ${radius}px;`;
}

// Three bars dancing in the pill while music plays. Each one grows and
// shrinks from the bottom at its own pace, so together they never sync up.
const EQ_TIMES = [430, 560, 370];
const EQ_LOW = [0.35, 0.25, 0.45];

export class Equalizer {
    constructor() {
        this.actor = hbox({style_class: 'nowbar-eq', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._bars = EQ_TIMES.map(() => {
            const bar = new St.Widget({style_class: 'nowbar-eq-bar', y_align: Clutter.ActorAlign.END,
                pivot_point: new Graphene.Point({x: 0.5, y: 1})});
            this.actor.add_child(bar);
            return bar;
        });
        this._running = false;
        this._color = null;
    }

    start(color) {
        if (color !== this._color) {
            this._color = color;
            for (const bar of this._bars)
                bar.style = color ? `background-color: ${color};` : null;
        }
        this.actor.visible = true;
        if (this._running)
            return;
        this._running = true;
        this._bars.forEach((bar, i) => {
            bar.scale_y = 1;
            bar.ease({scale_y: EQ_LOW[i], duration: EQ_TIMES[i], mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: -1, autoReverse: true});
        });
    }

    stop() {
        this.actor.visible = false;
        if (!this._running)
            return;
        this._running = false;
        for (const bar of this._bars) {
            bar.remove_all_transitions();
            bar.scale_y = 1;
        }
    }
}

// --- marquee -------------------------------------------------------------------

const MARQUEE_GAP = 40;     // px between the end of the text and its copy
const MARQUEE_SPEED = 30;   // px/s
const MARQUEE_PAUSE = 1800; // ms at the start of each round

// Takes no width of its own (the line is as wide as its parent says), as
// tall as the text. The text keeps its natural width while it scrolls, and
// is cut to the room (ellipsized) while it doesn't.
const MarqueeLayout = GObject.registerClass(
class MarqueeLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height(container) {
        return container.get_first_child()?.get_preferred_height(-1) ?? [0, 0];
    }

    vfunc_allocate(container, box) {
        const child = container.get_first_child();
        if (!child)
            return;
        const [, natural] = child.get_preferred_width(-1);
        const width = this.scrolling ? natural : Math.min(natural, box.get_width());
        const [, height] = child.get_preferred_height(width);
        child.allocate(new Clutter.ActorBox({x1: box.x1, y1: box.y1, x2: box.x1 + width, y2: box.y1 + height}));
    }
});

// One line of text that scrolls sideways, round and round, when it doesn't
// fit (the title of One UI's media card): a copy follows it, so it loops
// without a jump. Still, and ellipsized, without animations or while not
// shown.
export class Marquee {
    constructor(styleClass) {
        this._layout = new MarqueeLayout();
        this.actor = new St.Widget({style_class: 'nowbar-marquee', x_expand: true, clip_to_allocation: true,
            layout_manager: this._layout});
        this._strip = hbox({style: `spacing: ${MARQUEE_GAP}px;`});
        this._labels = [0, 1].map(() => {
            const l = label('', styleClass);
            this._strip.add_child(l);
            return l;
        });
        this._labels[1].visible = false;
        this.actor.add_child(this._strip);
        this.animate = true;
        this._markup = null;
        this._state = '';
        this._width = 0;
        // Sizes are known after a layout: look then, outside of it.
        this.actor.connect('notify::allocation', () => {
            if (this.actor.width !== this._width) {
                this._width = this.actor.width;
                this._queueCheck();
            }
        });
        this.actor.connect('notify::mapped', () => this._queueCheck());
        this.actor.connect('destroy', () => {
            if (this._checkId)
                GLib.source_remove(this._checkId);
            this._checkId = 0;
        });
    }

    setMarkup(markup) {
        if (markup === this._markup)
            return;
        this._markup = markup;
        for (const l of this._labels)
            l.clutter_text.set_markup(markup);
        this._state = '';
        this._queueCheck();
    }

    _queueCheck() {
        if (this._checkId)
            return;
        this._checkId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._checkId = 0;
            this._check();
            return GLib.SOURCE_REMOVE;
        });
    }

    _check() {
        const [, text] = this._labels[0].get_preferred_width(-1);
        const room = this.actor.width;
        const scroll = this.animate && this.actor.mapped && room > 0 && text > room + 1;
        const state = scroll ? `scroll:${text}` : 'still';
        if (state === this._state)
            return;
        this._state = state;
        this._strip.remove_transition('translation-x');
        this._strip.translation_x = 0;
        this._labels[1].visible = scroll;
        this._layout.scrolling = scroll;
        this.actor.queue_relayout();
        if (scroll)
            this._round(text + MARQUEE_GAP);
    }

    // Waits, then slides by one text and gap: the copy is then where the
    // text started, so going back to 0 doesn't show.
    _round(distance) {
        this._strip.translation_x = 0;
        this._strip.ease({translation_x: -distance, delay: MARQUEE_PAUSE,
            duration: distance / MARQUEE_SPEED * 1000, mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => this._round(distance)});
    }
}

// --- wave slider ---------------------------------------------------------------

const HILLS_HEIGHT = 18; // px above the bar, at the highest, from halfway on
const HILLS_START = 1.5; // how much taller they are at the start of the track
const HILLS_GROW = 36;   // px of played bar under which they grow from flat
const TRACK_GAP = 4;     // px between the handle and what's still to play

// The layers over the played part, back to front, measured from a screen
// recording of One UI 9 (a loop of 1.4 s; it doesn't follow the sound).
// Each spans the whole of it, from the start of the bar to the handle, so
// they stretch, and go faster, as the music goes on. `humps` is how many fit
// in it, and they flow forward: each one is born flat near the start, grows
// as it travels, is at its tallest halfway and shrinks again until it's gone
// at the handle, while the next ones follow. `speed` is how many humps go by
// per second, height a share of HILLS_HEIGHT, `white` how much white goes
// into the bar's color. A hump is never narrower than `width` (px): early
// in the track fewer of them fit, and they split as the bar grows.
const HILLS = [
    {humps: 2, width: 70, height: 1.0, white: 0.1, alpha: 0.85, speed: 0.71},
    {humps: 4, width: 45, height: 0.75, white: 0.5, alpha: 0.55, speed: 1.07},
    {humps: 8, width: 28, height: 0.6, white: 0.9, alpha: 0.65, speed: 1.43},
];

// The shell's slider (drag, keys, scroll) drawn like One UI 9's media seek
// bar: a straight bar, and over the part already played soft translucent
// hills in its color that flow toward the handle while the music plays and
// sink into the bar when it pauses. The handle is the bar's color in a
// white ring.
export const WaveSlider = GObject.registerClass(
class WaveSlider extends Slider.Slider {
    _init(value) {
        super._init(value);
        this._amp = 0;
        this._target = 0;
        this._time = 0;
        this._animate = false;
        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._frame());
        this.connect('notify::mapped', () => this._syncTimeline());
        this.connect('destroy', () => this._timeline.stop());
    }

    setWaving(on, animate) {
        this._animate = animate;
        this._target = on ? 1 : 0;
        if (!animate && this._amp !== this._target) {
            this._amp = this._target;
            this.queue_repaint();
        }
        this._syncTimeline();
    }

    _syncTimeline() {
        const run = this._animate && this.mapped && (this._target > 0 || this._amp > 0);
        if (run && !this._timeline.is_playing()) {
            this._last = GLib.get_monotonic_time();
            this._timeline.start();
        } else if (!run && this._timeline.is_playing()) {
            this._timeline.stop();
        }
    }

    _frame() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min(0.1, (now - this._last) / 1e6);
        this._last = now;
        this._time += dt * this._amp;
        this._amp += (this._target - this._amp) * (1 - Math.exp(-dt * 5));
        if (Math.abs(this._target - this._amp) < 0.01)
            this._amp = this._target;
        this.queue_repaint();
        if (this._amp === 0)
            this._syncTimeline();
    }

    // Room for the hills over the bar; the handle sits on the bar.
    _getPreferredHeight() {
        return Math.ceil(this._handleRadius + this._barLevelHeight / 2 + HILLS_HEIGHT * HILLS_START + 1);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        if (this.get_text_direction() === Clutter.TextDirection.RTL) {
            cr.translate(width, 0);
            cr.scale(-1, 1);
        }
        const r = this._handleRadius;
        const thick = this._barLevelHeight;
        const y = height - r;
        const handleX = r + (width - 2 * r) * this._value / this._maxValue;
        const start = thick / 2;
        const end = width - thick / 2;
        const c = this._barLevelActiveColor;
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(thick);

        // Still to play.
        if (handleX + r + TRACK_GAP < end) {
            cr.moveTo(handleX + r + TRACK_GAP, y);
            cr.lineTo(end, y);
            cr.setSourceColor(this._barLevelColor);
            cr.stroke();
        }

        // The hills, standing on the played bar from its start to the handle.
        const span = handleX - start;
        if (this._amp > 0 && span > 2) {
            const top = y - HILLS_HEIGHT * HILLS_START;
            // Taller early in the track (as in One UI), down to their
            // height by halfway; growing from flat over the first pixels
            // so they aren't spikes.
            const early = 1 + (HILLS_START - 1) * Math.max(0, 1 - 2 * this._value / this._maxValue);
            const grow = Math.min(1, span / HILLS_GROW) * early;
            for (const [i, h] of HILLS.entries()) {
                const peak = HILLS_HEIGHT * h.height * this._amp * grow;
                const shift = h.speed * this._time + i * 0.37;
                const humps = Math.max(0.5, Math.min(h.humps, span / h.width));
                cr.moveTo(start, y);
                for (let x = start; x <= handleX; x += 2) {
                    const t = (x - start) / span;
                    // The humps move on, and the envelope sizes them by where
                    // they are: born flat at the start, at their tallest
                    // halfway, flat again at the handle.
                    // (Squared: smooth valleys, no cusp where humps meet.)
                    const hump = Math.sin(Math.PI * (humps * t - shift)) ** 2;
                    const size = Math.pow(Math.sin(Math.PI * t), 1.5);
                    cr.lineTo(x, y - peak * size * hump);
                }
                cr.lineTo(handleX, y);
                cr.closePath();
                const mix = v => (v + (255 - v) * h.white) / 255;
                const grad = new Cairo.LinearGradient(0, top, 0, y);
                grad.addColorStopRGBA(0, mix(c.red), mix(c.green), mix(c.blue), h.alpha);
                grad.addColorStopRGBA(1, mix(c.red), mix(c.green), mix(c.blue), h.alpha * 0.45);
                cr.setSource(grad);
                cr.fill();
            }
        }

        // Played.
        if (handleX > start) {
            cr.moveTo(start, y);
            cr.lineTo(handleX, y);
            cr.setSourceColor(c);
            cr.stroke();
        }

        cr.setSourceRGBA(1, 1, 1, 1);
        cr.arc(handleX, y, r, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceColor(c);
        cr.arc(handleX, y, r - 2.5, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }
});
