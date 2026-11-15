// ==UserScript==
// @name         Twitch Fishing Auto-Buyer
// @namespace    local.twitch.fishing
// @version      2.1
// @author       toshaToffifee
// @description  Автопокупка награды за баллы канала ("Рыбалка") + автосбор бонусных баллов
// @match        https://www.twitch.tv/*
// @updateURL    https://raw.githubusercontent.com/happycloudwtf/twitch-scripts/main/twitch-fishing-autobuy.user.js
// @downloadURL  https://raw.githubusercontent.com/happycloudwtf/twitch-scripts/main/twitch-fishing-autobuy.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ================== НАСТРОЙКИ ПО УМОЛЧАНИЮ ==================
    const DEFAULTS = {
        channel: 'gans_mann',    // ник стримера, ТОЛЬКО на его канале работает покупка
        rewardName: 'Рыбалка',   // подстрока названия награды (без учета регистра)
        intervalSec: 35,         // период попыток покупки, сек (КД награды 30 сек)
        minBalance: 0,           // не покупать, если баланс ниже этого значения (0 = выкл.)
        onlyWhenLive: true,      // покупать только когда стрим онлайн
        autoClaimBonus: true,    // автоматически собирать бонусные баллы (сундук)
        showPanelEverywhere: false, // false = показывать панель только на канале стримера
        autostart: false,        // автоматически включать при загрузке страницы
    };
    // =============================================================

    const LS_KEY = 'twitch_fishing_autobuyer_cfg';
    const LS_UI_KEY = 'twitch_fishing_autobuyer_ui';

    function loadCfg() {
        try {
            return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
        } catch (e) {
            return Object.assign({}, DEFAULTS);
        }
    }
    function saveCfg(cfg) {
        localStorage.setItem(LS_KEY, JSON.stringify(cfg));
    }
    function loadUi() {
        try {
            return Object.assign({ collapsed: false, pos: null }, JSON.parse(localStorage.getItem(LS_UI_KEY) || '{}'));
        } catch (e) {
            return { collapsed: false, pos: null };
        }
    }
    function saveUi(ui) {
        localStorage.setItem(LS_UI_KEY, JSON.stringify(ui));
    }

    const cfg = loadCfg();
    const ui = loadUi();
    let timer = null;
    let busy = false;

    function log(msg) {
        const line = `[AutoFishing ${new Date().toLocaleTimeString()}] ${msg}`;
        console.log(line);
        const logEl = document.getElementById('afb-log');
        if (logEl) {
            logEl.textContent = line;
        }
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    // ---------- Проверка канала и онлайн-статуса ----------

    function currentChannel() {
        const seg = location.pathname.split('/').filter(Boolean)[0] || '';
        const excluded = ['directory', 'settings', 'subscriptions', 'wallet', 'inventory',
                          'drops', 'friends', 'messages', 'moderator', 'dashboard', 'jobs',
                          'p', 'u', 'popout', 'embed', 'videos', 'clips', 'following', 'browse'];
        if (!seg || excluded.includes(seg.toLowerCase())) return null;
        return seg.toLowerCase();
    }

    function isOnTargetChannel() {
        const cur = currentChannel();
        return cur !== null && cur === (cfg.channel || '').trim().toLowerCase();
    }

    // Показывать ли панель на текущей странице
    function shouldShowPanel() {
        return cfg.showPanelEverywhere || isOnTargetChannel();
    }

    // Стрим онлайн, если в шапке канала есть бейдж "В ЭФИРЕ" / "LIVE"
    function isStreamLive() {
        const leafs = document.querySelectorAll('span, p, div');
        for (const el of leafs) {
            if (el.children.length > 0) continue;
            if (el.closest('#afb-panel')) continue;
            // Не считаем текст из чата
            if (el.closest('.chat-room, [data-a-target="chat-scroller"], [class*="chat-scrollable"]')) continue;
            const t = (el.textContent || '').trim().toUpperCase();
            if (t === 'LIVE' || t === 'В ЭФИРЕ') return true;
        }
        return false;
    }

    // ---------- Работа с DOM Twitch ----------

    // Баланс баллов канала (НЕ bits)
    function getBalance() {
        const el = document.querySelector('[data-test-selector="copo-balance-string"] span');
        if (el) {
            const val = parseInt((el.textContent || '').replace(/[\s\u00A0.,]/g, ''), 10);
            if (!isNaN(val)) return val;
        }
        // Запасной вариант
        const summary = document.querySelector('.community-points-summary');
        if (!summary) return null;
        const candidates = summary.querySelectorAll('span');
        let last = null;
        for (const el2 of candidates) {
            const txt = (el2.textContent || '').replace(/[\s\u00A0.,]/g, '');
            if (/^\d+$/.test(txt)) last = parseInt(txt, 10);
        }
        return last;
    }

    // Кнопка баланса, открывающая меню наград
    function findRewardsButton() {
        const byAria = document.querySelector(
            '.community-points-summary button[aria-label*="аланс"], .community-points-summary button'
        );
        if (byAria) return byAria;
        return document.querySelector('button[aria-label*="аланс Bits"], button[aria-label*="hannel Points"]');
    }

    // Открыто ли уже меню наград (есть ли элементы списка на странице)
    function isRewardsListOpen() {
        return document.querySelector('[class*="rewardListItem"]') !== null;
    }

    // Ищем награду в списке по заголовку (p[title] или img[alt]), возвращаем её button
    function findRewardInList(name) {
        const lowered = name.toLowerCase();
        const items = document.querySelectorAll('[class*="rewardListItem"]');
        for (const item of items) {
            const titleEl = item.querySelector('p[title], img[alt]');
            const title = titleEl ? (titleEl.getAttribute('title') || titleEl.getAttribute('alt') || '') : '';
            const text = title || (item.textContent || '');
            if (text.toLowerCase().includes(lowered)) {
                return item.querySelector('button') || item;
            }
        }
        // Запасной вариант: любой p[title] с названием награды
        const titled = document.querySelectorAll('p[title], img[alt]');
        for (const el of titled) {
            if (el.closest('#afb-panel')) continue;
            const t = (el.getAttribute('title') || el.getAttribute('alt') || '').toLowerCase();
            if (t.includes(lowered)) {
                const container = el.closest('button') || el.closest('[class*="rewardListItem"]');
                if (container) {
                    return container.tagName === 'BUTTON' ? container : (container.querySelector('button') || container);
                }
            }
        }
        return null;
    }

    // Кнопка подтверждения ("Активировать 50" / "Получить за ...")
    function findConfirmButton() {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            if (btn.closest('#afb-panel')) continue;
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
            const rewardText = btn.querySelector('p[data-test-selector="RewardText"]');
            const txt = ((rewardText ? rewardText.textContent : btn.textContent) || '').toLowerCase();
            if (txt.includes('активировать') || txt.includes('получить') ||
                txt.includes('обменять') || txt.includes('redeem')) {
                if (btn.closest('nav') || btn.closest('[data-a-target="top-nav-container"]')) continue;
                // Не путать с кнопкой баланса и сундуком
                if (btn.closest('.community-points-summary')) continue;
                return btn;
            }
        }
        return null;
    }

    // Бонусный сундук с баллами (появляется периодически при просмотре)
    function findBonusButton() {
        const summary = document.querySelector('.community-points-summary');
        if (!summary) return null;
        let btn = summary.querySelector('button[aria-label*="бонус" i], button[aria-label*="bonus" i]');
        if (!btn) {
            const icon = summary.querySelector('.claimable-bonus__icon, [class*="claimable"]');
            if (icon) btn = icon.closest('button');
        }
        if (btn && !btn.disabled) return btn;
        return null;
    }

    // Диагностика: выводит в консоль все кнопки, которые сейчас есть на странице
    function debugDumpButtons() {
        console.log('%c[AutoFishing] === Диагностика кнопок ===', 'color:#a970ff;font-weight:bold');
        const buttons = document.querySelectorAll('button, [role="button"]');
        let i = 0;
        for (const btn of buttons) {
            if (btn.closest('#afb-panel')) continue;
            const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
            const sel = btn.getAttribute('data-test-selector') || '';
            console.log(`[AutoFishing] #${i} disabled=${disabled} selector="${sel}" text="${txt}"`);
            if (++i >= 60) { console.log('[AutoFishing] ...обрезано...'); break; }
        }
        console.log('%c[AutoFishing] === Конец диагностики ===', 'color:#a970ff;font-weight:bold');
    }

    function pressEscape() {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        document.body.click();
    }

    // ---------- Основной цикл ----------

    async function tick() {
        if (busy) return;
        busy = true;
        try {
            // 0. Автосбор бонусного сундука (на любом канале, вредить не может)
            if (cfg.autoClaimBonus) {
                const bonus = findBonusButton();
                if (bonus) {
                    bonus.click();
                    log('Собран бонусный сундук с баллами.');
                }
            }

            if (!isOnTargetChannel()) {
                log(`Не тот канал (нужен "${cfg.channel}"). Покупка пропущена.`);
                return;
            }
            if (cfg.onlyWhenLive && !isStreamLive()) {
                log('Стрим офлайн, покупка пропущена.');
                return;
            }

            const balance = getBalance();
            if (balance === null) {
                log('Не удалось прочитать баланс баллов. Открой чат стрима и держи страницу активной.');
                return;
            }
            if (cfg.minBalance > 0 && balance < cfg.minBalance) {
                log(`Баланс ${balance} ниже порога ${cfg.minBalance}, пропуск.`);
                return;
            }
            log(`Баланс: ${balance}. Пробую купить "${cfg.rewardName}"...`);

            // 1. Открыть меню наград (если еще не открыто)
            if (!isRewardsListOpen()) {
                const rewardsBtn = findRewardsButton();
                if (!rewardsBtn) {
                    log('Не найдена кнопка баллов канала. Ты точно на странице стрима с включенным чатом?');
                    return;
                }
                rewardsBtn.click();
            }

            // 2. Ждем подгрузки списка и ищем награду (до 6 попыток по 700 мс)
            let rewardBtn = null;
            for (let i = 0; i < 6 && !rewardBtn; i++) {
                await sleep(700);
                rewardBtn = findRewardInList(cfg.rewardName);
            }
            if (!rewardBtn) {
                log(`Награда "${cfg.rewardName}" не найдена в списке (КД, отключена или изменился интерфейс).`);
                pressEscape();
                return;
            }
            if (rewardBtn.disabled || rewardBtn.getAttribute('aria-disabled') === 'true') {
                log('Награда недоступна (КД или лимит). Пропуск.');
                pressEscape();
                return;
            }
            rewardBtn.click();

            // 3. Ждем окно подтверждения и ищем кнопку (до 6 попыток по 700 мс)
            let confirm = null;
            for (let i = 0; i < 6 && !confirm; i++) {
                await sleep(700);
                confirm = findConfirmButton();
            }
            if (!confirm) {
                log('Не найдена кнопка подтверждения. Если награда НЕ на КД - открой консоль (F12) и пришли строки "Диагностика кнопок".');
                debugDumpButtons();
                pressEscape();
                return;
            }
            confirm.click();
            log('Покупка выполнена!');
            await sleep(500);
            pressEscape();
        } catch (e) {
            log('Ошибка: ' + e.message);
            pressEscape();
        } finally {
            busy = false;
        }
    }

    function start() {
        if (timer) return;
        timer = setInterval(tick, cfg.intervalSec * 1000);
        log(`Запущено: каждые ${cfg.intervalSec} сек, канал "${cfg.channel}"${cfg.onlyWhenLive ? ', только онлайн' : ''}${cfg.autoClaimBonus ? ', автосбор бонусов' : ''}.`);
        tick();
    }

    function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        log('Остановлено.');
    }

    // ---------- Панель управления ----------

    function buildPanel() {
        if (document.getElementById('afb-panel')) return;
        if (!shouldShowPanel()) return;
        if (!document.body) return;

        const panel = document.createElement('div');
        panel.id = 'afb-panel';
        // Полупрозрачный фон + блюр, фиксированная ширина, скругленные углы
        panel.style.cssText = [
            'position:fixed', 'z-index:2147483647',
            'background:#111c', 'color:#eee',
            'border-radius:8px', 'border:1px solid #9147ff',
            'font:12px system-ui, Segoe UI, Roboto, Arial',
            'backdrop-filter:blur(4px)', 'box-shadow:0 2px 10px rgba(0,0,0,.4)',
            'user-select:none', 'width:250px'
        ].join(';');

        const inputStyle = 'width:110px;text-align:left;border-radius:4px;border:1px solid #555;background:#222;color:#eee;padding:2px 4px;';
        const numStyle = 'width:60px;text-align:right;border-radius:4px;border:1px solid #555;background:#222;color:#eee;padding:2px 4px;';

        panel.innerHTML = `
            <div id="afb-header" style="display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:move;">
                <strong style="font-weight:600;">🎣 Рыбалка:</strong>
                <span id="afb-status" style="opacity:.9;">выкл</span>
                <div style="flex:1;"></div>
                <button id="afb-collapse" title="Свернуть/развернуть" style="background:#222;color:#eee;border:0;border-radius:6px;padding:2px 6px;cursor:pointer;">–</button>
            </div>
            <div id="afb-body" style="display:flex;flex-direction:column;gap:8px;padding:8px;">
                <label style="display:flex;justify-content:space-between;align-items:center;">
                    <span>Стример:</span>
                    <input id="afb-channel" type="text" style="${inputStyle}">
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;">
                    <span>Награда:</span>
                    <input id="afb-name" type="text" style="${inputStyle}">
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;">
                    <span>Интервал, сек:</span>
                    <input id="afb-interval" type="number" min="10" style="${numStyle}">
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;">
                    <span>Мин. баланс:</span>
                    <input id="afb-minbal" type="number" min="0" style="${numStyle}">
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <span>Только когда онлайн:</span>
                    <input id="afb-live" type="checkbox">
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <span>Собирать бонусы:</span>
                    <input id="afb-bonus" type="checkbox">
                </label>
                <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
                    <span>Панель на всех страницах:</span>
                    <input id="afb-everywhere" type="checkbox">
                </label>
                <button id="afb-toggle" style="width:100%;padding:5px;border:none;border-radius:6px;cursor:pointer;font-weight:600;background:#9147ff;color:#fff;">Включить</button>
                <div id="afb-log" style="font-size:11px;color:#a970ff;word-break:break-word;max-height:60px;overflow:hidden;"></div>
                <div style="font-size:10px;color:#888;text-align:right;">by toshaToffifee</div>
            </div>
        `;
        document.body.appendChild(panel);

        const body = panel.querySelector('#afb-body');
        const header = panel.querySelector('#afb-header');
        const collapseBtn = panel.querySelector('#afb-collapse');
        const statusEl = panel.querySelector('#afb-status');

        // Сворачивание: кнопка "–"/"+", обводка только в развернутом виде
        function applyCollapsed() {
            body.style.display = ui.collapsed ? 'none' : 'flex';
            collapseBtn.textContent = ui.collapsed ? '+' : '–';
            panel.style.border = ui.collapsed ? '1px solid transparent' : '1px solid #9147ff';
        }
        collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            ui.collapsed = !ui.collapsed;
            saveUi(ui);
            applyCollapsed();
        });

        // Перетаскивание за заголовок (pointer-события); клик без движения сворачивает
        let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
        header.addEventListener('pointerdown', (e) => {
            if (e.target === collapseBtn) return;
            dragging = true;
            moved = false;
            header.setPointerCapture(e.pointerId);
            const r = panel.getBoundingClientRect();
            ox = e.clientX; oy = e.clientY;
            sx = r.left; sy = r.top;
        });
        header.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - ox, dy = e.clientY - oy;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
            panel.style.left = clamp(sx + dx, 0, innerWidth - panel.offsetWidth) + 'px';
            panel.style.top = clamp(sy + dy, 0, innerHeight - panel.offsetHeight) + 'px';
        });
        header.addEventListener('pointerup', (e) => {
            if (!dragging) return;
            dragging = false;
            header.releasePointerCapture(e.pointerId);
            if (moved) {
                const r = panel.getBoundingClientRect();
                ui.pos = { left: r.left, top: r.top };
                saveUi(ui);
            } else if (e.target !== collapseBtn) {
                ui.collapsed = !ui.collapsed;
                saveUi(ui);
                applyCollapsed();
            }
        });

        window.addEventListener('resize', () => {
            const r = panel.getBoundingClientRect();
            panel.style.left = clamp(r.left, 0, innerWidth - panel.offsetWidth) + 'px';
            panel.style.top = clamp(r.top, 0, innerHeight - panel.offsetHeight) + 'px';
        });

        const chInput = panel.querySelector('#afb-channel');
        const nameInput = panel.querySelector('#afb-name');
        const intInput = panel.querySelector('#afb-interval');
        const minInput = panel.querySelector('#afb-minbal');
        const liveInput = panel.querySelector('#afb-live');
        const bonusInput = panel.querySelector('#afb-bonus');
        const everywhereInput = panel.querySelector('#afb-everywhere');
        const toggleBtn = panel.querySelector('#afb-toggle');

        chInput.value = cfg.channel;
        nameInput.value = cfg.rewardName;
        intInput.value = cfg.intervalSec;
        minInput.value = cfg.minBalance;
        liveInput.checked = cfg.onlyWhenLive;
        bonusInput.checked = cfg.autoClaimBonus;
        everywhereInput.checked = cfg.showPanelEverywhere;

        function syncCfg() {
            cfg.channel = chInput.value.trim().toLowerCase() || DEFAULTS.channel;
            cfg.rewardName = nameInput.value.trim() || DEFAULTS.rewardName;
            cfg.intervalSec = Math.max(10, parseInt(intInput.value, 10) || DEFAULTS.intervalSec);
            cfg.minBalance = Math.max(0, parseInt(minInput.value, 10) || 0);
            cfg.onlyWhenLive = liveInput.checked;
            cfg.autoClaimBonus = bonusInput.checked;
            cfg.showPanelEverywhere = everywhereInput.checked;
            saveCfg(cfg);
        }
        chInput.addEventListener('input', syncCfg);
        nameInput.addEventListener('input', syncCfg);
        liveInput.addEventListener('change', syncCfg);
        bonusInput.addEventListener('change', syncCfg);
        everywhereInput.addEventListener('change', syncCfg);
        intInput.addEventListener('change', () => {
            syncCfg();
            if (timer) { stop(); start(); }
        });
        minInput.addEventListener('change', syncCfg);

        function applyToggleState() {
            toggleBtn.textContent = timer ? 'Выключить' : 'Включить';
            toggleBtn.style.background = timer ? '#e91916' : '#9147ff';
            statusEl.textContent = timer ? 'вкл' : 'выкл';
            statusEl.style.color = timer ? '#5fd35f' : '#ff5f5f';
            statusEl.style.fontWeight = '600';
        }

        toggleBtn.addEventListener('click', () => {
            syncCfg();
            if (timer) {
                stop();
            } else {
                start();
            }
            applyToggleState();
        });

        // Начальная позиция: правый нижний угол, если не сохранена
        if (ui.pos) {
            panel.style.left = clamp(ui.pos.left, 0, innerWidth - panel.offsetWidth) + 'px';
            panel.style.top = clamp(ui.pos.top, 0, innerHeight - panel.offsetHeight) + 'px';
        } else {
            const r = panel.getBoundingClientRect();
            panel.style.left = Math.max(0, innerWidth - r.width - 12) + 'px';
            panel.style.top = Math.max(0, innerHeight - r.height - 12) + 'px';
        }

        applyCollapsed();
        applyToggleState();

        if (cfg.autostart) {
            start();
            applyToggleState();
        }
    }

    function removePanel() {
        const panel = document.getElementById('afb-panel');
        if (panel) panel.remove();
    }

    // Twitch - SPA, следим за навигацией: создаем/убираем панель по странице
    const observer = new MutationObserver(() => {
        if (!document.body) return;
        const panel = document.getElementById('afb-panel');
        if (!panel && shouldShowPanel()) {
            buildPanel();
        } else if (panel && !shouldShowPanel()) {
            removePanel();
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    buildPanel();
})();
