/*
    This file is part of the OneLoader project and is licensed under the same terms (MIT)
    Modified for the OMORI web port: the old "!!TEST MODE!!" banner is replaced
    with a clickable "web port by turg" credit that opens https://turg.netlify.app
*/

{
    const WEB_PORT_LABEL = "web port by turg";
    const WEB_PORT_URL = "https://turg.netlify.app";

    // This file can end up executing twice (as the mod source and as the
    // randomized js/plugins copy OneLoader injects). Remember the true
    // original so the second wrap still reaches the game's own function.
    if (!Scene_OmoriTitleScreen._webPortOrigCreateVersionText) {
        Scene_OmoriTitleScreen._webPortOrigCreateVersionText = Scene_OmoriTitleScreen.prototype.createVersionText;
    }
    window.__webPortBrandedBy = (document.currentScript && document.currentScript.src) || "unknown";

    function _webPortHitRect(scene) {
        if (!scene || !scene._one_loader || !scene._one_loader.test_mode) { return null; }
        const sprite = scene._one_loader.test_mode;
        return {
            x: sprite.x + 2,
            y: sprite.y,
            w: (sprite._webPortLabelWidth || 200) + 6,
            h: 32
        };
    }

    function _webPortInstallClick() {
        if (Scene_OmoriTitleScreen._webPortClickInstalled) { return; }
        Scene_OmoriTitleScreen._webPortClickInstalled = true;
        const canvas = Graphics._canvas;
        if (!canvas) { return; }
        function toGameSpace(ev) {
            const r = canvas.getBoundingClientRect();
            if (!r.width || !r.height) { return null; }
            return {
                x: (ev.clientX - r.left) * (Graphics.width / r.width),
                y: (ev.clientY - r.top) * (Graphics.height / r.height)
            };
        }
        function hitTest(ev) {
            const rect = _webPortHitRect(SceneManager._scene);
            if (!rect) { return false; }
            const pt = toGameSpace(ev);
            if (!pt) { return false; }
            return pt.x >= rect.x && pt.x <= rect.x + rect.w &&
                   pt.y >= rect.y && pt.y <= rect.y + rect.h;
        }
        // Listen on document: faded overlay elements may sit on top of the
        // canvas and would otherwise swallow the events.
        document.addEventListener("pointermove", function(ev) {
            canvas.style.cursor = hitTest(ev) ? "pointer" : "";
        });
        document.addEventListener("pointerdown", function(ev) {
            if (hitTest(ev)) {
                window.open(WEB_PORT_URL, "_blank");
            }
        });
    }

    Scene_OmoriTitleScreen.prototype.createVersionText = function() {
        if (this._webPortVersionTextDone) { return; }
        this._webPortVersionTextDone = true;
        Scene_OmoriTitleScreen._webPortOrigCreateVersionText.call(this);
        this._one_loader = {
            "loader_version":new Sprite(new Bitmap(640, 32)),
            "mods_loaded":new Sprite(new Bitmap(640, 32)),
            "mods_total":new Sprite(new Bitmap(640, 32)),
            "test_mode":new Sprite(new Bitmap(640, 32))
        };
        let y = 32;
        for (let key in this._one_loader) {
            this.addChild(this._one_loader[key]);
            this._one_loader[key].position.set(0, y);
            this._one_loader[key].bitmap.fontSize = 24;
            y += 32;
        }

        const version = $modLoader.knownMods.get("oneloader").json.version;
        const loadedAmount = $modLoader.knownMods.size;
        const allAmount = $modLoader.allMods.size;

        this._one_loader.test_mode.bitmap.textColor = "#8fd0ff";
        this._one_loader.test_mode.bitmap.drawText(WEB_PORT_LABEL, 4, 4, 640, 16, "left");
        this._one_loader.test_mode._webPortLabelWidth = this._one_loader.test_mode.bitmap.measureTextWidth(WEB_PORT_LABEL);
        _webPortInstallClick();

        this._one_loader.loader_version.bitmap.drawText(`OneLoader ${version}`, 4, 4, 640, 16, "left");
        this._one_loader.mods_loaded.bitmap.drawText(`Mods in use: ${loadedAmount}`, 4, 4, 640, 16, "left");
        this._one_loader.mods_total.bitmap.drawText(`Mods total: ${allAmount}`, 4, 4, 640, 16, "left");
    };
}
