import { openTracePopup } from './src/view.js';

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

jQuery(() => {
    addMenuItem();
    console.log(`[${MODULE_NAME}] loaded`);
});
