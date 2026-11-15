// ==UserScript==
// @name         Twitch Fishing Auto-Buyer (gans_mann)
// @namespace    local.twitch.fishing
// @version      1.8
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
            log('Покупка выполнена! Смотри чат: должно прийти "Поймана рыба".');
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

        const panel = document.createElement('div');
        panel.id = 'afb-panel';
        panel.style.cssText = [
            'position:fixed', 'z-index:99999',
            'background:#18181b', 'color:#efeff1', 'border:1px solid #9147ff',
            'border-radius:8px', 'padding:8px 10px', 'font:13px/1.4 sans-serif',
            'box-shadow:0 2px 10px rgba(0,0,0,.5)'
        ].join(';');
        if (ui.pos) {
            panel.style.left = ui.pos.left + 'px';
            panel.style.top = ui.pos.top + 'px';
        } else {
            panel.style.bottom = '80px';
            panel.style.right = '16px';
        }

        panel.innerHTML = `
            <div id="afb-header" style="display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:move;user-select:none;">
                <span style="font-weight:700;">🎣 Авто-рыбалка</span>
                <button id="afb-collapse" title="Свернуть/развернуть" style="background:none;border:none;color:#a970ff;cursor:pointer;font-size:14px;padding:0 2px;">–</button>
            </div>
            <div id="afb-body" style="width:250px;margin-top:6px;">
                <label style="display:block;margin:4px 0;">
                    Стример: <input id="afb-channel" type="text" style="width:130px;background:#0e0e10;color:#fff;border:1px solid #53535f;border-radius:4px;padding:2px 4px;">
                </label>
                <label style="display:block;margin:4px 0;">
                    Награда: <input id="afb-name" type="text" style="width:130px;background:#0e0e10;color:#fff;border:1px solid #53535f;border-radius:4px;padding:2px 4px;">
                </label>
                <label style="display:block;margin:4px 0;">
                    Интервал, сек: <input id="afb-interval" type="number" min="10" style="width:60px;background:#0e0e10;color:#fff;border:1px solid #53535f;border-radius:4px;padding:2px 4px;">
                </label>
                <label style="display:block;margin:4px 0;">
                    Мин. баланс: <input id="afb-minbal" type="number" min="0" style="width:60px;background:#0e0e10;color:#fff;border:1px solid #53535f;border-radius:4px;padding:2px 4px;">
                </label>
                <label style="display:flex;align-items:center;gap:6px;margin:6px 0;cursor:pointer;">
                    <input id="afb-live" type="checkbox"> Только когда стрим онлайн
                </label>
                <label style="display:flex;align-items:center;gap:6px;margin:6px 0;cursor:pointer;">
                    <input id="afb-bonus" type="checkbox"> Собирать бонусные баллы
                </label>
                <label style="display:flex;align-items:center;gap:6px;margin:6px 0;cursor:pointer;">
                    <input id="afb-everywhere" type="checkbox"> Панель на всех страницах Twitch
                </label>
                <div style="margin:8px 0;">
                    <button id="afb-toggle" style="width:100%;padding:5px;border:none;border-radius:4px;cursor:pointer;font-weight:700;background:#9147ff;color:#fff;">Включить</button>
                </div>
                <div id="afb-log" style="font-size:11px;color:#a970ff;word-break:break-word;max-height:60px;overflow:hidden;"></div>
                <div style="font-size:10px;color:#8b8b93;text-align:right;margin-top:6px;">by toshaToffifee</div>
            </div>
        `;
        document.body.appendChild(panel);

        const body = panel.querySelector('#afb-body');
        const header = panel.querySelector('#afb-header');
        const collapseBtn = panel.querySelector('#afb-collapse');

        // Сворачивание
        function applyCollapsed() {
            body.style.display = ui.collapsed ? 'none' : 'block';
            collapseBtn.textContent = ui.collapsed ? '▲' : '–';
        }
        collapseBtn.addEventListener('click', () => {
            ui.collapsed = !ui.collapsed;
            saveUi(ui);
            applyCollapsed();
        });
        applyCollapsed();

        // Перетаскивание за заголовок
        let drag = null;
        header.addEventListener('mousedown', (e) => {
            if (e.target === collapseBtn) return;
            const rect = panel.getBoundingClientRect();
            drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!drag) return;
            drag.moved = true;
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
            panel.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx)) + 'px';
            panel.style.top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - drag.dy)) + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (drag && drag.moved) {
                ui.pos = { left: parseInt(panel.style.left, 10), top: parseInt(panel.style.top, 10) };
                saveUi(ui);
            }
            drag = null;
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
        chInput.addEventListener('change', syncCfg);
        nameInput.addEventListener('change', syncCfg);
        liveInput.addEventListener('change', syncCfg);
        bonusInput.addEventListener('change', syncCfg);
        everywhereInput.addEventListener('change', syncCfg);
        intInput.addEventListener('change', () => {
            syncCfg();
            if (timer) { stop(); start(); }
        });
        minInput.addEventListener('change', syncCfg);

        toggleBtn.addEventListener('click', () => {
            syncCfg();
            if (timer) {
                stop();
            } else {
                start();
            }
            toggleBtn.textContent = timer ? 'Выключить' : 'Включить';
            toggleBtn.style.background = timer ? '#e91916' : '#9147ff';
        });

        if (cfg.autostart) {
            start();
            toggleBtn.textContent = 'Выключить';
            toggleBtn.style.background = '#e91916';
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
