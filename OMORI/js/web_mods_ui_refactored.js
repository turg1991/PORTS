(function() {
    'use strict';

    var ui = {
        toggleEl: null,
        panelEl: null,
        listEl: null,
        statusEl: null,
        storageEl: null
    };

    var gatePending = true;
    var MODS_PATH = 'mods/';

    // Load HTML template
    function loadTemplate() {
        var template = document.createElement('div');
        template.innerHTML = 
            '<button id="wmmToggle" class="wmm-toggle">MODS</button>' +
            '<div id="wmmPanel" class="wmm-panel">' +
                '<div class="wmm-title">OMORI web port - mod manager</div>' +
                '<div id="wmmDropZone" class="wmm-dropzone">Drop a mod .zip (or mod folder) here</div>' +
                '<div class="wmm-btn-row">' +
                    '<button id="wmmZipBtn" class="wmm-btn">Install .zip...</button>' +
                    '<button id="wmmDirBtn" class="wmm-btn">Install folder...</button>' +
                '</div>' +
                '<input type="file" id="wmmZipInput" class="wmm-file-input" accept=".zip,application/zip" multiple>' +
                '<input type="file" id="wmmDirInput" class="wmm-file-input" webkitdirectory multiple>' +
                '<div id="wmmStatus" class="wmm-status"></div>' +
                '<div id="wmmStorage" class="wmm-storage"></div>' +
                '<div id="wmmList" class="wmm-list"></div>' +
                '<div class="wmm-btn-row">' +
                    '<button id="wmmReloadBtn" class="wmm-btn">Reload game</button>' +
                    '<button id="wmmCloseBtn" class="wmm-btn">Close</button>' +
                '</div>' +
            '</div>' +
            '<div id="wmmGate" class="wmm-gate">' +
                '<div class="wmm-gate-logo">OMORI web port</div>' +
                '<div class="wmm-gate-subtitle">Add your mods, then start the game.</div>' +
                '<div id="wmmGatePanel"></div>' +
                '<button id="wmmStartBtn" class="wmm-start-btn">▶ Start game</button>' +
                '<div class="wmm-gate-note">Mods you add now are loaded when the game starts. Press Enter to start, or reopen this panel later with the MODS button.</div>' +
            '</div>';
        document.body.appendChild(template);
    }

    // Load CSS
    function loadCss() {
        if (document.getElementById('wmmCss')) return;
        var link = document.createElement('link');
        link.id = 'wmmCss';
        link.rel = 'stylesheet';
        link.type = 'text/css';
        link.href = 'css/web_mods_ui.css';
        document.head.appendChild(link);
    }
