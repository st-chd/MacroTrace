import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { CACHE_KEY } from './src/translate.js';
import { FOLD_KEY, openTracePopup } from './src/view.js';

const MODULE_NAME = 'MacroTrace';

function addMenuItem() {
    if (document.getElementById('mt-menu-item')) return;
    const item = document.createElement('div');
    item.id = 'mt-menu-item';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-fw fa-solid fa-code extensionsMenuExtensionButton"></div><span>매크로 추적</span>';
    item.addEventListener('click', () => openTracePopup());
    document.getElementById('extensionsMenu')?.append(item);
}

/** manifest hook: called when the extension is removed with its data. */
export async function clean() {
    document.getElementById('mt-menu-item')?.remove();
    if (extension_settings.macroTrace) {
        delete extension_settings.macroTrace;
        saveSettingsDebounced();
    }
    try {
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(FOLD_KEY);
    } catch {
        // storage blocked: nothing was kept there either
    }
}

jQuery(() => {
    addMenuItem();
    console.log(`[${MODULE_NAME}] loaded`);
});
