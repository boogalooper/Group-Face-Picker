#target photoshop
/*
// BEGIN__HARVEST_EXCEPTION_ZSTRING
<javascriptresource>
<name>Group Face Picker (use SHIFT to view settings)</name>
<eventid>9a189321-e07f-40ff-8394-156a4bd48cf5</eventid>
<terminology><![CDATA[<< /Version 1
                       /Events <<
                       /9a189321-e07f-40ff-8394-156a4bd48cf5 [(Group Face Picker) <<
                       /gfpActionMarker [(action marker) /boolean]
                       >>]
                        >>
                     >> ]]></terminology>
</javascriptresource>
// END__HARVEST_EXCEPTION_ZSTRING
*/

var GFP_NAME = "Group Face Picker";
var GFP_UUID = "9a189321-e07f-40ff-8394-156a4bd48cf5";
var GFP_VERSION = "0.6.5";
var GFP_DEFAULT_HOST = "127.0.0.1";
var GFP_DEFAULT_PORT_SEND = 6420;
var GFP_DEFAULT_PORT_LISTEN = 6421;
var GFP_API_HOST = GFP_DEFAULT_HOST;
var GFP_API_PORT_SEND = GFP_DEFAULT_PORT_SEND;
var GFP_API_PORT_LISTEN = GFP_DEFAULT_PORT_LISTEN;
var GFP_API_TIMEOUT = 10000;
var GFP_JOB_TIMEOUT = 60 * 60 * 1000;
var GFP_PENDING_JOB_ID = "";
var GFP_PENDING_JOB_RESULT = null;
var GFP_PENDING_JOB_ERROR = null;
var GFP_PENDING_JOB_CANCELLED = false;
var GFP_PENDING_SETTINGS_JOB_ID = "";
var GFP_PENDING_SETTINGS_RESULT = null;
var GFP_PENDING_SETTINGS_ERROR = null;
var GFP_PENDING_SETTINGS_CANCELLED = false;
var GFP_SETTINGS_APPLY_HOST = "";
var GFP_SETTINGS_APPLY_PORT = 0;
var GFP_SERVER_START_OK = false;
var GFP_SERVER_START_ERROR = "";
var GFP_SERVER_START_RESPONSE = null;
var GFP_SERVER_START_CANCELLED = false;
var GFP_SERVER_START_TIMEOUT = 120000;
var GFP_LAST_SERVER_LAUNCHER = "";
var GFP_S2T = stringIDToTypeID;
var GFP_KEYBOARD_STATE = ScriptUI.environment.keyboardState;
var GFP_SHIFT_LAUNCH = !!(GFP_KEYBOARD_STATE && GFP_KEYBOARD_STATE.shiftKey);
var GFP_SETTINGS = gfpLoadConfig();
gfpApplyConfig(GFP_SETTINGS);

try {
    // Как в img2img helper: Shift действует только на текущий запуск.
    // Для Group Face Picker это короткий путь непосредственно к настройкам;
    // основной поиск/вставка в этот запуск не выполняются.
    if (GFP_SHIFT_LAUNCH) {
        gfpShowSettingsDialog();
    } else {
        gfpMain();
    }
} catch (e) {
    alert(gfpErrorText(e), GFP_NAME, true);
} finally {
    // Наличие playbackParameters заставляет Photoshop записывать запуск как
    // собственное Script Event в Actions, а не как безымянный Javascript шаг.
    gfpWritePlaybackParameters();
}

function gfpWritePlaybackParameters() {
    try {
        var desc = new ActionDescriptor();
        desc.putBoolean(GFP_S2T("gfpActionMarker"), GFP_UUID.length > 0);
        // Это тот же Photoshop-механизм, который затем доступен для чтения как
        // app.playbackParameters. Используем проверенную ExtendScript-форму
        // присваивания, применяемую при записи параметров Script Event.
        playbackParameters = desc;
        return true;
    } catch (e) {
        // Ошибка записи Action-параметра не должна ломать основную функцию.
        return false;
    }
}

function gfpMain() {
    if (!app.documents.length) {
        throw new Error("Откройте групповую фотографию и выделите лицо ребёнка.");
    }

    // Полностью проверяем документ ДО любого обращения к Python-серверу.
    // gfpReadPhotoshopState() проверяет RGB, существующий исходный файл и
    // реальное активное выделение (включая случай Quick Mask).
    var state = gfpReadPhotoshopState();

    try {
        var ping = gfpEnsureServerAvailable();
        if (GFP_SERVER_START_CANCELLED) {
            gfpClearSelectionAfterCancel(state);
            return;
        }
        if (!ping || ping.type != "answer") {
            var startupDetails = GFP_LAST_SERVER_LAUNCHER ? ("\n\nПроверенный путь автозапуска:\n" + GFP_LAST_SERVER_LAUNCHER) : "";
            if (confirm("Python-сервер не запущен или недоступен по текущему адресу. Автоматический запуск не удался." + startupDetails + "\n\nОткрыть настройки подключения?")) {
                // Чтение Quick Mask могло временно перевести документ в обычный
                // режим выделения. Настройки не должны оставлять документ изменённым.
                gfpRestoreQuickMaskState(state);
                gfpShowSettingsDialog();
                return;
            }
            throw new Error("Python-сервер недоступен. Запустите run_server.bat вручную и повторите запуск скрипта.");
        }
        if (ping.message && ping.message.version && String(ping.message.version) != GFP_VERSION) {
            throw new Error("Версия запущенного Python-сервера (" + String(ping.message.version) + ") не совпадает с версией JSX (" + GFP_VERSION + ").\n\nПерезапустите run_server.bat из этой же папки скрипта. Старый процесс сервера может оставаться запущенным после обновления файлов.");
        }

        var response = gfpApiRequest({
            command: "select",
            source_path: state.sourcePath,
            source_xmp: state.sourceXmp,
            doc_width: state.docWidth,
            doc_height: state.docHeight,
            selection: state.selection
        }, GFP_API_TIMEOUT);

        if (!response) {
            throw new Error("Python-сервер не ответил.");
        }
        if (response.type == "error") {
            throw new Error(response.message);
        }

        var result = null;
        if (response.type == "job") {
            GFP_PENDING_JOB_ID = String(response.message.job_id || "");
            GFP_PENDING_JOB_RESULT = null;
            GFP_PENDING_JOB_ERROR = null;
            GFP_PENDING_JOB_CANCELLED = false;
            if (!GFP_PENDING_JOB_ID) {
                throw new Error("Сервер не вернул идентификатор анализа.");
            }
            try {
                app.doForcedProgress("Подготовка превью лиц", "gfpPollSelectionJob();");
            } catch (progressError) {
                if (gfpIsUserCancelError(progressError)) {
                    GFP_PENDING_JOB_CANCELLED = true;
                    gfpCancelServerJob(GFP_PENDING_JOB_ID);
                } else {
                    throw progressError;
                }
            }
            if (GFP_PENDING_JOB_CANCELLED) {
                gfpClearSelectionAfterCancel(state);
                return;
            }
            if (GFP_PENDING_JOB_ERROR) {
                throw new Error(GFP_PENDING_JOB_ERROR);
            }
            result = GFP_PENDING_JOB_RESULT;
        } else if (response.type == "answer") {
            result = response.message;
        }

        if (!result || !result.previews || !result.previews.items || !result.query_id) {
            throw new Error("Сервер вернул неполный результат анализа.");
        }

        var payload = {
            app_name: GFP_NAME,
            version: GFP_VERSION,
            query_id: result.query_id,
            previews: result.previews,
            matches: result.matches,
            target: {
                document_id: state.documentId,
                source_path: state.sourcePath,
                doc_width: state.docWidth,
                doc_height: state.docHeight,
                selection: state.selection,
                selection_mask: state.selectionMask,
                quick_mask: state.quickMask
            }
        };

        var selectedIndex = -1;
        try {
            selectedIndex = gfpShowDialog(payload);
            if (selectedIndex >= 0) {
                var inserted = gfpInsertCandidate(payload, selectedIndex);
                if (inserted && payload.collect_statistics === true) {
                    gfpRecordPreference(payload, selectedIndex);
                }
            }
        } finally {
            gfpApiFire({ command: "release_query", query_id: payload.query_id });
        }

        // Отмена главного окна всегда оставляет целевой документ в нейтральном
        // состоянии: обычный режим (не Quick Mask) и без активного выделения.
        if (selectedIndex < 0) {
            gfpClearSelectionAfterCancel(state);
        }
    } catch (mainError) {
        // Любая ошибка после preflight, включая запуск/проверку сервера, не
        // должна оставлять Quick Mask в изменённом состоянии.
        gfpRestoreQuickMaskState(state);
        throw mainError;
    }
}

function gfpPollSelectionJob() {
    var started = (new Date()).getTime();
    var consecutiveNetworkFailures = 0;
    for (;;) {
        if ((new Date()).getTime() - started > GFP_JOB_TIMEOUT) {
            GFP_PENDING_JOB_ERROR = "Превышено время ожидания анализа и подготовки превью.";
            return false;
        }

        var response = gfpApiRequest({ command: "job_status", job_id: GFP_PENDING_JOB_ID }, 1500);
        if (!response) {
            consecutiveNetworkFailures++;
            if (consecutiveNetworkFailures >= 2) {
                GFP_PENDING_JOB_ERROR = "Python-сервер дважды подряд не ответил во время подготовки превью.";
                return false;
            }
            app.changeProgressText("Временный сбой связи с сервером; повтор запроса...");
            $.sleep(250);
            continue;
        }
        consecutiveNetworkFailures = 0;
        if (response.type == "error") {
            GFP_PENDING_JOB_ERROR = String(response.message || "Ошибка анализа.");
            return false;
        }

        var status = response.message || {};
        var progress = Math.max(0, Math.min(1, Number(status.progress) || 0));
        if (!gfpUpdateNativeProgress(Math.round(progress * 1000), 1000, String(status.text || "Подготовка превью лиц..."))) {
            GFP_PENDING_JOB_CANCELLED = true;
            gfpCancelServerJob(GFP_PENDING_JOB_ID);
            return false;
        }

        if (status.status == "done") {
            if (!gfpUpdateNativeProgress(1000, 1000, "Превью готовы.")) {
                GFP_PENDING_JOB_CANCELLED = true;
                return false;
            }
            GFP_PENDING_JOB_RESULT = status.result;
            return true;
        }
        if (status.status == "cancelled" || status.status == "cancelling") {
            GFP_PENDING_JOB_CANCELLED = true;
            return false;
        }
        if (status.status == "error") {
            GFP_PENDING_JOB_ERROR = String(status.error || "Ошибка анализа.");
            return false;
        }
        $.sleep(120);
    }
}

function gfpReadPhotoshopState() {
    var doc = app.activeDocument;

    if (doc.mode != DocumentMode.RGB) {
        throw new Error("Активный документ должен быть в режиме RGB.");
    }

    var sourceFile = null;

    try {
        sourceFile = doc.fullName;
    } catch (e) {
        sourceFile = null;
    }

    if (!sourceFile || !sourceFile.exists) {
        throw new Error("Активный документ должен быть открыт из существующего файла на диске.");
    }

    var quickMaskActive = gfpGetBooleanDocumentProperty("quickMask");
    var quickMaskOuterBounds = null;
    var quickMaskWasCleared = false;
    try {
        if (quickMaskActive) {
            // Поведение повторяет img2img helper: если Quick Mask была включена
            // поверх исходного выделения, до clearEvent её bounds задают внешний
            // прямоугольник фрагмента. После clearEvent текущая selection содержит
            // уже фактическую (в том числе непрямоугольную) форму маски слоя.
            try {
                quickMaskOuterBounds = doc.selection.bounds;
            } catch (quickMaskBoundsError) {
                quickMaskOuterBounds = null;
            }
            gfpQuickMask("clearEvent");
            quickMaskWasCleared = true;
        }

        var actualBounds = null;
        try {
            actualBounds = doc.selection.bounds;
        } catch (selectionBoundsError) {
            actualBounds = null;
        }

        if (!actualBounds || actualBounds.length < 4) {
            throw new Error("Сначала выделите лицо прямоугольным выделением или через быструю маску.");
        }

        var bounds = quickMaskOuterBounds && quickMaskOuterBounds.length >= 4 ? quickMaskOuterBounds : actualBounds;
        var selection = {
            left: Math.round(bounds[0].as("px")),
            top: Math.round(bounds[1].as("px")),
            right: Math.round(bounds[2].as("px")),
            bottom: Math.round(bounds[3].as("px"))
        };

        if (selection.right <= selection.left || selection.bottom <= selection.top) {
            throw new Error("Выделение пустое.");
        }

        return {
            documentId: gfpGetDocumentId(),
            sourcePath: sourceFile.fsName,
            sourceXmp: gfpIsRawPath(sourceFile.fsName) ? gfpReadDocumentXmp(doc) : "",
            docWidth: Math.round(doc.width.as("px")),
            docHeight: Math.round(doc.height.as("px")),
            selection: selection,
            selectionMask: true,
            quickMask: quickMaskActive
        };
    } catch (stateError) {
        if (quickMaskWasCleared) {
            try {
                gfpQuickMask("set");
            } catch (restoreQuickMaskError) {
            }
        }
        throw stateError;
    }
}

function gfpIsRawPath(path) {
    var name = String(path || "").toLowerCase();
    return /\.(cr2|cr3|nef|arw|dng|raf|rw2|orf)$/.test(name);
}

function gfpReadDocumentXmp(doc) {
    try {
        if (doc && doc.xmpMetadata && doc.xmpMetadata.rawData) {
            return String(doc.xmpMetadata.rawData);
        }
    } catch (e) {
    }
    return "";
}

function gfpGetDocumentId() {
    var property = GFP_S2T("documentID");
    var ref = new ActionReference();
    ref.putProperty(GFP_S2T("property"), property);
    ref.putEnumerated(GFP_S2T("document"), GFP_S2T("ordinal"), GFP_S2T("targetEnum"));
    return executeActionGet(ref).getInteger(property);
}

function gfpGetBooleanDocumentProperty(name) {
    var property = GFP_S2T(name);
    var ref = new ActionReference();
    ref.putProperty(GFP_S2T("property"), property);
    ref.putEnumerated(GFP_S2T("document"), GFP_S2T("ordinal"), GFP_S2T("targetEnum"));
    try {
        return executeActionGet(ref).getBoolean(property);
    } catch (e) {
        return false;
    }
}

function gfpQuickMask(eventName) {
    var ref = new ActionReference();
    ref.putProperty(GFP_S2T("property"), GFP_S2T("quickMask"));
    ref.putEnumerated(GFP_S2T("document"), GFP_S2T("ordinal"), GFP_S2T("targetEnum"));
    var desc = new ActionDescriptor();
    desc.putReference(GFP_S2T("null"), ref);
    executeAction(GFP_S2T(eventName), desc, DialogModes.NO);
}


function gfpRestoreQuickMaskState(state) {
    if (!state || !state.quickMask) {
        return;
    }
    try {
        var target = gfpSelectDocumentById(state.documentId);
        app.activeDocument = target;
        if (!gfpGetBooleanDocumentProperty("quickMask")) {
            gfpQuickMask("set");
        }
    } catch (e) {
        // Restoration is best-effort and must never hide the original error.
    }
}

function gfpClearSelectionAfterCancel(state) {
    if (!state) {
        return;
    }
    try {
        var target = gfpSelectDocumentById(state.documentId);
        app.activeDocument = target;

        // На момент показа главного окна Quick Mask обычно уже временно снята
        // gfpReadPhotoshopState(). Проверяем состояние повторно на случай, если
        // пользователь включил её вручную, пока окно скрипта было открыто.
        if (gfpGetBooleanDocumentProperty("quickMask")) {
            gfpQuickMask("clearEvent");
        }

        target.selection.deselect();
    } catch (e) {
        // Отмена не должна порождать вторичную ошибку, если документ успели
        // закрыть или изменить его состояние во время показа окна.
    }
}

function gfpShowDialog(payload) {
    var items = payload.previews && payload.previews.items ? payload.previews.items : [];
    if (!items.length || items.length != payload.matches.length) {
        throw new Error("Сервер не вернул корректный набор превью.");
    }

    var selectedIndex = -1;
    var lastClickIndex = -1;
    var lastClickTime = 0;
    var previewButtons = [];
    var recommendation = payload.previews && payload.previews.recommendation ? payload.previews.recommendation : {};
    var columns = Math.max(1, Number(payload.previews.columns) || 1);
    var thumbWidth = Math.max(32, Number(payload.previews.thumb_width) || 96);
    var buttonSize = thumbWidth + 8;
    var contentWidth = Math.max(420, columns * (buttonSize + 4));

    var w = new Window("dialog", String(payload.app_name) + " " + String(payload.version));
    w.orientation = "column";
    w.alignChildren = ["fill", "top"];
    w.spacing = 7;
    w.margins = 12;

    var topRow = w.add("group");
    topRow.orientation = "row";
    topRow.alignChildren = ["fill", "center"];
    topRow.spacing = 8;

    var header = topRow.add("statictext");
    header.text = "Найдено кадров: " + String(items.length) + (recommendation && recommendation.status == "ok" && recommendation.label ? " · " + String(recommendation.label) : "");
    header.preferredSize = [Math.max(260, contentWidth - 120), 20];

    var settingsButton = topRow.add("button", undefined, "⚙");
    settingsButton.preferredSize = [34, 24];
    settingsButton.helpTip = "Настройки Group Face Picker";

    var grid = w.add("group");
    grid.orientation = "column";
    grid.alignChildren = ["left", "top"];
    grid.spacing = 4;
    grid.margins = 0;

    var row = null;
    for (var i = 0; i < items.length; i++) {
        if (i % columns == 0) {
            row = grid.add("group");
            row.orientation = "row";
            row.alignChildren = ["left", "top"];
            row.spacing = 4;
            row.margins = 0;
        }

        var previewFile = new File(String(items[i].path));
        if (!previewFile.exists) {
            throw new Error("PNG-превью не найдено: " + previewFile.fsName);
        }

        // В Photoshop ScriptUI обычный image может отображаться, но не получать
        // клики. iconbutton является настоящим интерактивным контролом и сам
        // хранит индекс кадра, поэтому координаты мыши больше не используются.
        // iconbutton использует отдельные изображения normal/disabled/pressed/rollover.
        // Если передать только normal, Photoshop в некоторых версиях очищает
        // картинку при hover/pressed. Один и тот же PNG для всех четырёх
        // состояний оставляет превью неизменным при наведении и нажатии.
        var matchInfo = payload.matches[i] || {};
        var isActiveFile = matchInfo.is_active === true;
        var cell = row.add("group");
        cell.orientation = "column";
        cell.alignChildren = ["center", "top"];
        cell.spacing = 1;
        cell.margins = 0;

        var previewImage = ScriptUI.newImage(previewFile, previewFile, previewFile, previewFile);
        var previewButton = cell.add("iconbutton", undefined, previewImage, { style: "button" });
        previewButton.preferredSize = [buttonSize, buttonSize];
        previewButton.minimumSize = previewButton.preferredSize;
        previewButton.maximumSize = previewButton.preferredSize;
        var similarity = Number(matchInfo.similarity);
        var similarityText = isFinite(similarity) ? similarity.toFixed(3) : "—";
        var isRecommended = items[i].is_recommended === true;
        var recommendationLabel = String(items[i].recommendation_label || recommendation.label || "");
        var fullFileName = String(matchInfo.name || items[i].name || "");
        var displayFileName = fullFileName.replace(/^.*[\\\/]/, "");
        var extensionPos = displayFileName.lastIndexOf(".");
        if (extensionPos > 0) {
            displayFileName = displayFileName.substring(0, extensionPos);
        }
        if (displayFileName.length > 16) {
            displayFileName = displayFileName.substring(0, 16);
        }
        if (!displayFileName.length) {
            displayFileName = "—";
        }
        previewButton.helpTip = fullFileName + "\nСходство: " + similarityText + (isActiveFile ? "\nТекущий открытый файл" : "") + (isRecommended ? "\nРекомендовано: " + recommendationLabel : "");
        previewButton.gfpIndex = i;
        previewButton.onClick = function () {
            gfpHandlePreviewClick(Number(this.gfpIndex));
        };

        var similarityCaption = isActiveFile ? ("ТЕКУЩИЙ · " + similarityText) : similarityText;
        if (isRecommended) {
            similarityCaption = "ЛУЧШИЙ · " + similarityCaption;
        }
        var previewCaption = displayFileName + "\n" + similarityCaption;
        var activeLabel = cell.add("statictext", undefined, previewCaption, { multiline: true });
        activeLabel.justify = "center";
        activeLabel.helpTip = previewButton.helpTip;
        activeLabel.preferredSize = [buttonSize, 32];
        if (isRecommended) {
            try {
                var greenBrush = activeLabel.graphics.newBrush(activeLabel.graphics.BrushType.SOLID_COLOR, [0.12, 0.55, 0.18, 1]);
                activeLabel.graphics.foregroundColor = greenBrush;
            } catch (brushError) {
            }
        }
        previewButtons.push(previewButton);
    }

    var defaultStatus = "Выберите превью. Второй быстрый клик по выбранному кадру — вставить.";
    if (recommendation && recommendation.message) {
        defaultStatus = recommendation.message + "\n" + defaultStatus;
    }
    var status = w.add("statictext", undefined, defaultStatus, { multiline: true });
    status.preferredSize = [contentWidth, 34];

    var buttons = w.add("group");
    buttons.orientation = "row";
    buttons.alignChildren = ["center", "center"];
    buttons.alignment = ["center", "top"];
    buttons.spacing = 10;

    var insertButton = buttons.add("button", undefined, "Вставить выбранное", { name: "ok" });
    insertButton.enabled = false;
    var cancelButton = buttons.add("button", undefined, "Отмена", { name: "cancel" });

    function gfpSelectIndex(index) {
        if (index < 0 || index >= payload.matches.length) {
            selectedIndex = -1;
            insertButton.enabled = false;
            status.text = defaultStatus;
            w.update();
            return;
        }
        selectedIndex = index;
        var isActiveFile = payload.matches[index] && payload.matches[index].is_active === true;
        insertButton.enabled = !isActiveFile;
        status.text = isActiveFile
            ? "Текущий открытый файл — показан для сравнения и не вставляется сам в себя."
            : "Выбран кадр " + String(index + 1) + " из " + String(payload.matches.length) + ".";
        try {
            previewButtons[index].active = true;
        } catch (focusError) {
        }
        w.update();
    }

    function gfpHandlePreviewClick(index) {
        if (index < 0 || index >= payload.matches.length) {
            return;
        }
        var now = (new Date()).getTime();
        var isDouble = lastClickIndex == index && now - lastClickTime <= 650;
        lastClickIndex = index;
        lastClickTime = now;
        gfpSelectIndex(index);
        var isActiveFile = payload.matches[index] && payload.matches[index].is_active === true;
        if (isDouble && !isActiveFile) {
            selectedIndex = index;
            lastClickTime = 0;
            w.close(1);
        }
    }

    insertButton.onClick = function () {
        if (selectedIndex >= 0 && !(payload.matches[selectedIndex] && payload.matches[selectedIndex].is_active === true)) {
            w.close(1);
        }
    };
    cancelButton.onClick = function () {
        selectedIndex = -1;
        w.close(2);
    };
    settingsButton.onClick = function () {
        if (gfpShowSettingsDialog()) {
            status.text = "Настройки сохранены. Для обновления подсветки лучшего дубля перезапустите текущий поиск лица.";
            w.update();
        }
    };

    w.center();
    var dialogResult = w.show();
    // Statistics collection is configured only in the Settings dialog.
    // Snapshot the persisted setting into this query result; the preview
    // window itself intentionally has no control that can change it.
    payload.collect_statistics = GFP_SETTINGS.collect_statistics === true;
    for (var ci = 0; ci < previewButtons.length; ci++) {
        try {
            previewButtons[ci].image = null;
        } catch (imageError) {
        }
    }

    if (dialogResult != 1) {
        return -1;
    }
    return selectedIndex;
}

function gfpRecordPreference(payload, index) {
    try {
        var response = gfpApiRequest({
            command: "record_preference",
            query_id: payload.query_id,
            selected_index: index,
            collect_statistics: payload.collect_statistics === true,
            face_scale_match: GFP_SETTINGS.face_scale_match === true
        }, 5000);
        if (!response || response.type != "answer") {
            throw new Error(response && response.message ? String(response.message) : "Python-сервер не подтвердил запись.");
        }
        return true;
    } catch (e) {
        alert("Лицо успешно вставлено, но статистика для обучения не была сохранена.\n\n" + gfpErrorText(e), GFP_NAME, true);
        return false;
    }
}

function gfpInsertCandidate(payload, index) {
    if (index < 0 || index >= payload.matches.length) {
        return false;
    }

    var targetHistory = null;
    var sourceDocument = null;
    var sourceHistory = null;
    var sourceWasAlreadyOpen = false;
    var sourceOpenedByScript = false;

    try {
        var response = gfpApiRequest({
            command: "prepare_crop",
            query_id: payload.query_id,
            index: index
        }, 15000);

        if (!response || response.type != "answer" || !response.message) {
            throw new Error("Python-сервер не вернул координаты исходного фрагмента.");
        }

        var item = response.message;
        var target = gfpSelectDocumentById(payload.target.document_id);
        targetHistory = target.activeHistoryState;

        if (Math.round(target.width.as("px")) != Number(payload.target.doc_width) || Math.round(target.height.as("px")) != Number(payload.target.doc_height)) {
            throw new Error("Размер целевого документа изменился после анализа. Сделайте выделение заново и снова запустите JSX.");
        }

        // Не создаём временный duplicate документа. Донор является единственным
        // дополнительным документом: для уже открытого донора состояние истории
        // восстанавливается после crop/flatten, а открытый скриптом донор закрывается
        // без сохранения сразу после копирования слоя в целевой документ.
        sourceDocument = gfpFindOpenDocument(item.source_path);
        sourceWasAlreadyOpen = !!sourceDocument;
        if (!sourceDocument) {
            sourceDocument = gfpOpenFile(new File(item.source_path));
            sourceOpenedByScript = true;
        }

        var openedSourceWidth = Math.round(sourceDocument.width.as("px"));
        var openedSourceHeight = Math.round(sourceDocument.height.as("px"));
        var analysisSourceWidth = Number(item.source_width);
        var analysisSourceHeight = Number(item.source_height);

        app.activeDocument = sourceDocument;
        sourceHistory = sourceDocument.activeHistoryState;

        var expectedWidth = Number(payload.target.selection.right) - Number(payload.target.selection.left);
        var expectedHeight = Number(payload.target.selection.bottom) - Number(payload.target.selection.top);
        var crop = item.crop;
        var cropLeft = Number(crop.left);
        var cropTop = Number(crop.top);
        var cropRight = Number(crop.right);
        var cropBottom = Number(crop.bottom);
        var faceScaleEnabled = item.face_scale_match === true;
        var faceScale = 1.0;
        var sourceCropWidth = expectedWidth;
        var sourceCropHeight = expectedHeight;

        // RAW всегда требует пересчёта после фактического открытия Camera Raw.
        // При включённой подгонке масштаба тот же пересчёт выполняется для любого
        // формата, чтобы коэффициент строился по реальному открытому документу.
        if (item.is_raw || faceScaleEnabled) {
            var kps = item.candidate_kps_normalized || [];
            var offsets = item.target_eye_offsets || [];
            if (kps.length < 2 || offsets.length < 2) {
                throw new Error("Сервер не вернул геометрию глаз для вставки.");
            }
            var eye0x = Number(kps[0][0]) * openedSourceWidth;
            var eye0y = Number(kps[0][1]) * openedSourceHeight;
            var eye1x = Number(kps[1][0]) * openedSourceWidth;
            var eye1y = Number(kps[1][1]) * openedSourceHeight;

            if (faceScaleEnabled) {
                if (kps.length < 5) {
                    throw new Error("Для подгонки масштаба сервер не вернул все ключевые точки лица.");
                }
                var mouth0x = Number(kps[3][0]) * openedSourceWidth;
                var mouth0y = Number(kps[3][1]) * openedSourceHeight;
                var mouth1x = Number(kps[4][0]) * openedSourceWidth;
                var mouth1y = Number(kps[4][1]) * openedSourceHeight;
                var eyeWidth = gfpDistance(eye0x, eye0y, eye1x, eye1y);
                var eyeMidX = (eye0x + eye1x) * 0.5;
                var eyeMidY = (eye0y + eye1y) * 0.5;
                var mouthMidX = (mouth0x + mouth1x) * 0.5;
                var mouthMidY = (mouth0y + mouth1y) * 0.5;
                var faceHeight = gfpDistance(eyeMidX, eyeMidY, mouthMidX, mouthMidY);
                var targetFaceWidth = Number(item.target_face_width || 0);
                var targetFaceHeight = Number(item.target_face_height || 0);
                if (!(eyeWidth > 1) || !(faceHeight > 1) || !(targetFaceWidth > 1) || !(targetFaceHeight > 1)) {
                    throw new Error("Не удалось надёжно рассчитать размер лица для масштабирования.");
                }
                faceScale = Math.max(targetFaceWidth / eyeWidth, targetFaceHeight / faceHeight);
                if (!isFinite(faceScale) || faceScale < 0.25 || faceScale > 4.0) {
                    throw new Error("Получен недопустимый коэффициент масштаба лица: " + String(faceScale));
                }
                sourceCropWidth = Math.max(1, Math.ceil(expectedWidth / faceScale));
                sourceCropHeight = Math.max(1, Math.ceil(expectedHeight / faceScale));
            }

            cropLeft = Math.round(((eye0x - Number(offsets[0][0]) / faceScale) +
                (eye1x - Number(offsets[1][0]) / faceScale)) * 0.5);
            cropTop = Math.round(((eye0y - Number(offsets[0][1]) / faceScale) +
                (eye1y - Number(offsets[1][1]) / faceScale)) * 0.5);
            cropRight = cropLeft + sourceCropWidth;
            cropBottom = cropTop + sourceCropHeight;
            if (cropLeft < 0 || cropTop < 0 || cropRight > openedSourceWidth || cropBottom > openedSourceHeight) {
                throw new Error(faceScaleEnabled
                    ? "Подгонка масштаба требует фрагмент за пределами исходного кадра. Этот донор нельзя вставить с выбранным масштабом."
                    : "После открытия RAW рассчитанный фрагмент выходит за границы документа.");
            }
        } else if (openedSourceWidth != analysisSourceWidth || openedSourceHeight != analysisSourceHeight) {
            throw new Error("Размер открытого исходного кадра не совпадает с размером, использованным распознаванием.");
        }

        sourceDocument.crop([
            UnitValue(cropLeft, "px"),
            UnitValue(cropTop, "px"),
            UnitValue(cropRight, "px"),
            UnitValue(cropBottom, "px")
        ]);

        if (Math.round(sourceDocument.width.as("px")) != sourceCropWidth || Math.round(sourceDocument.height.as("px")) != sourceCropHeight) {
            throw new Error("Внутренняя проверка crop не пройдена: Photoshop изменил размер исходного фрагмента.");
        }

        sourceDocument.flatten();
        var insertedLayer = sourceDocument.activeLayer.duplicate(target, ElementPlacement.PLACEATBEGINNING);

        if (sourceWasAlreadyOpen) {
            sourceDocument.activeHistoryState = sourceHistory;
            sourceHistory = null;
            sourceDocument = null;
        } else {
            sourceDocument.close(SaveOptions.DONOTSAVECHANGES);
            sourceDocument = null;
            sourceOpenedByScript = false;
            sourceHistory = null;
        }

        app.activeDocument = target;
        target.activeLayer = insertedLayer;

        var layerBounds = insertedLayer.bounds;
        var layerLeft = gfpPx(layerBounds[0]);
        var layerTop = gfpPx(layerBounds[1]);
        var layerRight = gfpPx(layerBounds[2]);
        var layerBottom = gfpPx(layerBounds[3]);
        var layerWidth = Math.round(layerRight - layerLeft);
        var layerHeight = Math.round(layerBottom - layerTop);

        if (faceScaleEnabled && Math.abs(faceScale - 1.0) > 0.0005) {
            // Равномерный масштаб — единственная дополнительная трансформация.
            // Поворот не выполняется. TOPLEFT соответствует геометрии crop:
            // offsets/scale были рассчитаны относительно его верхнего левого угла.
            insertedLayer.resize(faceScale * 100.0, faceScale * 100.0, AnchorPosition.TOPLEFT);
            layerBounds = insertedLayer.bounds;
            layerLeft = gfpPx(layerBounds[0]);
            layerTop = gfpPx(layerBounds[1]);
            layerRight = gfpPx(layerBounds[2]);
            layerBottom = gfpPx(layerBounds[3]);
            layerWidth = Math.round(layerRight - layerLeft);
            layerHeight = Math.round(layerBottom - layerTop);
            // crop использует ceil(target/scale), поэтому после равномерного
            // увеличения слой должен полностью перекрывать исходное выделение.
            if (layerWidth < expectedWidth || layerHeight < expectedHeight) {
                target.activeHistoryState = targetHistory;
                targetHistory = null;
                throw new Error("Photoshop округлил масштабированный слой меньше целевой области. Операция отменена.");
            }
        } else if (layerWidth != expectedWidth || layerHeight != expectedHeight) {
            target.activeHistoryState = targetHistory;
            targetHistory = null;
            throw new Error("Photoshop изменил размер вставленного слоя. Операция отменена: масштабирование выключено.");
        }

        insertedLayer.translate(
            UnitValue(Number(payload.target.selection.left) - layerLeft, "px"),
            UnitValue(Number(payload.target.selection.top) - layerTop, "px")
        );
        insertedLayer.name = "Face from " + String(item.name);

        if (payload.target.selection_mask) {
            // Маска создаётся для любого исходного выделения. Для Quick Mask
            // в целевом документе сохраняется точная непрямоугольная selection;
            // для обычного marquee это прямоугольная selection. Переключение
            // документов обычно её не меняет, но прямоугольник можно безопасно
            // восстановить по сохранённым bounds, если Photoshop её потерял.
            if (!gfpHasSelection(target)) {
                if (payload.target.quick_mask) {
                    throw new Error("Форма выделения Quick Mask была потеряна до создания маски слоя.");
                }
                gfpSetRectangleSelection(target, payload.target.selection);
            }
            target.activeLayer = insertedLayer;
            gfpMakeSelectionMask();
        }
        return true;
    } catch (insertError) {
        try {
            if (sourceDocument) {
                app.activeDocument = sourceDocument;
                if (sourceWasAlreadyOpen && sourceHistory) {
                    sourceDocument.activeHistoryState = sourceHistory;
                } else if (sourceOpenedByScript) {
                    sourceDocument.close(SaveOptions.DONOTSAVECHANGES);
                }
            }
        } catch (restoreSourceError) {
        }
        try {
            if (targetHistory) {
                var restoreTarget = gfpSelectDocumentById(payload.target.document_id);
                restoreTarget.activeHistoryState = targetHistory;
            }
        } catch (restoreTargetError) {
        }
        throw insertError;
    }
}

function gfpOpenFile(pth) {
    var file = pth instanceof File ? pth : new File(String(pth));
    var desc = new ActionDescriptor();
    desc.putPath(GFP_S2T("target"), file);
    desc.putBoolean(GFP_S2T("forceNotify"), false);
    executeAction(GFP_S2T("open"), desc, DialogModes.NO);
    return app.activeDocument;
}

function gfpDistance(x1, y1, x2, y2) {
    var dx = Number(x2) - Number(x1);
    var dy = Number(y2) - Number(y1);
    return Math.sqrt(dx * dx + dy * dy);
}

function gfpHasSelection(doc) {
    app.activeDocument = doc;
    try {
        var bounds = doc.selection.bounds;
        return !!(bounds && bounds.length >= 4);
    } catch (e) {
        return false;
    }
}

function gfpMakeSelectionMask() {
    var desc = new ActionDescriptor();
    desc.putClass(GFP_S2T("new"), GFP_S2T("channel"));
    var ref = new ActionReference();
    ref.putEnumerated(GFP_S2T("channel"), GFP_S2T("channel"), GFP_S2T("mask"));
    desc.putReference(GFP_S2T("at"), ref);
    desc.putEnumerated(GFP_S2T("using"), GFP_S2T("userMask"), GFP_S2T("revealSelection"));
    executeAction(GFP_S2T("make"), desc, DialogModes.NO);
}

function gfpSelectDocumentById(documentId) {
    var ref = new ActionReference();
    ref.putIdentifier(GFP_S2T("document"), Number(documentId));
    var desc = new ActionDescriptor();
    desc.putReference(GFP_S2T("null"), ref);
    executeAction(GFP_S2T("select"), desc, DialogModes.NO);
    return app.activeDocument;
}

function gfpSetRectangleSelection(doc, rect) {
    app.activeDocument = doc;
    doc.selection.select([
        [Number(rect.left), Number(rect.top)],
        [Number(rect.right), Number(rect.top)],
        [Number(rect.right), Number(rect.bottom)],
        [Number(rect.left), Number(rect.bottom)]
    ], SelectionType.REPLACE, 0, false);
}

function gfpSamePath(left, right) {
    try {
        return String(new File(left).fsName).toLowerCase() == String(new File(right).fsName).toLowerCase();
    } catch (pathError) {
        return String(left).toLowerCase() == String(right).toLowerCase();
    }
}

function gfpFindOpenDocument(path) {
    for (var di = 0; di < app.documents.length; di++) {
        try {
            if (gfpSamePath(app.documents[di].fullName.fsName, path)) {
                return app.documents[di];
            }
        } catch (docPathError) {
        }
    }
    return null;
}

function gfpPx(value) {
    try {
        return Number(value.as("px"));
    } catch (unitError) {
        return Number(value);
    }
}

function gfpApiRequest(payload, timeout) {
    return gfpApiRequestTo(GFP_API_HOST, GFP_API_PORT_SEND, payload, timeout);
}

function gfpApiRequestTo(host, port, payload, timeout) {
    payload.reply_port = GFP_API_PORT_LISTEN;
    var listener = new Socket();
    if (!listener.listen(GFP_API_PORT_LISTEN, "UTF-8")) {
        throw new Error("Не удалось открыть локальный порт ответа " + GFP_API_PORT_LISTEN + ". Возможно, другой экземпляр скрипта ещё выполняется.");
    }

    var sender = new Socket();
    if (!sender.open(String(host) + ":" + String(port), "UTF-8")) {
        listener.close();
        return null;
    }

    sender.writeln(gfpObjectToJSON(payload));
    sender.close();

    var started = (new Date()).getTime();
    for (;;) {
        if ((new Date()).getTime() - started > timeout) {
            listener.close();
            return null;
        }

        var answer = listener.poll();
        if (answer != null) {
            var line = answer.readln();
            answer.close();
            listener.close();
            try {
                return eval("(" + line + ")");
            } catch (e) {
                throw new Error("Некорректный ответ Python-сервера: " + e.message);
            }
        }
        $.sleep(5);
    }
}

function gfpApiFire(payload) {
    gfpApiFireTo(GFP_API_HOST, GFP_API_PORT_SEND, payload);
}

function gfpApiFireTo(host, port, payload) {
    try {
        payload.no_reply = true;
        var sender = new Socket();
        if (sender.open(String(host) + ":" + String(port), "UTF-8")) {
            sender.writeln(gfpObjectToJSON(payload));
            sender.close();
        }
    } catch (e) {
    }
}

function gfpIsUserCancelError(error) {
    try {
        if (Number(error.number) == 8007) return true;
    } catch (_) {
    }
    var text = gfpErrorText(error).toLowerCase();
    return text.indexOf("cancel") >= 0 || text.indexOf("отмен") >= 0;
}

function gfpUpdateNativeProgress(done, total, text) {
    if (text !== undefined && text !== null && String(text).length) {
        app.changeProgressText(String(text));
    }
    try {
        return app.updateProgress(Number(done), Number(total)) !== false;
    } catch (e) {
        if (gfpIsUserCancelError(e)) return false;
        throw e;
    }
}

function gfpCancelServerJob(jobId, host, port) {
    if (!jobId) return;
    gfpApiFireTo(host || GFP_API_HOST, port || GFP_API_PORT_SEND, { command: "cancel_job", job_id: String(jobId) });
}


function gfpClientStateFile() {
    // Путь локального launcher относится только к клиенту Photoshop и хранится
    // отдельно от рабочего gfp_config.json Python-сервера.
    return new File(app.preferencesFolder + "/gfp_client_state.json");
}

function gfpLoadClientState() {
    var file = gfpClientStateFile();
    if (!file.exists) {
        return { server_launcher_path: "", server_host: "", server_port: 0 };
    }
    try {
        file.encoding = "UTF-8";
        if (!file.open("r")) {
            return { server_launcher_path: "", server_host: "", server_port: 0 };
        }
        var content = file.read();
        file.close();
        var state = content ? eval("(" + content + ")") : {};
        return {
            server_launcher_path: String(state.server_launcher_path || ""),
            server_host: gfpTrimString(state.server_host || ""),
            server_port: Number(state.server_port || 0)
        };
    } catch (e) {
        try { file.close(); } catch (_) {}
        return { server_launcher_path: "", server_host: "", server_port: 0 };
    }
}

function gfpSaveClientState(state) {
    var file = gfpClientStateFile();
    var temp = new File(file.fsName + ".tmp");
    temp.encoding = "UTF-8";
    if (!temp.open("w")) {
        return false;
    }
    try {
        temp.write(gfpObjectToJSON({
            server_launcher_path: String(state.server_launcher_path || ""),
            server_host: gfpTrimString(state.server_host || ""),
            server_port: Number(state.server_port || 0)
        }));
    } finally {
        temp.close();
    }
    try {
        if (file.exists) {
            file.remove();
        }
        if (!temp.rename(file.name)) {
            if (!temp.copy(file.fsName)) {
                temp.remove();
                return false;
            }
            temp.remove();
        }
        var verify = gfpLoadClientState();
        return String(verify.server_launcher_path || "") == String(state.server_launcher_path || "") &&
            String(verify.server_host || "") == String(state.server_host || "") &&
            Number(verify.server_port || 0) == Number(state.server_port || 0);
    } catch (e) {
        try { temp.remove(); } catch (_) {}
        return false;
    }
}

function gfpRememberServerLauncherFromResponse(response) {
    try {
        if (!response || response.type != "answer" || !response.message || !response.message.run_server_path) {
            return;
        }
        var path = String(response.message.run_server_path);
        var launcher = new File(path);
        if (!launcher.exists || String(launcher.name).toLowerCase() != "run_server.bat") {
            return;
        }
        var state = gfpLoadClientState();
        if (String(state.server_launcher_path || "") != launcher.fsName || String(state.server_host || "") != String(GFP_API_HOST) || Number(state.server_port || 0) != Number(GFP_API_PORT_SEND)) {
            gfpSaveClientState({
                server_launcher_path: launcher.fsName,
                server_host: GFP_API_HOST,
                server_port: GFP_API_PORT_SEND
            });
        }
    } catch (e) {
    }
}

function gfpFindServerLauncher(state) {
    var candidates = [];
    var remembered = state && state.server_launcher_path ? String(state.server_launcher_path) : "";
    if (remembered) candidates.push(new File(remembered));
    // Fallback for the usual portable layout where JSX and run_server.bat are
    // kept together. This also lets a fresh local install autostart before the
    // first successful ping has written client_state.
    try {
        var scriptFile = new File($.fileName);
        candidates.push(new File(scriptFile.parent.fsName + "/run_server.bat"));
    } catch (_) {
    }
    for (var i = 0; i < candidates.length; i++) {
        try {
            if (candidates[i].exists && String(candidates[i].name).toLowerCase() == "run_server.bat") {
                return candidates[i];
            }
        } catch (_) {
        }
    }
    return null;
}

function gfpEnsureServerAvailable() {
    var ping = null;
    try {
        ping = gfpApiRequest({ command: "ping" }, 2500);
    } catch (e) {
        ping = null;
    }
    if (ping && ping.type == "answer") {
        gfpRememberServerLauncherFromResponse(ping);
        return ping;
    }

    var state = gfpLoadClientState();
    var rememberedPath = String(state.server_launcher_path || "");
    var stateMatches = String(state.server_host || "") == String(GFP_API_HOST) &&
        Number(state.server_port || 0) == Number(GFP_API_PORT_SEND);
    if (rememberedPath && !stateMatches) {
        // Never launch a remembered executable that belongs to another server
        // address/port configuration.
        return null;
    }
    if (!rememberedPath && String(GFP_API_HOST).toLowerCase() != "127.0.0.1" && String(GFP_API_HOST).toLowerCase() != "localhost") {
        // A fresh remote configuration cannot be started by executing a local
        // BAT whose relationship to that remote host is unknown.
        return null;
    }
    var launcher = gfpFindServerLauncher(stateMatches ? state : null);
    if (!launcher) {
        return null;
    }
    GFP_LAST_SERVER_LAUNCHER = launcher.fsName;
    var launchResult = null;
    try {
        launchResult = launcher.execute();
    } catch (launchError) {
        return null;
    }
    // Match the proven img2img-helper pattern: only an explicit false means
    // that the OS rejected File.execute(). Some Photoshop/ExtendScript builds
    // do not reliably return a strict boolean true on successful hand-off.
    if (launchResult === false) {
        GFP_SERVER_START_ERROR = "File.execute() вернул false для: " + launcher.fsName;
        return null;
    }

    GFP_SERVER_START_OK = false;
    GFP_SERVER_START_ERROR = "";
    GFP_SERVER_START_RESPONSE = null;
    GFP_SERVER_START_CANCELLED = false;
    try {
        app.doForcedProgress("Запуск Group Face Picker server", "gfpPollServerStartup();");
    } catch (progressError) {
        if (gfpIsUserCancelError(progressError)) {
            GFP_SERVER_START_CANCELLED = true;
        } else {
            GFP_SERVER_START_ERROR = gfpErrorText(progressError);
        }
    }
    if (!GFP_SERVER_START_OK) {
        return null;
    }
    // gfpPollServerStartup already received a successful ping. Reuse that
    // exact response instead of immediately issuing the same network request
    // a second time.
    return GFP_SERVER_START_RESPONSE;
}

function gfpPollServerStartup() {
    var startedAt = (new Date()).getTime();
    for (;;) {
        var elapsed = (new Date()).getTime() - startedAt;
        if (elapsed > GFP_SERVER_START_TIMEOUT) {
            GFP_SERVER_START_ERROR = "Превышено время ожидания запуска Python-сервера." +
                (GFP_LAST_SERVER_LAUNCHER ? (" Путь: " + GFP_LAST_SERVER_LAUNCHER) : "");
            return false;
        }
        var ping = null;
        try {
            ping = gfpApiRequest({ command: "ping" }, 1200);
        } catch (e) {
            ping = null;
        }
        if (ping && ping.type == "answer") {
            // The server is already verified at this point. Remember its launcher
            // even if the user presses Esc on the final progress update.
            gfpRememberServerLauncherFromResponse(ping);
            if (!gfpUpdateNativeProgress(1000, 1000, "Python-сервер готов.")) {
                GFP_SERVER_START_CANCELLED = true;
                return false;
            }
            GFP_SERVER_START_OK = true;
            GFP_SERVER_START_RESPONSE = ping;
            return true;
        }
        var progress = Math.min(950, Math.round((elapsed / GFP_SERVER_START_TIMEOUT) * 950));
        if (!gfpUpdateNativeProgress(progress, 1000, "Ожидание запуска Python-сервера...")) {
            GFP_SERVER_START_CANCELLED = true;
            GFP_SERVER_START_ERROR = "";
            return false;
        }
        $.sleep(350);
    }
}

function gfpDefaultConfig() {
    return {
        server_host: GFP_DEFAULT_HOST,
        server_port: GFP_DEFAULT_PORT_SEND,
        preview_size: 96,
        cache_ttl_hours: 48,
        match_threshold: 0.28,
        compute_mode: "auto",
        scan_threads: 2,
        preview_threads: 2,
        analysis_quality: "balanced",
        group_boundary_search: false,
        face_scale_match: false,
        collect_statistics: false,
        recommendation_model: "public"
    };
}

function gfpConfigFile() {
    // Это только клиентская копия настроек Photoshop: адрес подключения и
    // последнее подтверждённое состояние сервера. Python-сервер по-прежнему
    // хранит свой рабочий gfp_config.json рядом с group_face_server.py.
    // Разные имена файлов исключают два конкурирующих «gfp_config.json».
    return new File(app.preferencesFolder + "/gfp_client_config.json");
}

function gfpConfigBackupFile() {
    var file = gfpConfigFile();
    return new File(file.fsName + ".bak");
}

function gfpPreviousPreferencesConfigFile() {
    // Предыдущее пользовательское размещение. Используется только как источник
    // однократной миграции, когда gfp_client_config.json ещё не создан.
    return new File(app.preferencesFolder + "/gfp_config.json");
}

function gfpLegacyConfigFile() {
    // Самое старое размещение рядом с JSX. Если JSX установлен в Presets/Scripts,
    // этот файл может находиться в защищённой папке; только читаем, не пишем.
    var scriptFile = new File($.fileName);
    return new File(scriptFile.parent.fsName + "/gfp_config.json");
}

function gfpLegacyServerConfigFile() {
    // Если JSX уже был установлен отдельно от сервера, старый рабочий конфиг
    // можно найти по ранее запомненному run_server.bat.
    try {
        var state = gfpLoadClientState();
        var launcherPath = String(state.server_launcher_path || "");
        if (!launcherPath) return null;
        var launcher = new File(launcherPath);
        if (!launcher.exists) return null;
        return new File(launcher.parent.fsName + "/gfp_config.json");
    } catch (_) {
        return null;
    }
}

function gfpTrimString(value) {
    return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "");
}

function gfpBooleanValue(value, fallbackValue) {
    if (value === true) return true;
    if (value === false) return false;
    if (typeof value == "number") return value != 0;
    var text = gfpTrimString(value).toLowerCase();
    if (text == "true" || text == "1" || text == "yes" || text == "on") return true;
    if (text == "false" || text == "0" || text == "no" || text == "off" || text == "") return false;
    return fallbackValue === true;
}

function gfpNormalizeConfig(raw) {
    var cfg = gfpDefaultConfig();
    if (raw) {
        for (var key in raw) {
            if (raw.hasOwnProperty(key)) {
                cfg[key] = raw[key];
            }
        }
    }
    cfg.server_host = gfpTrimString(cfg.server_host || GFP_DEFAULT_HOST) || GFP_DEFAULT_HOST;
    cfg.server_port = Number(cfg.server_port || GFP_DEFAULT_PORT_SEND);
    if (!isFinite(cfg.server_port) || cfg.server_port < 1 || cfg.server_port > 65535) {
        cfg.server_port = GFP_DEFAULT_PORT_SEND;
    }
    cfg.preview_size = Number(cfg.preview_size || 96);
    cfg.preview_size = Math.max(64, Math.min(320, Math.round(cfg.preview_size / 8) * 8));
    cfg.cache_ttl_hours = Number(cfg.cache_ttl_hours || 48);
    cfg.cache_ttl_hours = Math.max(12, Math.min(168, Math.round(cfg.cache_ttl_hours)));
    cfg.match_threshold = Number(cfg.match_threshold || 0.28);
    cfg.match_threshold = Math.max(0.10, Math.min(0.60, cfg.match_threshold));
    cfg.compute_mode = gfpTrimString(cfg.compute_mode || "auto").toLowerCase();
    if (cfg.compute_mode != "auto" && cfg.compute_mode != "cpu" && cfg.compute_mode != "gpu") {
        cfg.compute_mode = "auto";
    }
    cfg.scan_threads = Math.round(Number(cfg.scan_threads || 2));
    cfg.scan_threads = Math.max(1, Math.min(4, cfg.scan_threads));
    cfg.preview_threads = Math.round(Number(cfg.preview_threads || 2));
    cfg.preview_threads = Math.max(1, Math.min(8, cfg.preview_threads));
    cfg.analysis_quality = gfpTrimString(cfg.analysis_quality || "balanced").toLowerCase();
    if (cfg.analysis_quality != "fast" && cfg.analysis_quality != "balanced" && cfg.analysis_quality != "accurate") {
        cfg.analysis_quality = "balanced";
    }
    cfg.group_boundary_search = gfpBooleanValue(cfg.group_boundary_search, false);
    cfg.face_scale_match = gfpBooleanValue(cfg.face_scale_match, false);
    cfg.collect_statistics = gfpBooleanValue(cfg.collect_statistics, false);
    cfg.recommendation_model = gfpTrimString(cfg.recommendation_model || "public").toLowerCase();
    if (cfg.recommendation_model != "off" && cfg.recommendation_model != "public" && cfg.recommendation_model != "personal" && cfg.recommendation_model != "combined") {
        cfg.recommendation_model = "public";
    }
    return cfg;
}

function gfpReadConfigFile(file) {
    if (!file || !file.exists) return null;
    try {
        file.encoding = "UTF-8";
        if (!file.open("r")) return null;
        var content = file.read();
        file.close();
        if (!content) return null;
        return gfpNormalizeConfig(eval("(" + content + ")"));
    } catch (e) {
        try { file.close(); } catch (_) {}
        return null;
    }
}

function gfpLoadConfig() {
    var primary = gfpConfigFile();
    if (primary.exists) {
        var current = gfpReadConfigFile(primary);
        if (current) return current;
        // Если новый файл существует, но повреждён, старый migration-source
        // не должен внезапно «воскреснуть». Сначала используем его backup.
        var backup = gfpReadConfigFile(gfpConfigBackupFile());
        if (backup) return backup;
        return gfpDefaultConfig();
    }

    // Миграция выполняется только при реальном отсутствии нового файла:
    // сначала берём более новое пользовательское размещение в preferences
    // Photoshop, затем старый файл рядом с JSX.
    var candidates = [gfpPreviousPreferencesConfigFile(), gfpLegacyServerConfigFile(), gfpLegacyConfigFile()];
    for (var i = 0; i < candidates.length; i++) {
        var migrated = gfpReadConfigFile(candidates[i]);
        if (!migrated) continue;
        try {
            return gfpSaveConfig(migrated);
        } catch (_) {
            return migrated;
        }
    }
    return gfpDefaultConfig();
}

function gfpSaveConfig(config) {
    var file = gfpConfigFile();
    var backup = gfpConfigBackupFile();
    var temp = new File(file.fsName + ".tmp");
    var cfg = gfpNormalizeConfig(config);
    try { if (temp.exists) temp.remove(); } catch (_) {}
    temp.encoding = "UTF-8";
    if (!temp.open("w")) {
        throw new Error("Не удалось сохранить временный файл настроек: " + temp.fsName);
    }
    try {
        temp.write(gfpObjectToJSON(cfg));
    } finally {
        temp.close();
    }

    // Сохраняем последнюю рабочую клиентскую копию до замены primary.
    if (file.exists) {
        try { if (backup.exists) backup.remove(); } catch (_) {}
        if (!file.copy(backup.fsName)) {
            try { temp.remove(); } catch (_) {}
            throw new Error("Не удалось создать резервную копию настроек: " + backup.fsName);
        }
        if (!file.remove()) {
            try { temp.remove(); } catch (_) {}
            throw new Error("Не удалось заменить файл настроек: " + file.fsName);
        }
    }

    var installed = temp.rename(file.name);
    if (!installed) {
        installed = temp.copy(file.fsName);
        try { temp.remove(); } catch (_) {}
    }
    if (!installed) {
        try {
            if (!file.exists && backup.exists) backup.copy(file.fsName);
        } catch (_) {}
        throw new Error("Не удалось завершить сохранение настроек: " + file.fsName);
    }

    var verified = gfpReadConfigFile(file);
    if (!verified || !gfpSameConfigValues(cfg, verified)) {
        try {
            if (file.exists) file.remove();
            if (backup.exists) backup.copy(file.fsName);
        } catch (_) {}
        throw new Error("Проверка локального файла настроек не пройдена.");
    }
    return verified;
}

function gfpApplyConfig(config) {
    GFP_SETTINGS = gfpNormalizeConfig(config);
    GFP_API_HOST = String(GFP_SETTINGS.server_host);
    GFP_API_PORT_SEND = Number(GFP_SETTINGS.server_port);
}

function gfpDropdownItemValue(item) {
    if (item === null || item === undefined) return "";
    try {
        if (item.controlValue !== undefined) return String(item.controlValue);
    } catch (_) {
    }
    try { return String(item.text || ""); } catch (_) { return ""; }
}

function gfpPopulateValueDropdown(control, definitions) {
    if (!control) return control;
    definitions = definitions instanceof Array ? definitions : [];
    for (var i = 0; i < definitions.length; i++) {
        var def = definitions[i] || {};
        var item = control.add("item", String(def.label || def.value || ""));
        item.controlValue = String(def.value || "");
    }
    return control;
}

function gfpRestoreValueDropdown(control, savedValue, fallbackValue) {
    if (!control || !control.items) return "";
    var wanted = String(savedValue === undefined || savedValue === null ? "" : savedValue);
    var fallback = String(fallbackValue === undefined || fallbackValue === null ? "" : fallbackValue);
    var selected = null;
    var i;
    for (i = 0; i < control.items.length; i++) {
        if (gfpDropdownItemValue(control.items[i]) == wanted) {
            selected = control.items[i];
            break;
        }
    }
    if (!selected && fallback) {
        for (i = 0; i < control.items.length; i++) {
            if (gfpDropdownItemValue(control.items[i]) == fallback) {
                selected = control.items[i];
                break;
            }
        }
    }
    if (!selected && control.items.length) selected = control.items[0];
    control.selection = selected;
    return gfpReadValueDropdown(control, fallback);
}

function gfpReadValueDropdown(control, fallbackValue) {
    if (control && control.selection !== null && control.selection !== undefined) {
        var value = gfpDropdownItemValue(control.selection);
        if (value) return value;
    }
    return String(fallbackValue === undefined || fallbackValue === null ? "" : fallbackValue);
}

function gfpShowSettingsDialog() {
    var localCurrent = gfpLoadConfig();
    var current = localCurrent;
    var oldHost = GFP_API_HOST;
    var oldPort = GFP_API_PORT_SEND;
    var liveEngine = null;
    var liveRecommendationBackends = null;
    try {
        var live = gfpApiRequestTo(oldHost, oldPort, { command: "get_settings" }, 3000);
        if (live && live.type == "answer" && live.message && live.message.settings) {
            gfpRememberServerLauncherFromResponse(live);
            if (live.message.version && String(live.message.version) != GFP_VERSION) {
                throw new Error("Запущен Python-сервер версии " + String(live.message.version) + ", а JSX имеет версию " + GFP_VERSION + ". Перезапустите run_server.bat перед изменением настроек.");
            }
            var serverSettings = gfpNormalizeConfig(live.message.settings);
            // Statistics collection is a Photoshop-side opt-in shown only in
            // this Settings dialog. Preserve the local value while importing
            // the other live server settings; Save synchronizes it back.
            serverSettings.collect_statistics = localCurrent.collect_statistics === true;
            current = gfpNormalizeConfig(serverSettings);
            liveEngine = live.message.engine || null;
            liveRecommendationBackends = live.message.recommendation_backends || null;
            // Сервер является источником истины для рабочих параметров, но адрес,
            // по которому Photoshop уже успешно к нему подключился, остаётся
            // клиентским endpoint. Это важно для удалённого сервера, который
            // может слушать 0.0.0.0, а Photoshop подключается к его LAN-IP.
            current.server_host = localCurrent.server_host;
            current.server_port = localCurrent.server_port;
            // Synchronize live server-controlled values in memory, but do not
            // rewrite the client config merely because Settings was opened.
            // Persist only after Save; Cancel stays disk-I/O free.
            gfpApplyConfig(current);
            oldHost = GFP_API_HOST;
            oldPort = GFP_API_PORT_SEND;
            live.message.settings = serverSettings;
        }
    } catch (liveError) {
        if (liveError && liveError.message && String(liveError.message).indexOf("Перезапустите run_server.bat") >= 0) {
            alert(String(liveError.message), GFP_NAME, true);
            return false;
        }
    }

    var w = new Window("dialog", GFP_NAME + " — настройки");
    w.orientation = "column";
    w.alignChildren = ["fill", "top"];
    w.spacing = 8;
    w.margins = 12;

    function addLabeledEdit(parent, labelText, valueText, editWidth) {
        var group = parent.add("group");
        group.orientation = "row";
        group.alignChildren = ["left", "center"];
        group.spacing = 8;
        var label = group.add("statictext", undefined, labelText);
        label.preferredSize = [230, 20];
        var edit = group.add("edittext", undefined, valueText);
        edit.preferredSize = [editWidth || 220, 24];
        return edit;
    }

    var serverPanel = w.add("panel", undefined, "Сервер");
    serverPanel.orientation = "column";
    serverPanel.alignChildren = ["fill", "top"];
    serverPanel.margins = 10;
    var edServerHost = addLabeledEdit(serverPanel, "Адрес сервера", String(current.server_host), 220);
    var edPort = addLabeledEdit(serverPanel, "Порт сервера", String(current.server_port), 100);
    var serverHint = serverPanel.add("statictext", undefined,
        "Локально: 127.0.0.1. Для работы по сети укажите IP или имя компьютера, на котором запущен Python-сервер.",
        { multiline: true });
    serverHint.preferredSize = [470, 36];
    var rememberedLauncher = gfpLoadClientState();
    var launcherHint = serverPanel.add("statictext", undefined,
        rememberedLauncher.server_launcher_path ?
            ("Автозапуск: " + String(rememberedLauncher.server_launcher_path)) :
            "Автозапуск: путь к run_server.bat ещё не запомнен.",
        { multiline: true });
    launcherHint.preferredSize = [470, 32];

    var performancePanel = w.add("panel", undefined, "Производительность распознавания");
    performancePanel.orientation = "column";
    performancePanel.alignChildren = ["fill", "top"];
    performancePanel.margins = 10;

    var modeRow = performancePanel.add("group");
    modeRow.orientation = "row";
    modeRow.alignChildren = ["left", "center"];
    var modeLabel = modeRow.add("statictext", undefined, "Режим вычислений");
    modeLabel.preferredSize = [230, 20];
    var dlMode = modeRow.add("dropdownlist", undefined);
    dlMode.preferredSize = [180, 24];
    gfpPopulateValueDropdown(dlMode, [
        { label: "Авто", value: "auto" },
        { label: "CPU", value: "cpu" },
        { label: "GPU", value: "gpu" }
    ]);
    gfpRestoreValueDropdown(dlMode, current.compute_mode, "auto");

    var qualityRow = performancePanel.add("group");
    qualityRow.orientation = "row";
    qualityRow.alignChildren = ["left", "center"];
    var qualityLabel = qualityRow.add("statictext", undefined, "Скорость / мелкие лица");
    qualityLabel.preferredSize = [230, 20];
    var dlQuality = qualityRow.add("dropdownlist", undefined);
    dlQuality.preferredSize = [180, 24];
    gfpPopulateValueDropdown(dlQuality, [
        { label: "Быстро — 640", value: "fast" },
        { label: "Баланс — 800", value: "balanced" },
        { label: "Точно — 1024", value: "accurate" }
    ]);
    gfpRestoreValueDropdown(dlQuality, current.analysis_quality, "balanced");

    var threadsRow = performancePanel.add("group");
    threadsRow.orientation = "row";
    threadsRow.alignChildren = ["fill", "center"];
    var threadsLabel = threadsRow.add("statictext", undefined, "Потоки анализа файлов");
    threadsLabel.preferredSize = [230, 20];
    var slThreads = threadsRow.add("slider", undefined, Number(current.scan_threads), 1, 4);
    slThreads.preferredSize = [180, 20];
    var stThreads = threadsRow.add("statictext", undefined, String(current.scan_threads));
    stThreads.preferredSize = [36, 20];
    function updateThreadsLabel() {
        var v = Math.max(1, Math.min(4, Math.round(Number(slThreads.value))));
        slThreads.value = v;
        stThreads.text = String(v);
    }
    slThreads.onChanging = updateThreadsLabel;
    slThreads.onChange = updateThreadsLabel;
    updateThreadsLabel();

    var previewThreadsRow = performancePanel.add("group");
    previewThreadsRow.orientation = "row";
    previewThreadsRow.alignChildren = ["fill", "center"];
    var previewThreadsLabel = previewThreadsRow.add("statictext", undefined, "Потоки создания превью");
    previewThreadsLabel.preferredSize = [230, 20];
    var slPreviewThreads = previewThreadsRow.add("slider", undefined, Number(current.preview_threads), 1, 8);
    slPreviewThreads.preferredSize = [180, 20];
    var stPreviewThreads = previewThreadsRow.add("statictext", undefined, String(current.preview_threads));
    stPreviewThreads.preferredSize = [36, 20];
    function updatePreviewThreadsLabel() {
        var v = Math.max(1, Math.min(8, Math.round(Number(slPreviewThreads.value))));
        slPreviewThreads.value = v;
        stPreviewThreads.text = String(v);
    }
    slPreviewThreads.onChanging = updatePreviewThreadsLabel;
    slPreviewThreads.onChange = updatePreviewThreadsLabel;
    updatePreviewThreadsLabel();

    var perfHint = performancePanel.add("statictext", undefined,
        "Быстрый режим заметно ускоряет детекцию, но может пропускать очень маленькие лица. " +
        "Потоки анализа обрабатывают разные кадры через InsightFace. Потоки превью собирают PNG из уже сохранённых миниатюр лиц; можно использовать до 8 потоков.",
        { multiline: true });
    perfHint.preferredSize = [470, 48];

    if (liveEngine && liveEngine.provider) {
        var engineStatus = performancePanel.add("statictext", undefined,
            "Сейчас: " + String(liveEngine.provider) + ", detector " + String(liveEngine.det_size || "?") + " px");
        engineStatus.preferredSize = [470, 20];
    }

    var previewPanel = w.add("panel", undefined, "Интерфейс");
    previewPanel.orientation = "column";
    previewPanel.alignChildren = ["fill", "top"];
    previewPanel.margins = 10;
    var previewInfo = previewPanel.add("statictext", undefined, "Размер квадратного превью", { multiline: true });
    previewInfo.preferredSize = [460, 20];
    var previewRow = previewPanel.add("group");
    previewRow.orientation = "row";
    previewRow.alignChildren = ["fill", "center"];
    var slPreview = previewRow.add("slider", undefined, Number(current.preview_size), 64, 320);
    slPreview.preferredSize = [340, 20];
    var stPreview = previewRow.add("statictext", undefined, String(current.preview_size) + " px");
    stPreview.preferredSize = [70, 20];
    function updatePreviewLabel() {
        var v = Math.max(64, Math.min(320, Math.round(Number(slPreview.value) / 8) * 8));
        slPreview.value = v;
        stPreview.text = String(v) + " px";
    }
    slPreview.onChanging = updatePreviewLabel;
    slPreview.onChange = updatePreviewLabel;
    updatePreviewLabel();

    var insertPanel = w.add("panel", undefined, "Вставка");
    insertPanel.orientation = "column";
    insertPanel.alignChildren = ["fill", "top"];
    insertPanel.margins = 10;
    var chFaceScaleMatch = insertPanel.add("checkbox", undefined, "Подгонять масштаб лица");
    chFaceScaleMatch.value = current.face_scale_match === true;
    chFaceScaleMatch.helpTip = "Равномерно подгоняет размер лица до лица в текущем кадре. Масштаб оценивается только по геометрии лица; поворот не применяется. По умолчанию выключено.";
    var faceScaleHint = insertPanel.add("statictext", undefined,
        "Сравниваются две независимые пропорции лица и применяется больший коэффициент. Масштаб равномерный, без поворота; положение по-прежнему совмещается по глазам.",
        { multiline: true });
    faceScaleHint.preferredSize = [470, 34];

    var chCollectStatistics = insertPanel.add("checkbox", undefined, "Собирать статистику для обучения");
    chCollectStatistics.value = current.collect_statistics === true;
    chCollectStatistics.helpTip = "После успешной вставки сохраняется только пара: выбранное лицо > текущее лицо. Данные находятся в training_data рядом с Python-сервером и объединяются через merge_training_data.bat.";
    var recommendationRow = insertPanel.add("group");
    recommendationRow.orientation = "row";
    recommendationRow.alignChildren = ["left", "center"];
    var recommendationLabel = recommendationRow.add("statictext", undefined, "Подсветка лучшего дубля");
    recommendationLabel.preferredSize = [230, 20];
    var dlRecommendation = recommendationRow.add("dropdownlist", undefined);
    dlRecommendation.preferredSize = [220, 24];
    gfpPopulateValueDropdown(dlRecommendation, [
        { label: "Отключено", value: "off" },
        { label: "Публичная FBP", value: "public" },
        { label: "Моя обученная модель", value: "personal" },
        { label: "Публичная FBP + моя модель", value: "combined" }
    ]);
    gfpRestoreValueDropdown(dlRecommendation, current.recommendation_model, "public");
    var recommendationHint = insertPanel.add("statictext", undefined,
        "Тонкая зелёная рамка показывает один рекомендованный дубль. Публичная FBP оценивает удачность портрета, а личная модель может использовать ваш накопленный выбор.",
        { multiline: true });
    recommendationHint.preferredSize = [470, 34];
    var recommendationStatusText = "Публичная FBP: нужен install.bat. Личная модель: положите personal_preference.onnx в папку personal_model рядом с Python-сервером.";
    if (liveRecommendationBackends) {
        var publicState = liveRecommendationBackends.public || {};
        var personalState = liveRecommendationBackends.personal || {};
        recommendationStatusText = "Публичная FBP: " + (publicState.loaded ? "загружена" : (publicState.installed ? "установлена; загрузится при первом поиске" : "не установлена")) +
            "; личная модель: " + (personalState.loaded ? "загружена" : (personalState.installed ? "установлена; загрузится при первом поиске" : "не найдена"));
    }
    var recommendationStatus = insertPanel.add("statictext", undefined, recommendationStatusText, { multiline: true });
    recommendationStatus.preferredSize = [470, 32];

    var cachePanel = w.add("panel", undefined, "Кэш и поиск");
    cachePanel.orientation = "column";
    cachePanel.alignChildren = ["fill", "top"];
    cachePanel.margins = 10;
    var edCacheTtl = addLabeledEdit(cachePanel, "Срок жизни кэша анализа, часов", String(current.cache_ttl_hours), 80);
    var chGroupBoundarySearch = cachePanel.add("checkbox", undefined, "Поиск границ группы");
    chGroupBoundarySearch.value = current.group_boundary_search === true;
    chGroupBoundarySearch.helpTip = "Включено: анализ начинается от открытого кадра и останавливается после уверенной смены состава группы. Выключено: все поддерживаемые файлы папки считаются одной группой.";
    var boundaryHint = cachePanel.add("statictext", undefined,
        "Если в папке гарантированно только одна группа, отключение поиска границ немного ускоряет первичный анализ.",
        { multiline: true });
    boundaryHint.preferredSize = [470, 32];
    var thresholdRow = cachePanel.add("group");
    thresholdRow.orientation = "row";
    thresholdRow.alignChildren = ["fill", "center"];
    var thresholdText = thresholdRow.add("statictext", undefined, "Порог совпадения лица");
    thresholdText.preferredSize = [230, 20];
    var slThreshold = thresholdRow.add("slider", undefined, Math.round(Number(current.match_threshold) * 100), 10, 60);
    slThreshold.preferredSize = [220, 20];
    var stThreshold = thresholdRow.add("statictext", undefined, String(Math.round(Number(current.match_threshold) * 100)) + "%");
    stThreshold.preferredSize = [60, 20];
    function updateThresholdLabel() {
        var v = Math.round(Number(slThreshold.value));
        slThreshold.value = v;
        stThreshold.text = String(v) + "%";
    }
    slThreshold.onChanging = updateThresholdLabel;
    slThreshold.onChange = updateThresholdLabel;
    updateThresholdLabel();

    var note = w.add("statictext", undefined,
        "Все параметры сервер пытается применить сразу. Изменение адреса сервера или порта требует перезапуска run_server.bat. " +
        "При работе по сети исходные фотографии должны быть доступны Python-серверу по тому же пути (лучше UNC-путь).",
        { multiline: true });
    note.preferredSize = [490, 42];

    var buttons = w.add("group");
    buttons.orientation = "row";
    buttons.alignment = ["center", "top"];
    var ok = buttons.add("button", undefined, "Сохранить", { name: "ok" });
    var cancel = buttons.add("button", undefined, "Отмена", { name: "cancel" });

    var resultConfig = null;
    ok.onClick = function () {
        var selectedComputeMode = gfpReadValueDropdown(dlMode, current.compute_mode || "auto");
        var selectedAnalysisQuality = gfpReadValueDropdown(dlQuality, current.analysis_quality || "balanced");
        resultConfig = gfpNormalizeConfig({
            server_host: edServerHost.text,
            server_port: Number(edPort.text),
            preview_size: Number(slPreview.value),
            cache_ttl_hours: Number(edCacheTtl.text),
            match_threshold: Number(slThreshold.value) / 100.0,
            compute_mode: selectedComputeMode,
            scan_threads: Number(slThreads.value),
            preview_threads: Number(slPreviewThreads.value),
            analysis_quality: selectedAnalysisQuality,
            group_boundary_search: chGroupBoundarySearch.value === true,
            face_scale_match: chFaceScaleMatch.value === true,
            collect_statistics: chCollectStatistics.value === true,
            recommendation_model: gfpReadValueDropdown(dlRecommendation, current.recommendation_model || "public")
        });
        w.close(1);
    };
    cancel.onClick = function () {
        w.close(2);
    };

    w.center();
    var dialogResult = w.show();
    if (dialogResult != 1 || !resultConfig) {
        return false;
    }

    var serverResponse = null;
    var serverAvailable = false;
    var configForServer = gfpNormalizeConfig(resultConfig);
    try {
        var test = gfpApiRequestTo(oldHost, oldPort, { command: "ping" }, 2000);
        serverAvailable = !!(test && test.type == "answer");
    } catch (testError) {
        serverAvailable = false;
    }

    if (serverAvailable) {
        // Если пользователь не менял endpoint подключения, не подменяем bind
        // адрес удалённого Python-сервера его LAN-IP/именем из клиентского поля.
        // Это устраняет конфликт «0.0.0.0 на сервере ↔ LAN-IP у Photoshop».
        try {
            if (live && live.message && live.message.settings &&
                String(resultConfig.server_host) == String(localCurrent.server_host) &&
                Number(resultConfig.server_port) == Number(localCurrent.server_port)) {
                var liveBind = gfpNormalizeConfig(live.message.settings);
                configForServer.server_host = liveBind.server_host;
                configForServer.server_port = liveBind.server_port;
            }
        } catch (_) {
        }
        GFP_SETTINGS_APPLY_HOST = oldHost;
        GFP_SETTINGS_APPLY_PORT = oldPort;
        GFP_PENDING_SETTINGS_RESULT = null;
        GFP_PENDING_SETTINGS_ERROR = null;
        try {
            serverResponse = gfpApiRequestTo(oldHost, oldPort, { command: "set_settings", settings: configForServer }, 10000);
            if (serverResponse && serverResponse.type == "job" && serverResponse.message && serverResponse.message.job_id) {
                GFP_PENDING_SETTINGS_JOB_ID = String(serverResponse.message.job_id);
                GFP_PENDING_SETTINGS_CANCELLED = false;
                try {
                    app.doForcedProgress("Применение настроек Group Face Picker", "gfpPollSettingsJob();");
                } catch (progressError) {
                    if (gfpIsUserCancelError(progressError)) {
                        GFP_PENDING_SETTINGS_CANCELLED = true;
                        gfpCancelServerJob(GFP_PENDING_SETTINGS_JOB_ID, oldHost, oldPort);
                    } else {
                        throw progressError;
                    }
                }
                if (GFP_PENDING_SETTINGS_CANCELLED) {
                    return false;
                }
                if (GFP_PENDING_SETTINGS_ERROR) {
                    // Если сервер отклонил изменение (например, принудительный
                    // GPU недоступен), возвращаем локальный JSON к реально
                    // активным серверным значениям.
                    try {
                        var rollback = gfpApiRequestTo(oldHost, oldPort, { command: "get_settings" }, 3000);
                        if (rollback && rollback.type == "answer" && rollback.message && rollback.message.settings) {
                            var rollbackConfig = gfpNormalizeConfig(rollback.message.settings);
                            rollbackConfig.server_host = localCurrent.server_host;
                            rollbackConfig.server_port = localCurrent.server_port;
                            gfpSaveConfig(rollbackConfig);
                            gfpApplyConfig(rollbackConfig);
                        }
                    } catch (_) {
                    }
                    alert("Настройки не применены:\n\n" + GFP_PENDING_SETTINGS_ERROR, GFP_NAME, true);
                    return false;
                }
                serverResponse = { type: "answer", message: GFP_PENDING_SETTINGS_RESULT };
            } else if (serverResponse && serverResponse.type == "error") {
                alert("Настройки не применены:\n\n" + String(serverResponse.message || "Ошибка сервера."), GFP_NAME, true);
                return false;
            }
        } catch (applyError) {
            alert("Не удалось применить настройки на работающем сервере:\n\n" + gfpErrorText(applyError), GFP_NAME, true);
            return false;
        }

        // Не доверяем только факту завершения job: перечитываем настройки с
        // сервера и сохраняем именно то, что он реально принял.
        var authoritative = null;
        try {
            var verify = gfpApiRequestTo(oldHost, oldPort, { command: "get_settings" }, 3000);
            if (verify && verify.type == "answer" && verify.message && verify.message.settings) {
                authoritative = gfpNormalizeConfig(verify.message.settings);
            }
        } catch (verifyError) {
        }
        if (!authoritative && serverResponse && serverResponse.type == "answer" && serverResponse.message && serverResponse.message.settings) {
            authoritative = gfpNormalizeConfig(serverResponse.message.settings);
        }
        if (!authoritative) {
            alert("Сервер завершил применение настроек, но не удалось перечитать сохранённые значения.", GFP_NAME, true);
            return false;
        }
        if (!gfpSameConfigValues(configForServer, authoritative)) {
            alert("Сервер не подтвердил выбранные значения настроек. Ничего не будет скрыто: откройте настройки ещё раз — там будут показаны фактически сохранённые значения.", GFP_NAME, true);
            return false;
        }

        // Проверка live det_size выполняется сервером атомарно внутри
        // set_settings до того, как job получает статус done.

        var localAuthoritative = gfpNormalizeConfig(authoritative);
        localAuthoritative.server_host = resultConfig.server_host;
        localAuthoritative.server_port = resultConfig.server_port;
        gfpSaveConfig(localAuthoritative);
        var restartRequired = !!(serverResponse && serverResponse.type == "answer" && serverResponse.message && serverResponse.message.restart_required);
        if (restartRequired) {
            // Текущий процесс всё ещё слушает старый адрес. Не переключаем
            // соединение посреди сеанса, иначе release_query и последующие
            // запросы к нему перестанут работать. Новый адрес будет загружен
            // при следующем запуске JSX после перезапуска сервера.
            GFP_SETTINGS = localAuthoritative;
            GFP_API_HOST = oldHost;
            GFP_API_PORT_SEND = oldPort;
            alert("Настройки сохранены. Все параметры, которые можно изменить на работающем сервере, уже применены.\n\nНовый адрес сервера или порт будет использован после перезапуска run_server.bat.", GFP_NAME, true);
        } else {
            gfpApplyConfig(localAuthoritative);
        }
        return true;
    }

    // Сервер недоступен: локально сохраняем только endpoint подключения.
    // Производительность, кэш, качество анализа и вставка являются серверными
    // настройками; сохранять их как «ожидающие» значения было бы вторым
    // источником истины и после перезапуска давало бы конфликт конфигураций.
    var offlineConfig = gfpLoadConfig();
    offlineConfig.server_host = resultConfig.server_host;
    offlineConfig.server_port = resultConfig.server_port;
    offlineConfig.collect_statistics = resultConfig.collect_statistics === true;
    gfpSaveConfig(offlineConfig);
    gfpApplyConfig(offlineConfig);
    alert("Python-сервер сейчас недоступен. Сохранены адрес/порт подключения Photoshop и локальная галочка сбора статистики.\n\nОстальные параметры не изменены: откройте настройки после восстановления соединения и сохраните их на работающем сервере.", GFP_NAME, true);
    return true;
}

function gfpSameConfigValues(a, b) {
    var left = gfpNormalizeConfig(a);
    var right = gfpNormalizeConfig(b);
    var keys = ["server_host", "server_port", "preview_size", "cache_ttl_hours", "match_threshold", "compute_mode", "scan_threads", "preview_threads", "analysis_quality", "group_boundary_search", "face_scale_match", "collect_statistics", "recommendation_model"];
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (String(left[key]) != String(right[key])) {
            return false;
        }
    }
    return true;
}

function gfpPollSettingsJob() {
    var started = (new Date()).getTime();
    var consecutiveNetworkFailures = 0;
    for (;;) {
        if ((new Date()).getTime() - started > GFP_JOB_TIMEOUT) {
            GFP_PENDING_SETTINGS_ERROR = "Превышено время ожидания применения настроек.";
            return false;
        }
        var response = gfpApiRequestTo(GFP_SETTINGS_APPLY_HOST, GFP_SETTINGS_APPLY_PORT,
            { command: "job_status", job_id: GFP_PENDING_SETTINGS_JOB_ID }, 1500);
        if (!response) {
            consecutiveNetworkFailures++;
            if (consecutiveNetworkFailures >= 2) {
                GFP_PENDING_SETTINGS_ERROR = "Python-сервер дважды подряд не ответил при применении настроек.";
                return false;
            }
            app.changeProgressText("Временный сбой связи с сервером; повтор запроса настроек...");
            $.sleep(250);
            continue;
        }
        consecutiveNetworkFailures = 0;
        if (response.type == "error") {
            GFP_PENDING_SETTINGS_ERROR = String(response.message || "Ошибка применения настроек.");
            return false;
        }
        var status = response.message || {};
        var progress = Math.max(0, Math.min(1, Number(status.progress) || 0));
        if (!gfpUpdateNativeProgress(Math.round(progress * 1000), 1000, String(status.text || "Применение настроек..."))) {
            GFP_PENDING_SETTINGS_CANCELLED = true;
            gfpCancelServerJob(GFP_PENDING_SETTINGS_JOB_ID, GFP_SETTINGS_APPLY_HOST, GFP_SETTINGS_APPLY_PORT);
            return false;
        }
        if (status.status == "done") {
            if (!gfpUpdateNativeProgress(1000, 1000, "Настройки применены.")) {
                GFP_PENDING_SETTINGS_CANCELLED = true;
                return false;
            }
            GFP_PENDING_SETTINGS_RESULT = status.result;
            return true;
        }
        if (status.status == "cancelled" || status.status == "cancelling") {
            GFP_PENDING_SETTINGS_CANCELLED = true;
            return false;
        }
        if (status.status == "error") {
            GFP_PENDING_SETTINGS_ERROR = String(status.error || "Ошибка применения настроек.");
            return false;
        }
        $.sleep(120);
    }
}

function gfpObjectToJSON(obj) {
    if (obj === null || obj === undefined) {
        return "null";
    }

    var objType = typeof obj;
    if (objType == "string") {
        return "\"" + gfpJsString(obj) + "\"";
    }
    if (objType == "number") {
        return isFinite(obj) ? String(obj) : "null";
    }
    if (objType == "boolean") {
        return obj ? "true" : "false";
    }
    if (obj instanceof Array) {
        var arr = [];
        for (var i = 0; i < obj.length; i++) {
            arr.push(gfpObjectToJSON(obj[i]));
        }
        return "[" + arr.join(",") + "]";
    }

    var result = [];
    for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
            result.push("\"" + gfpJsString(key) + "\":" + gfpObjectToJSON(obj[key]));
        }
    }
    return "{" + result.join(",") + "}";
}

function gfpJsString(value) {
    var text = String(value);
    var result = "";
    for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        var code = text.charCodeAt(i);
        if (ch == "\\") {
            result += "\\\\";
        } else if (ch == "\"") {
            result += "\\\"";
        } else if (ch == "\r") {
            result += "\\r";
        } else if (ch == "\n") {
            result += "\\n";
        } else if (ch == "\t") {
            result += "\\t";
        } else if (ch == "\f") {
            result += "\\f";
        } else if (code < 32 || code > 126) {
            var hex = code.toString(16);
            while (hex.length < 4) {
                hex = "0" + hex;
            }
            result += "\\u" + hex;
        } else {
            result += ch;
        }
    }
    return result;
}

function gfpErrorText(value) {
    if (value === null || value === undefined) {
        return "Неизвестная ошибка.";
    }
    if (value.message !== undefined) {
        return String(value.message) + (value.line ? "\n\nСтрока JSX: " + value.line : "");
    }
    return String(value);
}
