(function() {
    'use strict';

    // ================== НАСТРОЙКИ ==================

    // Твой числовой id ВК, куда приходят уведомления. vk.com/id123456789
    const VK_USER_ID = 12345678;

    // API-токен сообщества ВК с правами на отправку сообщений.
    const VK_ACCESS_TOKEN = 'token';

    // Интервал проверки в секундах.
    // Фактическая пауза = интервал ± 25% случайного разброса, минимум 20 секунд.
    const BASE_INTERVAL_SECONDS = 130;

    // Присылать ли блок "ПРОПАЛИ" в VK
    const SEND_REMOVED = true;

    // Отслеживаемые товары (поиск по вхождению, case-insensitive)
    const TRACKED = ['арбуз', 'укроп'];
    const TRACKED_LC = TRACKED.map(x => x.toLowerCase());

    // ==============================================

    // ---------- глобальный реестр (общий для всех запусков) ----------
    if (!window.__vvGreenLabelsRegistry) {
        window.__vvGreenLabelsRegistry = {
            timerIds: new Set(),
            stopped: false,
            running: 0
        };
    }
    const registry = window.__vvGreenLabelsRegistry;

    // Если уже работает — не плодим второй экземпляр
    if (registry.running > 0) {
        console.warn(
            '%c[ВНИМАНИЕ] Мониторинг уже запущен. Сначала останови: stopGreenLabelsMonitor()',
            'color:#FF9800;font-weight:bold;'
        );
        return;
    }

    const API_URL = 'https://vkusvill.ru/ajax/delivery_order/cart_prods_modal/template.php';
    const API_BODY = new URLSearchParams({
        inited: 'Y',
        PRODUCTS: '',
        TYPE: 'GreenLabels',
        ORIGIN: 'cartpage',
        IS_APP: ''
    }).toString();

    let previousItems = new Set();
    let isFirstRun = true;
    let busy = false;

    registry.stopped = false;
    registry.running++;

    // ---------- VK ----------
    async function sendToVK(msgText) {
        try {
            const randomId = Math.floor(Math.random() * 2147483647) + 1;
            const body = new URLSearchParams({
                user_id: VK_USER_ID,
                message: msgText,
                random_id: randomId,
                v: '5.131',
                access_token: VK_ACCESS_TOKEN
            });
            await fetch('https://api.vk.com/method/messages.send', {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body
            });
            console.log('%c[VK]: запрос отправлен.', 'color:#00bcd4;');
        } catch (err) {
            console.error('[VK ОШИБКА]', err);
        }
    }

    // ---------- утилиты ----------
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    function decodeHtmlEntities(str) {
        const ta = document.createElement('textarea');
        ta.innerHTML = str;
        return ta.value;
    }

    function normalizeTitle(raw) {
        if (!raw) return '';
        let s = decodeHtmlEntities(raw);
        s = s.replace(/[\s\u00A0\u2009\u202F\u200B]+/gu, ' ');
        return s.trim();
    }

    function matchTracked(title) {
        const lc = title.toLowerCase();
        return TRACKED_LC.some(k => lc.includes(k));
    }

    // ---------- запрос к API ----------
    // Возвращает { items: Set<string>, empty: boolean }
    // empty === true — сервер вернул валидный ответ "товаров нет"
    async function fetchGreenLabels() {
        const resp = await fetch(API_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: API_BODY
        });

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }

        if (resp.redirected) {
            console.warn('[API] запрос был перенаправлен на', resp.url,
                '— вероятно, сервер не принял сессию/Referer');
        }

        const text = await resp.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            const items = parseItemsFromHtml(text);
            if (items.size > 0) {
                console.warn('[API] ответ не JSON, но товары в HTML найдены:', items.size);
                return { items, empty: false };
            }
            throw new Error('API вернул не JSON и без товаров: ' +
                text.slice(0, 200).replace(/\s+/g, ' '));
        }

        // Явная ошибка от сервера
        if (data && data.error_text && !data.html) {
            throw new Error(`API error: ${data.error_text}`);
        }

        // Валидный ответ с пустым html — товаров нет
        if (data && (data.html === '' || data.html == null)) {
            return { items: new Set(), empty: true };
        }

        // Валидный ответ с html — парсим
        if (typeof data.html === 'string' && data.html.trim()) {
            const items = parseItemsFromHtml(data.html);
            // html непустой, но карточек нет — тоже считаем "товаров нет"
            return { items, empty: items.size === 0 };
        }

        throw new Error('API вернул неожиданный ответ');
    }

    // ---------- парсинг HTML-фрагмента ----------
    function parseItemsFromHtml(html) {
        const items = new Set();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('.ProductCard a.ProductCard__link').forEach(link => {
            const clean = normalizeTitle(link.getAttribute('title'));
            if (clean) items.add(clean);
        });
        return items;
    }

    // ---------- одна итерация ----------
    async function runIteration() {
        if (registry.stopped) {
            console.log('%c[STOP] итерация не запущена — мониторинг остановлен.', 'color:#757575;');
            return;
        }
        if (busy) {
            console.warn('[SKIP] предыдущая итерация ещё идёт');
            return;
        }
        busy = true;
        console.log(`[%c${new Date().toLocaleTimeString()}%c] итерация…`,
            'color:#4CAF50;font-weight:bold;', '');

        try {
            const { items: currentItems, empty } = await fetchGreenLabels();

            if (registry.stopped) {
                console.log('%c[STOP] остановлено во время запроса.', 'color:#757575;');
                return;
            }

            const added = [];
            const removed = [];
            currentItems.forEach(x => { if (!previousItems.has(x)) added.push(x); });
            if (!isFirstRun) {
                previousItems.forEach(x => { if (!currentItems.has(x)) removed.push(x); });
            }

            const hasTracked = [...currentItems].some(matchTracked);
            const trackedHeader = hasTracked
                ? '⭐ Есть отслеживаемые товары.\n\n'
                : '';

            // -------- пустой список --------
            if (empty) {
                if (isFirstRun) {
                    console.log('%c[ПЕРВЫЙ ЗАПУСК] зелёных ценников сейчас нет.',
                        'color:#2196F3;font-weight:bold;');
                    sendToVK('🚀 ВкусВилл: первый запуск\nЗелёных ценников сейчас нет.');
                    isFirstRun = false;
                } else if (previousItems.size === 0) {
                    console.log('%cЗелёных ценников нет. Изменений нет.', 'color:#757575;');
                } else {
                    console.log(`%cЗелёных ценников не осталось. Пропало: ${removed.length}`,
                        'color:#F44336;font-weight:bold;');
                    removed.forEach(x => console.log(`  - ${x}`));

                    if (SEND_REMOVED) {
                        sendToVK(
                            `🔔 Изменение Зелёных ценников!\n\n➖ ПРОПАЛИ:\n${removed.map(x => `• ${x}`).join('\n')}`
                        );
                    } else {
                        console.log('%cSEND_REMOVED=false — в VK ничего не отправлено.',
                            'color:#757575;');
                    }
                }

                previousItems = currentItems; // пустой Set
                return;
            }

            // -------- непустой список --------
            if (isFirstRun) {
                console.log(`%c[ПЕРВЫЙ ЗАПУСК] товаров: ${currentItems.size}`,
                    'color:#2196F3;font-weight:bold;');
                const list = [...currentItems];
                list.forEach((x, i) => {
                    const mark = matchTracked(x) ? '⭐ ' : '';
                    console.log(`  ${i + 1}. ${mark}${x}`);
                });
                const body = list.map((x, i) =>
                    `${i + 1}. ${matchTracked(x) ? '⭐ ' : ''}${x}`
                ).join('\n');
                sendToVK(
                    `${trackedHeader}🚀 ВкусВилл: первый запуск\nТекущие зелёные ценники (${currentItems.size}):\n${body}`
                );
                isFirstRun = false;
            } else if (added.length === 0 && removed.length === 0) {
                console.log('%cИзменений нет.', 'color:#757575;');
                if (hasTracked) {
                    console.log('%c⭐ Среди них есть отслеживаемые.', 'color:#FFC107;font-weight:bold;');
                }
            } else {
                const parts = [];
                if (added.length) {
                    console.log(`%c[+] добавилось (${added.length})`,
                        'color:#4CAF50;font-weight:bold;');
                    added.forEach(x => {
                        const mark = matchTracked(x) ? '⭐ ' : '';
                        console.log(`  + ${mark}${x}`);
                    });
                    parts.push(`➕ ДОБАВИЛИСЬ:\n${added.map(x =>
                        `• ${matchTracked(x) ? '⭐ ' : ''}${x}`).join('\n')}`);
                }
                if (removed.length) {
                    console.log(`%c[-] пропало (${removed.length})`,
                        'color:#F44336;font-weight:bold;');
                    removed.forEach(x => console.log(`  - ${x}`));
                    if (SEND_REMOVED) {
                        parts.push(`➖ ПРОПАЛИ:\n${removed.map(x => `• ${x}`).join('\n')}`);
                    }
                }

                if (parts.length === 0) {
                    console.log('%cПропавшие есть, но SEND_REMOVED=false — в VK ничего не отправлено.',
                        'color:#757575;');
                } else {
                    sendToVK(
                        `${trackedHeader}🔔 Изменение Зелёных ценников!\n\n${parts.join('\n\n')}`
                    );
                }
            }

            previousItems = currentItems;

        } catch (err) {
            console.error('%c[ОШИБКА]:', 'color:#f44336;font-weight:bold;', err.message);
            if (!isFirstRun && !registry.stopped) {
                sendToVK(`⚠️ ВкусВилл: ошибка мониторинга\n${err.message}`);
            }
        } finally {
            busy = false;
            if (registry.stopped) {
                console.log('%c[STOP] следующая итерация не планируется.', 'color:#757575;');
                return;
            }
            const base = BASE_INTERVAL_SECONDS * 1000;
            const jitter = rand(-Math.floor(base * 0.25), Math.floor(base * 0.25));
            scheduleNext(Math.max(20000, base + jitter));
        }
    }

    function scheduleNext(delayMs) {
        if (registry.stopped) return;
        console.log(`Следующая проверка через %c${(delayMs / 1000).toFixed(1)} с%c… стоп: %cstopGreenLabelsMonitor()`,
            'color:#9C27B0;font-weight:bold;', '',
            'color:#f44336;font-weight:bold;font-family:monospace;');
        const id = setTimeout(runIteration, delayMs);
        registry.timerIds.add(id);
    }

    // ---------- глобальная остановка ----------
    window.stopGreenLabelsMonitor = function() {
        console.log('%c[STOP] останавливаю мониторинг…', 'color:#F44336;font-weight:bold;');
        registry.stopped = true;

        let cleared = 0;
        registry.timerIds.forEach(id => {
            clearTimeout(id);
            cleared++;
        });
        registry.timerIds.clear();
        registry.running = 0;

        console.log(`%cМониторинг остановлен. Очищено таймеров: ${cleared}.`,
            'color:#F44336;font-weight:bold;');
    };

    // старт
    runIteration();
})();