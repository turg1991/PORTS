//=============================================================================
// web_boot.js
// Loaded after rpg_core.js. This playtest build only ships the unencrypted
// database/language/atlas files (*.json / *.yaml). The GTP_OmoriFixes,
// YED_Tiled and LanguageManager code picks the plain files when the "test"
// option is valid, and the encrypted files (*.KEL / *.PLUTO / *.HERO /
// *.AUBREY) otherwise - which do not exist in this build. Force the plain
// path so the game boots and plays from a web server.
//
// OggOnly.js (loaded later from plugins.js) reassigns Utils.isOptionValid,
// so intercept the property itself: any later reassignment is captured and
// still wrapped with the "test" force.
//=============================================================================
(function() {
    'use strict';
    var raw = Utils.isOptionValid;
    var wrapped = function(name) {
        if (name === 'test') { return 1; }
        return raw.call(this, name);
    };
    Object.defineProperty(Utils, 'isOptionValid', {
        configurable: true,
        get: function() { return wrapped; },
        set: function(fn) { if (typeof fn === 'function') { raw = fn; } }
    });

    // GTP_OmoriFixes' Permanent_Manager.load() reads
    // %LOCALAPPDATA%/OMORI/CUTSCENE.json (watched-cutscene bookkeeping, not a
    // player save) and throws when the file is missing. Pre-seed an empty
    // config - the same state a fresh machine has after its first save - so
    // boot stays free of uncaught errors.
    try {
        var cutsceneKey = 'omori_web_fs:/webdata/OMORI/CUTSCENE.json';
        if (localStorage.getItem(cutsceneKey) === null) {
            localStorage.setItem(cutsceneKey, '{}');
        }
    } catch (e) { /* private mode etc. - the plugin error is non-fatal anyway */ }
})();
