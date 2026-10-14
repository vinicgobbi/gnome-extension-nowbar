// Sanity checks that model.js (generated from the Omarchy plugin's
// NowbarModel.js) loads as an ES module under GJS and does what the
// extension relies on. Its full test suite lives in omarchy-plugin-nowbar.
//
//   gjs -m tests/model.test.js

import * as Model from '../nowbar@vinicgobbi.dev.br/lib/model.js';

let failed = 0;
function check(name, ok) {
    print(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok)
        failed++;
}

const now = new Date(2026, 9, 14, 12, 0, 0).getTime();

check('parseTimerArg 1h30m', Model.parseTimerArg('1h30m', now) === 5400);
check('parseTimerArg 14:30', Model.parseTimerArg('14:30', now) === 9000);

const t = Model.startTimer(60, now);
check('timer runs', Model.timerActivity(t, now + 1000).title === '0:59');
check('timer finishes', Model.timerFinished(t, now + 60000));
check('done timer card', Model.timerActivity(Model.doneTimer(t, now + 60000), now + 61000).title === "Time's up");

const p = Model.normalizePrefs({moduleWeather: false, quickToggleItems: 'dnd,record'});
check('prefs modules', p.modules.weather === false && p.modules.media === true);
check('prefs quick toggles', p.quickToggles.join() === 'dnd,record');

const push = Model.sanitizePush('build', '{"title":"Build","progress":0.5}', now);
check('push accepted', push.ok && Model.pushActivity(push.item, now).progress === 0.5);
check('push bad id refused', !Model.sanitizePush('../x', '{"title":"x"}', now).ok);

const list = Model.sortActivities([
    Model.privacyActivity({micApps: ['Zoom'], micMuted: false, cameraActive: false, cameraApps: []}),
    Model.timerActivity(t, now),
]);
check('privacy before timer', list[0].id === 'privacy');
check('focus goes to newcomer', Model.resolveFocus({list, focusId: 'timer', knownIds: {timer: 40},
    autoFocus: true, manualUntil: 0, now}) === 'privacy');

const hist = '100: (200,40,40) #C82828\n900: (20,20,20) #141414';
check('accent from histogram', /^#[0-9a-f]{6}$/.test(Model.accentFromHistogram(hist)));
check('safeArtUrl refuses local network', Model.safeArtUrl('https://192.168.0.1/a.png') === '');

if (failed) {
    print(`${failed} failed`);
    imports.system.exit(1);
}
