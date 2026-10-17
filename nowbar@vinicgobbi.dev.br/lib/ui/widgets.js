import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

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
export function imageStyle(path, width, height, radius = 12) {
    const uri = GLib.filename_to_uri(path, null).replace(/"/g, '%22');
    // (St takes only lengths for background-position; cover centers anyway.)
    return `background-image: url("${uri}"); background-size: cover;` +
        ` width: ${width}px; height: ${height}px; border-radius: ${radius}px;`;
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
