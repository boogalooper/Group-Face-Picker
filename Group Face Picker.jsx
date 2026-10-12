#target photoshop
var GFP_SHIFT_LAUNCH = !!ScriptUI.environment.keyboardState.shiftKey;
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
var GFP_VERSION = "0.6.49";
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
var GFP_SETTINGS = gfpLoadConfig();
gfpApplyConfig(GFP_SETTINGS);

try {
    // Как в img2img helper: Shift действует только на текущий запуск.
    // Для Group Face Picker это короткий путь непосредственно к настройкам;
    // основной поиск/вставка в этот запуск не выполняются.
    if (GFP_SHIFT_LAUNCH || ScriptUI.environment.keyboardState.shiftKey || !app.documents.length) {
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
            if (GFP_SERVER_START_ERROR) startupDetails += "\n\n" + GFP_SERVER_START_ERROR;
            if (confirm("Python-сервер не запущен или недоступен по текущему адресу. Время ожидания истекло. Запустите run_server.bat вручную." + startupDetails + "\n\nОткрыть настройки подключения?")) {
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
                app.doForcedProgress("Инициализация модели распознавания лиц", "gfpPollSelectionJob();");
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
            gfpCancelServerJob(GFP_PENDING_JOB_ID);
            return false;
        }

        var response = gfpApiRequest({ command: "job_status", job_id: GFP_PENDING_JOB_ID }, 1500);
        if (!response) {
            consecutiveNetworkFailures++;
            if (consecutiveNetworkFailures >= 2) {
                GFP_PENDING_JOB_ERROR = "Python-сервер дважды подряд не ответил во время подготовки превью.";
                gfpCancelServerJob(GFP_PENDING_JOB_ID);
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
        if (status.status == "done") {
            // One server poll produces one Photoshop progress update. Capture
            // the query first so Esc on this final update can release it.
            GFP_PENDING_JOB_RESULT = status.result;
            if (!gfpUpdateNativeProgress(1000, 1000, "Превью готовы.")) {
                GFP_PENDING_JOB_CANCELLED = true;
                try {
                    if (GFP_PENDING_JOB_RESULT && GFP_PENDING_JOB_RESULT.query_id) {
                        gfpApiFire({ command: "release_query", query_id: String(GFP_PENDING_JOB_RESULT.query_id) });
                    }
                } catch (_) {
                }
                return false;
            }
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
        var progress = Math.max(0, Math.min(1, Number(status.progress) || 0));
        if (!gfpUpdateNativeProgress(Math.round(progress * 1000), 1000, String(status.text || "Подготовка превью лиц...") + " · " + Math.floor(((new Date()).getTime() - started) / 1000) + " с")) {
            GFP_PENDING_JOB_CANCELLED = true;
            gfpCancelServerJob(GFP_PENDING_JOB_ID);
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

// Bounded contribution from face height; no rotation or anisotropic scaling.
function gfpEstimateFaceScale(eyeRatio, heightRatio) {
    if (!isFinite(eyeRatio) || !isFinite(heightRatio) || eyeRatio <= 0 || heightRatio <= 0) {
        throw new Error("Некорректные пропорции лица для масштабирования.");
    }
    var relativeHeight = heightRatio / eyeRatio;
    // Strong disagreement indicates pose/expression differences: use eyes only.
    if (relativeHeight < 0.8 || relativeHeight > 1.25) return eyeRatio;
    var weight = 0.25 * Math.max(0, 1 - Math.abs(Math.log(relativeHeight)) / Math.log(1.25));
    return eyeRatio * Math.exp(weight * Math.log(relativeHeight));
}

// Fit translation and optional uniform scale from existing landmarks only.
// Eyes dominate; robust auxiliary weights limit expression/pose influence.
function gfpFitFaceGeometry(source, target, baseScale, allowScale) {
    var fallback = { scale: baseScale, offsetX: 0, offsetY: 0 };
    if (!source || !target || source.length < 5 || target.length < 5) return fallback;
    if (!isFinite(baseScale) || baseScale <= 0) return fallback;
    var i, j;
    for (i = 0; i < 5; i++) {
        if (!source[i] || !target[i]) return fallback;
        for (j = 0; j < 2; j++) {
            if (!isFinite(Number(source[i][j])) || !isFinite(Number(target[i][j]))) return fallback;
        }
    }
    var sx = (Number(source[0][0]) + Number(source[1][0])) / 2;
    var sy = (Number(source[0][1]) + Number(source[1][1])) / 2;
    var tx = (Number(target[0][0]) + Number(target[1][0])) / 2;
    var ty = (Number(target[0][1]) + Number(target[1][1])) / 2;
    var eyeWidth = gfpDistance(Number(target[0][0]), Number(target[0][1]), Number(target[1][0]), Number(target[1][1]));
    var sourceWidth = gfpDistance(Number(source[0][0]), Number(source[0][1]), Number(source[1][0]), Number(source[1][1]));
    if (eyeWidth <= 1 || sourceWidth <= 1) return fallback;
    var p = [], q = [];
    for (i = 0; i < 5; i++) {
        p.push([Number(source[i][0]) - sx, Number(source[i][1]) - sy]);
        q.push([Number(target[i][0]) - tx, Number(target[i][1]) - ty]);
    }
    function eyeError(scale, dx, dy) {
        var sum = 0;
        for (var e = 0; e < 2; e++) {
            var ex = scale * p[e][0] + dx - q[e][0];
            var ey = scale * p[e][1] + dy - q[e][1];
            sum += ex * ex + ey * ey;
        }
        return Math.sqrt(sum / 2);
    }
    var baselineError = eyeError(baseScale, 0, 0);
    // A substantial angle/pose mismatch cannot be solved without rotation.
    if (baselineError > eyeWidth * 0.15) return fallback;
    var scale = baseScale, dx = 0, dy = 0;
    var baseWeights = [1, 1, 0.25, 0.125, 0.125];
    var auxiliaryUsed = false;
    for (var iteration = 0; iteration < 3; iteration++) {
        var weights = [], total = 0, px = 0, py = 0, qx = 0, qy = 0;
        auxiliaryUsed = false;
        for (i = 0; i < 5; i++) {
            var weight = baseWeights[i];
            if (i >= 2) {
                // Gate against the original eye fit, so rejected landmarks
                // cannot gain influence by pulling successive iterations.
                var initialResidual = gfpDistance(baseScale * p[i][0], baseScale * p[i][1], q[i][0], q[i][1]);
                var residual = gfpDistance(scale * p[i][0] + dx, scale * p[i][1] + dy, q[i][0], q[i][1]);
                var ratio = Math.max(initialResidual, residual) / (eyeWidth * 0.25);
                weight *= ratio >= 1 ? 0 : Math.pow(1 - ratio * ratio, 2);
                if (weight > 0.001) auxiliaryUsed = true;
            }
            weights.push(weight);
            total += weight;
            px += weight * p[i][0]; py += weight * p[i][1];
            qx += weight * q[i][0]; qy += weight * q[i][1];
        }
        if (!auxiliaryUsed) return fallback;
        px /= total; py /= total; qx /= total; qy /= total;
        scale = baseScale;
        if (allowScale) {
            // Regularize toward the established eye/height scale estimate.
            var prior = 2 * sourceWidth * sourceWidth;
            var numerator = prior * baseScale, denominator = prior;
            for (i = 0; i < 5; i++) {
                var ax = p[i][0] - px, ay = p[i][1] - py;
                numerator += weights[i] * (ax * (q[i][0] - qx) + ay * (q[i][1] - qy));
                denominator += weights[i] * (ax * ax + ay * ay);
            }
            scale = Math.max(baseScale * 0.95, Math.min(baseScale * 1.05, numerator / denominator));
        }
        dx = qx - scale * px; dy = qy - scale * py;
        var shift = Math.sqrt(dx * dx + dy * dy);
        var maxShift = eyeWidth * 0.03;
        if (shift > maxShift) { dx *= maxShift / shift; dy *= maxShift / shift; }
    }
    if (scale < 0.25 || scale > 4.0) return fallback;
    if (!isFinite(scale) || !isFinite(dx) || !isFinite(dy) ||
        eyeError(scale, dx, dy) > Math.min(eyeWidth * 0.15, baselineError + eyeWidth * 0.02)) return fallback;
    return { scale: scale, offsetX: dx, offsetY: dy };
}

function gfpFacePlacement(eyeX, eyeY, targetX, targetY, scale, width, height, sourceWidth, sourceHeight) {
    var values = [eyeX, eyeY, targetX, targetY, scale, width, height, sourceWidth, sourceHeight];
    for (var i = 0; i < values.length; i++) {
        if (!isFinite(values[i])) throw new Error("Некорректные координаты лица.");
    }
    if (scale <= 0 || width <= 0 || height <= 0) throw new Error("Некорректный размер фрагмента.");
    var x = eyeX - targetX / scale;
    var y = eyeY - targetY / scale;
    if (x < 0 || y < 0 || x + width / scale > sourceWidth || y + height / scale > sourceHeight) {
        throw new Error("Точное совмещение требует фрагмент за пределами исходного кадра.");
    }
    // A small margin prevents edge gaps after fractional translation/resampling.
    var margin = Math.ceil(2 / Math.min(1, scale));
    var left = Math.max(0, Math.floor(x) - margin);
    var top = Math.max(0, Math.floor(y) - margin);
    var right = Math.min(sourceWidth, Math.ceil(x + width / scale) + margin);
    var bottom = Math.min(sourceHeight, Math.ceil(y + height / scale) + margin);
    return {left: left, top: top, right: right, bottom: bottom,
        offsetX: (left - x) * scale, offsetY: (top - y) * scale};
}

function gfpFitClothing(points, targets, scale, allowScale, allowRotation, eyes, targetEyes, weights) {
    if (points.length < 10 || points.length != targets.length) return null;
    for(var valid=0;valid<points.length;valid++){
        if(!points[valid]||!targets[valid]||!isFinite(points[valid][0]+points[valid][1]+targets[valid][0]+targets[valid][1]))return null;
    }
    var sx=0, sy=0, tx=0, ty=0, totalWeight=0, i;
    function weight(index) {
        var value=weights && weights.length==points.length ? Number(weights[index]) : 1;
        return isFinite(value) && value>0 ? Math.min(3,value) : 1;
    }
    for(i=0;i<points.length;i++){
        var wi=weight(i); totalWeight+=wi;
        sx+=wi*points[i][0];sy+=wi*points[i][1];tx+=wi*targets[i][0];ty+=wi*targets[i][1];
    }
    sx/=totalWeight;sy/=totalWeight;tx/=totalWeight;ty/=totalWeight;
    var dot=0,cross=0,den=0;
    for(i=0;i<points.length;i++){
        var x=points[i][0]-sx,y=points[i][1]-sy,u=targets[i][0]-tx,v=targets[i][1]-ty;
        var wi=weight(i); dot+=wi*(x*u+y*v);cross+=wi*(x*v-y*u);den+=wi*(x*x+y*y);
    }
    if(!(den>1))return null;
    var angle=allowRotation?Math.atan2(cross,dot):0;
    var fittedScale=allowScale?(dot*Math.cos(angle)+cross*Math.sin(angle))/den:scale;
    if(!isFinite(fittedScale)||fittedScale<scale*.95||fittedScale>scale*1.05||Math.abs(angle)>8*Math.PI/180)return null;
    var c=Math.cos(angle)*fittedScale,s=Math.sin(angle)*fittedScale,error=0;
    for(i=0;i<points.length;i++){
        var dx=tx+c*(points[i][0]-sx)-s*(points[i][1]-sy)-targets[i][0];
        var dy=ty+s*(points[i][0]-sx)+c*(points[i][1]-sy)-targets[i][1];
        error+=weight(i)*(dx*dx+dy*dy);
    }
    var d=gfpDistance(targetEyes[0][0],targetEyes[0][1],targetEyes[1][0],targetEyes[1][1]);
    if(!(d>1)||Math.sqrt(error/totalWeight)>.05*d)return null;
    for(i=0;i<2;i++){
        var ex=tx+c*(eyes[i][0]-sx)-s*(eyes[i][1]-sy);
        var ey=ty+s*(eyes[i][0]-sx)+c*(eyes[i][1]-sy);
        if(gfpDistance(ex,ey,targetEyes[i][0],targetEyes[i][1])>.30*d)return null;
    }
    return {sourceX:sx,sourceY:sy,targetX:tx,targetY:ty,scale:fittedScale,angle:angle};
}

function gfpAffinePlacement(transform, width, height, sourceWidth, sourceHeight) {
    var c=Math.cos(transform.angle),s=Math.sin(transform.angle),scale=transform.scale;
    var corners=[[0,0],[width,0],[width,height],[0,height]],left=sourceWidth,top=sourceHeight,right=0,bottom=0;
    for(var i=0;i<4;i++){
        var dx=(corners[i][0]-transform.targetX)/scale,dy=(corners[i][1]-transform.targetY)/scale;
        var x=transform.sourceX+c*dx+s*dy,y=transform.sourceY-s*dx+c*dy;
        left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
    }
    if(!isFinite(left+top+right+bottom)||left<0||top<0||right>sourceWidth||bottom>sourceHeight)throw new Error("Поворот или уточнение по одежде выводит фрагмент за границы исходного кадра.");
    var margin=Math.ceil(2/Math.min(1,scale));
    left=Math.max(0,Math.floor(left)-margin);top=Math.max(0,Math.floor(top)-margin);
    right=Math.min(sourceWidth,Math.ceil(right)+margin);bottom=Math.min(sourceHeight,Math.ceil(bottom)+margin);
    var cx=(left+right)*.5-transform.sourceX,cy=(top+bottom)*.5-transform.sourceY;
    return {left:left,top:top,right:right,bottom:bottom,
        centerX:transform.targetX+scale*(c*cx-s*cy),centerY:transform.targetY+scale*(s*cx+c*cy)};
}

function gfpPreviewOrder(matches, items, mode) {
    function compareNames(a, b) {
        var left = String(matches[a].name || items[a].name || "").toLowerCase().match(/\d+|\D+/g) || [];
        var right = String(matches[b].name || items[b].name || "").toLowerCase().match(/\d+|\D+/g) || [];
        for (var n = 0; n < Math.min(left.length, right.length); n++) {
            var x = left[n], y = right[n];
            if (x == y) continue;
            if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
                var difference = Number(x) - Number(y);
                if (difference) return difference;
            } else return x < y ? -1 : 1;
        }
        if (left.length != right.length) return left.length - right.length;
        var wholeLeft = String(matches[a].name || "").toLowerCase();
        var wholeRight = String(matches[b].name || "").toLowerCase();
        return wholeLeft == wholeRight ? a - b : (wholeLeft < wholeRight ? -1 : 1);
    }
    function score(index) {
        var value = mode == "similarity" ? matches[index].similarity : items[index].recommendation_score;
        return value === null || value === undefined || !isFinite(Number(value)) ? null : Number(value);
    }
    var order = [];
    for (var i = 0; i < items.length; i++) order.push(i);
    order.sort(function (a, b) {
        if (mode != "filename") {
            var x = score(a), y = score(b);
            if (x === null && y !== null) return 1;
            if (y === null && x !== null) return -1;
            if (x !== null && y !== null && x != y) return y - x;
        }
        return compareNames(a, b);
    });
    return order;
}

function gfpShowDialog(payload) {
    var items = payload.previews && payload.previews.items ? payload.previews.items : [];
    if (!items.length || items.length != payload.matches.length) throw new Error("Сервер не вернул корректный набор превью.");
    // selectedIndex always refers to the server query, never a visual slot.
    var selectedIndex = -1, lastClickIndex = -1, lastClickTime = 0;
    var previewButtons = [], loadedImages = [], displayOrder = [];
    var initialIndex = 0, page = 0, pageSize = items.length, columns = 1;
    var busy = false, initializing = true;
    var recommendation = payload.previews.recommendation || {};
    var sortMode = String(payload.previews.preview_sort || GFP_SETTINGS.preview_sort || "filename");
    var requestedSize = Number(payload.previews.preview_size || GFP_SETTINGS.preview_size || 184);
    var thumbWidth = Number(payload.previews.thumb_width) || requestedSize;
    var screenWidth = 1280, screenHeight = 900;
    try {
        var screens = $.screens;
        var screen = screens[0];
        for (var sc = 0; sc < screens.length; sc++) if (screens[sc].primary) screen = screens[sc];
        screenWidth = screen.right - screen.left;
        screenHeight = screen.bottom - screen.top;
    } catch (screenError) {}
    for (var ri = 0; ri < items.length; ri++) if (items[ri].is_recommended === true) { initialIndex = ri; break; }

    function fixedSize(control, width, height) {
        // Release old constraints before increasing or decreasing a control.
        control.minimumSize = [0, 0];
        control.maximumSize = [100000, 100000];
        control.preferredSize = [width, height];
        control.minimumSize = [width, height];
        control.maximumSize = [width, height];
        control.alignment = ["left", "center"];
    }

    var w = new Window("dialog", String(payload.app_name) + " " + String(payload.version));
    w.orientation = "column"; w.alignChildren = ["fill", "top"]; w.spacing = 7; w.margins = 12;
    var topRow = w.add("group");
    topRow.orientation = "row"; topRow.alignChildren = ["left", "center"]; topRow.spacing = 8; topRow.margins = 0;
    var header = topRow.add("statictext", undefined, "Найдено кадров: " + items.length +
        (recommendation.status == "ok" && recommendation.label ? " · " + recommendation.label : ""));
    var settingsButton = topRow.add("button", undefined, "⚙");
    fixedSize(settingsButton, 34, 24); settingsButton.helpTip = "Глобальные настройки";

    var toolbar = w.add("group"); toolbar.orientation = "row"; toolbar.alignChildren = ["left", "center"]; toolbar.spacing = 8; toolbar.margins = 0;
    var sortTitle = toolbar.add("statictext", undefined, "Порядок:"); fixedSize(sortTitle, 55, 20);
    var dlSort = toolbar.add("dropdownlist"); fixedSize(dlSort, 185, 24);
    gfpPopulateValueDropdown(dlSort, [
        {label:"По порядку файлов", value:"filename"},
        {label:"По похожести", value:"similarity"},
        {label:"По удачности", value:"attractiveness"}
    ]);
    gfpRestoreValueDropdown(dlSort, sortMode, "filename");
    dlSort.helpTip = "Перестраивает сетку без нового поиска; выбранный кадр сохраняется. Без оценок модели используется порядок файлов.";
    var toolbarSpacer = toolbar.add("group");
    var sizeControls = toolbar.add("group");
    sizeControls.orientation = "row"; sizeControls.alignChildren = ["left", "center"];
    sizeControls.spacing = 6; sizeControls.margins = 0;
    fixedSize(sizeControls, 250, 24);
    var sizeTitle = sizeControls.add("statictext", undefined, "Размер:"); fixedSize(sizeTitle, 44, 20);
    var slSize = sizeControls.add("slider", undefined, requestedSize, 64, 320); fixedSize(slSize, 140, 20);
    var sizeLabel = sizeControls.add("statictext", undefined, requestedSize + " px"); fixedSize(sizeLabel, 54, 20);
    slSize.helpTip = "64–320 px. Превью обновляются после отпускания ползунка, без распознавания лиц.";

    var grid = w.add("group"); grid.orientation = "column"; grid.alignChildren = ["left", "top"]; grid.spacing = 6; grid.margins = 0;
    var pager = w.add("group"); pager.orientation = "row"; pager.alignment = ["center", "top"];
    var previousPage = pager.add("button", undefined, "‹"); fixedSize(previousPage, 32, 22);
    var pageLabel = pager.add("statictext", undefined, ""); pageLabel.preferredSize = [140, 20]; pageLabel.justify = "center";
    var nextPage = pager.add("button", undefined, "›"); fixedSize(nextPage, 32, 22);
    var divider = w.add("panel"); divider.preferredSize = [-1, 1];
    var status = w.add("statictext", undefined, ""); status.preferredSize = [-1, 20];
    status.helpTip = recommendation.message || "";
    var bottom = w.add("group"); bottom.orientation = "row"; bottom.alignChildren = ["left", "center"];
    bottom.spacing = 8; bottom.margins = 0;
    var initialFaceScaleMatch = GFP_SETTINGS.face_scale_match === true;
    var chFaceScaleMatch = bottom.add("checkbox", undefined, "Подгонять масштаб лица");
    fixedSize(chFaceScaleMatch, 240, 24);
    chFaceScaleMatch.value = initialFaceScaleMatch;
    chFaceScaleMatch.helpTip = "Равномерная подгонка масштаба без поворота. Запоминается для следующих вставок.";
    var bottomSpacer = bottom.add("group"); bottomSpacer.alignment = ["fill", "center"];
    var actionButtons = bottom.add("group");
    actionButtons.orientation = "row"; actionButtons.alignChildren = ["left", "center"];
    actionButtons.spacing = 8; actionButtons.margins = 0; fixedSize(actionButtons, 270, 26);
    var insertButton = actionButtons.add("button", undefined, "Вставить выбранное", {name:"ok"});
    fixedSize(insertButton, 172, 26); insertButton.enabled = false;
    var cancelButton = actionButtons.add("button", undefined, "Отмена", {name:"cancel"}); fixedSize(cancelButton, 90, 26);
    var helper = w.add("statictext", undefined, "Стрелки — выбор · Enter — вставить · Двойной клик — вставить");
    try { helper.graphics.foregroundColor = helper.graphics.newBrush(helper.graphics.BrushType.SOLID_COLOR, [0.65, 0.65, 0.65, 1]); } catch (colorError) {}

    function visualPosition(index) {
        for (var p = 0; p < displayOrder.length; p++) if (displayOrder[p] == index) return p;
        return -1;
    }
    function resetClicks() { lastClickIndex = -1; lastClickTime = 0; }
    function clearImages() {
        for (var i = 0; i < previewButtons.length; i++) {
            // ScriptUI Image.image rejects null. Leave the native image intact;
            // removing its parent below releases the old control.
            previewButtons[i].gfpNormalImage = null; previewButtons[i].gfpSelectedImage = null;
        }
        previewButtons = [];
    }
    function imagePair(index) {
        if (loadedImages[index]) return loadedImages[index];
        var normal = new File(String(items[index].path)), selected = new File(String(items[index].selected_path || ""));
        if (!normal.exists || !selected.exists) throw new Error("Превью не найдено. Повторите поиск лица.");
        loadedImages[index] = { normal:ScriptUI.newImage(normal), selected:ScriptUI.newImage(selected) };
        return loadedImages[index];
    }
    function updateStatus() {
        if (selectedIndex < 0) { status.text = "Выберите кадр"; return; }
        var match = payload.matches[selectedIndex], item = items[selectedIndex];
        var score = Number(match.similarity);
        var text = String(match.name || item.name) + " · Кадр " + (visualPosition(selectedIndex) + 1) + " из " + items.length;
        if (isFinite(score)) text += " · Похожесть " + score.toFixed(3);
        if (match.is_active === true) text += " · Текущий кадр";
        if (item.is_recommended === true) text += " · Рекомендован моделью";
        status.text = text;
        status.helpTip = text + (recommendation.message ? "\n" + recommendation.message : "");
    }
    function refreshFrames() {
        for (var i = 0; i < previewButtons.length; i++) {
            var button = previewButtons[i], selected = button.gfpIndex == selectedIndex;
            if (button.gfpSelected != selected) {
                button.gfpSelected = selected;
                button.image = selected ? button.gfpSelectedImage : button.gfpNormalImage;
            }
        }
    }
    function pinSettingsButton() {
        // Apply the final position after ScriptUI's automatic layout. Using
        // the actual client width avoids retaining the previous grid width.
        var available = Math.max(0, Number(w.size.width || w.size[0]) - 24);
        topRow.size = [available, 24];
        header.size = [Math.max(0, available - 42), 20];
        header.location = [0, 2];
        settingsButton.size = [34, 24];
        settingsButton.location = [Math.max(0, available - 34), 0];
    }
    function rebuildGrid(followSelection) {
        clearImages();
        while (grid.children.length) grid.remove(grid.children[0]);
        var cellSize = thumbWidth + 8;
        var maxColumns = Math.max(1, Math.floor((screenWidth - 64) / (cellSize + 6)));
        columns = Math.max(1, Math.min(Number(payload.previews.columns) || 6, maxColumns, items.length));
        var rows = Math.max(1, Math.floor((screenHeight - 270) / (cellSize + 27)));
        pageSize = columns * rows;
        if (followSelection && selectedIndex >= 0) page = Math.floor(Math.max(0, visualPosition(selectedIndex)) / pageSize);
        page = Math.max(0, Math.min(Math.ceil(items.length / pageSize) - 1, page));
        var start = page * pageSize, end = Math.min(items.length, start + pageSize), row = null;
        for (var slot = start; slot < end; slot++) {
            if ((slot - start) % columns == 0) {
                row = grid.add("group"); row.orientation = "row"; row.alignChildren = ["left", "top"]; row.spacing = 6; row.margins = 0;
            }
            var index = displayOrder[slot], pair = imagePair(index);
            var cell = row.add("group"); cell.orientation = "column"; cell.alignChildren = ["center", "top"]; cell.spacing = 2; cell.margins = 0; cell.gfpIndex = index;
            var image = cell.add("image", undefined, pair.normal); image.gfpIndex = index;
            image.gfpNormalImage = pair.normal; image.gfpSelectedImage = pair.selected; image.gfpSelected = false;
            image.preferredSize = [cellSize, cellSize]; image.minimumSize = image.preferredSize; image.maximumSize = image.preferredSize;
            var filename = String(payload.matches[index].name || items[index].name || "").replace(/^.*[\\\/]/, "");
            var extension = filename.lastIndexOf("."); if (extension > 0) filename = filename.substring(0, extension);
            var caption = cell.add("statictext", undefined, filename.length > 22 ? filename.substring(0, 21) + "…" : filename);
            caption.justify = "center"; caption.preferredSize = [cellSize, 20]; caption.gfpIndex = index;
            var tip = String(payload.matches[index].name) + "\nПохожесть: " + Number(payload.matches[index].similarity).toFixed(3);
            if (items[index].recommendation_score !== null && items[index].recommendation_score !== undefined) tip += "\nОценка модели: " + Number(items[index].recommendation_score).toFixed(3);
            image.helpTip = tip; caption.helpTip = tip;
            previewButtons.push(image);
        }
        var pageCount = Math.ceil(items.length / pageSize);
        pager.visible = pageCount > 1; pager.maximumSize.height = pageCount > 1 ? 28 : 0;
        pageLabel.text = "Страница " + (page + 1) + " из " + pageCount;
        previousPage.enabled = page > 0; nextPage.enabled = page + 1 < pageCount;
        var width = Math.max(650, columns * (cellSize + 6) - 6);
        // Set all row widths afresh, including minimum/maximum bounds. A
        // previous large layout must not push fixed controls off a smaller one.
        fixedSize(header, width - 34 - topRow.spacing, 20);
        fixedSize(topRow, width, 24); topRow.alignment = ["fill", "top"];
        fixedSize(toolbarSpacer, Math.max(0, width - 55 - 185 - 250 - 3 * toolbar.spacing), 1);
        fixedSize(toolbar, width, 24); toolbar.alignment = ["fill", "top"];
        fixedSize(bottomSpacer, Math.max(0, width - 240 - 270 - 2 * bottom.spacing), 1);
        fixedSize(bottom, width, 26); bottom.alignment = ["fill", "top"];
        grid.preferredSize = [width, -1];
        fixedSize(status, width, 20); status.alignment = ["fill", "top"];
        refreshFrames(); updateStatus();
        w.layout.layout(true);
        var visibleRows = Math.ceil((end - start) / columns);
        w.size = [width + 24, visibleRows * (cellSize + 28) + 180 + (pageCount > 1 ? 28 : 0)];
        w.layout.resize();
        pinSettingsButton();
        if (!initializing) { w.center(); w.update(); }
    }
    function selectIndex(index) {
        if (busy || index < 0 || index >= items.length) return;
        selectedIndex = index;
        var newPage = Math.floor(visualPosition(index) / pageSize);
        if (newPage != page) { page = newPage; rebuildGrid(false); }
        refreshFrames();
        var active = payload.matches[index].is_active === true;
        if (active) { try { chFaceScaleMatch.active = true; } catch (focusError) {} }
        insertButton.enabled = !active;
        updateStatus();
        try { if (!active) insertButton.active = true; } catch (focusError) {}
        w.update();
    }
    function setBusy(value) {
        busy = value; toolbar.enabled = !value; grid.enabled = !value; settingsButton.enabled = !value;
        bottom.enabled = !value; pager.enabled = !value;
    }
    function rememberOptions(render) {
        var response = gfpApiRequest({command:"refresh_previews", query_id:payload.query_id,
            preview_size:requestedSize, preview_sort:sortMode, render:render}, 60000);
        if (!response || response.type != "answer" || !response.message) throw new Error(response && response.message ? String(response.message) : "Сервер не ответил при обновлении превью.");
        return response.message;
    }
    function saveLocalOptions() {
        GFP_SETTINGS.preview_size = requestedSize; GFP_SETTINGS.preview_sort = sortMode;
        try { gfpSaveConfig(GFP_SETTINGS); } catch (saveError) { status.helpTip += "\nНе удалось сохранить клиентские настройки: " + gfpErrorText(saveError); }
    }
    grid.addEventListener("mousedown", function (event) {
        if (busy || event.button > 0) return;
        var control = event.target;
        while (control && control != grid) {
            if (typeof control.gfpIndex == "number") {
                var index = Number(control.gfpIndex), now = (new Date()).getTime();
                var doubleClick = lastClickIndex == index && now - lastClickTime <= 650;
                lastClickIndex = index; lastClickTime = now;
                selectIndex(index);
                if (doubleClick && payload.matches[index].is_active !== true) w.close(1);
                return;
            }
            control = control.parent;
        }
    }, true);
    dlSort.onChange = function () {
        if (initializing || busy) return;
        var previous = sortMode;
        sortMode = gfpReadValueDropdown(dlSort, "filename"); resetClicks();
        try {
            displayOrder = gfpPreviewOrder(payload.matches, items, sortMode);
            rebuildGrid(true); rememberOptions(false); saveLocalOptions();
        }
        catch (error) {
            sortMode = previous; initializing = true;
            gfpRestoreValueDropdown(dlSort, previous, "filename"); initializing = false;
            displayOrder = gfpPreviewOrder(payload.matches, items, sortMode); rebuildGrid(true);
            alert("Не удалось сохранить порядок превью:\n" + gfpErrorText(error), GFP_NAME, true);
        }
    };
    slSize.onChanging = function () { sizeLabel.text = Math.max(64, Math.min(320, Math.round(Number(slSize.value) / 8) * 8)) + " px"; };
    slSize.onChange = function () {
        if (initializing || busy) return;
        var nextSize = Math.max(64, Math.min(320, Math.round(Number(slSize.value) / 8) * 8));
        slSize.value = nextSize; sizeLabel.text = nextSize + " px";
        if (nextSize == requestedSize) return;
        var previous = requestedSize, previousItems = items, previousPreviews = payload.previews;
        var previousThumb = thumbWidth, previousImages = loadedImages;
        requestedSize = nextSize; resetClicks();
        setBusy(true); status.text = "Обновление превью…"; w.update();
        try {
            var answer = rememberOptions(true);
            if (!answer.previews || answer.previews.items.length != items.length) throw new Error("Сервер вернул неполный набор превью.");
            for (var pi = 0; pi < answer.previews.items.length; pi++) {
                var updatedItem = answer.previews.items[pi];
                if (!new File(String(updatedItem.path)).exists || !new File(String(updatedItem.selected_path)).exists) {
                    throw new Error("Сервер подготовил превью, но файл недоступен Photoshop.");
                }
            }
            clearImages(); loadedImages = []; items = answer.previews.items; payload.previews = answer.previews;
            thumbWidth = Number(answer.previews.thumb_width); requestedSize = Number(answer.preview_size);
            displayOrder = gfpPreviewOrder(payload.matches, items, sortMode);
            rebuildGrid(true); saveLocalOptions();
        } catch (error) {
            requestedSize = previous; slSize.value = previous; sizeLabel.text = previous + " px";
            items = previousItems; payload.previews = previousPreviews; thumbWidth = previousThumb; loadedImages = previousImages;
            displayOrder = gfpPreviewOrder(payload.matches, items, sortMode);
            rebuildGrid(true);
            updateStatus(); alert("Не удалось обновить превью:\n" + gfpErrorText(error), GFP_NAME, true);
        } finally { setBusy(false); w.update(); }
    };
    previousPage.onClick = function () { resetClicks(); selectIndex(displayOrder[Math.max(0, (page - 1) * pageSize)]); };
    nextPage.onClick = function () { resetClicks(); selectIndex(displayOrder[Math.min(items.length - 1, (page + 1) * pageSize)]); };
    settingsButton.onClick = function () {
        if (gfpShowSettingsDialog()) {
            status.text = "Настройки сохранены. Для смены модели рекомендации повторите поиск лица."; w.update();
        }
    };
    insertButton.onClick = function () { if (!busy && selectedIndex >= 0 && payload.matches[selectedIndex].is_active !== true) w.close(1); };
    cancelButton.onClick = function () { selectedIndex = -1; w.close(2); };
    w.addEventListener("keydown", function (event) {
        if (busy || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        var key = event.keyName;
        // Let dropdown/slider use their native arrow keys.
        if (event.target == dlSort || event.target == slSize) return;
        if (key != "Left" && key != "Right" && key != "Up" && key != "Down") return;
        event.preventDefault(); event.stopPropagation(); resetClicks();
        var position = visualPosition(selectedIndex >= 0 ? selectedIndex : initialIndex), next = position, col = position % columns;
        if (key == "Left" && col > 0) next--;
        if (key == "Right" && col < columns - 1 && next + 1 < items.length) next++;
        if (key == "Up" && next >= columns) next -= columns;
        if (key == "Down" && (Math.floor(next / columns) + 1) * columns < items.length) next = Math.min(next + columns, items.length - 1);
        selectIndex(displayOrder[next]);
    }, true);
    displayOrder = gfpPreviewOrder(payload.matches, items, sortMode);
    selectedIndex = initialIndex;
    rebuildGrid(true); initializing = false;
    w.onShow = function () { pinSettingsButton(); selectIndex(initialIndex); };
    w.onResize = w.onResizing = function () { w.layout.resize(); pinSettingsButton(); };
    w.center();
    var dialogResult = w.show();
    payload.collect_statistics = GFP_SETTINGS.collect_statistics === true;
    payload.face_scale_match = chFaceScaleMatch.value === true;
    if (payload.face_scale_match !== initialFaceScaleMatch) {
        GFP_SETTINGS.face_scale_match = payload.face_scale_match;
        try { gfpSaveConfig(GFP_SETTINGS); } catch (saveScaleError) {}
    }
    clearImages(); loadedImages = [];
    return dialogResult == 1 ? selectedIndex : -1;
}

function gfpRecordPreference(payload, index) {
    try {
        var response = gfpApiRequest({
            command: "record_preference",
            query_id: payload.query_id,
            selected_index: index,
            collect_statistics: payload.collect_statistics === true,
            face_scale_match: payload.face_scale_match === true
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

function gfpTransformLayer(scale, angle, offsetX, offsetY) {
    // Same center convention as Layer.transform in img2img helper.
    // One resampling pass for scale/rotation/translation together.
    var desc = new ActionDescriptor();
    desc.putEnumerated(GFP_S2T("freeTransformCenterState"), GFP_S2T("quadCenterState"), GFP_S2T("QCSAverage"));
    var offset = new ActionDescriptor();
    offset.putUnitDouble(GFP_S2T("horizontal"), GFP_S2T("pixelsUnit"), offsetX);
    offset.putUnitDouble(GFP_S2T("vertical"), GFP_S2T("pixelsUnit"), offsetY);
    desc.putObject(GFP_S2T("offset"), GFP_S2T("offset"), offset);
    desc.putUnitDouble(GFP_S2T("width"), GFP_S2T("percentUnit"), scale*100);
    desc.putUnitDouble(GFP_S2T("height"), GFP_S2T("percentUnit"), scale*100);
    desc.putUnitDouble(GFP_S2T("angle"), GFP_S2T("angleUnit"), angle);
    executeAction(GFP_S2T("transform"), desc, DialogModes.NO);
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
            align_clothing: GFP_SETTINGS.align_clothing === true,
            query_id: payload.query_id,
            index: index,
            face_scale_match: payload.face_scale_match === true
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

        if (!item.is_raw && (openedSourceWidth != analysisSourceWidth || openedSourceHeight != analysisSourceHeight)) {
            throw new Error("Размер открытого исходного кадра не совпадает с размером, использованным распознаванием.");
        }
        var affinePlacement = null, rotationDegrees = 0;
        var placementOffsetX = 0;
        var placementOffsetY = 0;
        // Recompute from actual document dimensions in both insertion modes.
        {
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
                // Eyes are the primary size cue. Mouth movement must not force
                // the larger of two ratios, as it did in earlier versions.
                faceScale = gfpEstimateFaceScale(targetFaceWidth / eyeWidth, targetFaceHeight / faceHeight);
                if (!isFinite(faceScale) || faceScale < 0.25 || faceScale > 4.0) {
                    throw new Error("Получен недопустимый коэффициент масштаба лица: " + String(faceScale));
                }
            }

            var sourcePoints = [];
            for (var pointIndex = 0; pointIndex < kps.length; pointIndex++) {
                sourcePoints.push([Number(kps[pointIndex][0]) * openedSourceWidth,
                                   Number(kps[pointIndex][1]) * openedSourceHeight]);
            }
            var baseScale = faceScale;
            var fit = gfpFitFaceGeometry(sourcePoints, item.target_kps_offsets, baseScale, faceScaleEnabled);
            faceScale = fit.scale;
            var sourceAnchorX = (eye0x + eye1x) * 0.5;
            var sourceAnchorY = (eye0y + eye1y) * 0.5;
            var targetAnchorX = (Number(offsets[0][0]) + Number(offsets[1][0])) * 0.5;
            var targetAnchorY = (Number(offsets[0][1]) + Number(offsets[1][1])) * 0.5;
            var placement;
            try {
                placement = gfpFacePlacement(sourceAnchorX, sourceAnchorY,
                    targetAnchorX + fit.offsetX, targetAnchorY + fit.offsetY,
                    faceScale, expectedWidth, expectedHeight, openedSourceWidth, openedSourceHeight);
            } catch (placementError) {
                if (faceScale == baseScale && fit.offsetX == 0 && fit.offsetY == 0) throw placementError;
                // A small correction must not make a previously usable crop
                // fail at the source edge. Retry the established eye fit.
                faceScale = baseScale;
                placement = gfpFacePlacement(sourceAnchorX, sourceAnchorY, targetAnchorX, targetAnchorY,
                    faceScale, expectedWidth, expectedHeight, openedSourceWidth, openedSourceHeight);
            }
            var transform = null;
            if (item.clothing_alignment) {
                var clothingPoints = [], clothing = item.clothing_alignment;
                for (var ci=0; ci<clothing.source_normalized.length; ci++) clothingPoints.push([
                    Number(clothing.source_normalized[ci][0])*openedSourceWidth,
                    Number(clothing.source_normalized[ci][1])*openedSourceHeight]);
                transform = gfpFitClothing(clothingPoints, clothing.target_offsets, faceScale,
                    faceScaleEnabled, GFP_SETTINGS.allow_rotation === true, sourcePoints, offsets, clothing.weights);
            }
            if (!transform && GFP_SETTINGS.allow_rotation === true) {
                var angle = Math.atan2(Number(offsets[1][1])-Number(offsets[0][1]), Number(offsets[1][0])-Number(offsets[0][0])) - Math.atan2(eye1y-eye0y,eye1x-eye0x);
                if (Math.abs(angle)<=5*Math.PI/180) transform = {sourceX:sourceAnchorX,sourceY:sourceAnchorY,
                    targetX:targetAnchorX+fit.offsetX,targetY:targetAnchorY+fit.offsetY,scale:faceScale,angle:angle};
            }
            if (transform) {
                try {
                    affinePlacement = gfpAffinePlacement(transform,expectedWidth,expectedHeight,openedSourceWidth,openedSourceHeight);
                    placement = affinePlacement; faceScale = transform.scale; rotationDegrees = transform.angle*180/Math.PI;
                } catch (optionalPlacementError) {
                    affinePlacement = null; rotationDegrees = 0; // retain the reliable face-only crop
                }
            }
            cropLeft = placement.left;
            cropTop = placement.top;
            cropRight = placement.right;
            cropBottom = placement.bottom;
            sourceCropWidth = cropRight - cropLeft;
            sourceCropHeight = cropBottom - cropTop;
            placementOffsetX = affinePlacement ? 0 : placement.offsetX;
            placementOffsetY = affinePlacement ? 0 : placement.offsetY;
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

        var combinedAffine = affinePlacement && (Math.abs(rotationDegrees)>0.0001 || faceScaleEnabled && faceScale!=1.0);
        if (combinedAffine) {
            gfpTransformLayer(faceScale, rotationDegrees,
                Number(payload.target.selection.left)+affinePlacement.centerX-(layerLeft+layerRight)*.5,
                Number(payload.target.selection.top)+affinePlacement.centerY-(layerTop+layerBottom)*.5);
        } else {
            if (faceScaleEnabled && faceScale != 1.0) {
                // Resize the extracted source before optional rotation.
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
                if (!affinePlacement && (layerWidth < expectedWidth || layerHeight < expectedHeight)) {
                    target.activeHistoryState = targetHistory;
                    targetHistory = null;
                    throw new Error("Photoshop округлил масштабированный слой меньше целевой области. Операция отменена.");
                }
            } else if (layerWidth != sourceCropWidth || layerHeight != sourceCropHeight) {
                target.activeHistoryState = targetHistory;
                targetHistory = null;
                throw new Error("Photoshop изменил размер вставленного слоя. Операция отменена: масштабирование выключено.");
            }

            if (affinePlacement) {
                layerBounds = insertedLayer.bounds;
                var centerX=(gfpPx(layerBounds[0])+gfpPx(layerBounds[2]))*.5;
                var centerY=(gfpPx(layerBounds[1])+gfpPx(layerBounds[3]))*.5;
                insertedLayer.translate(UnitValue(Number(payload.target.selection.left)+affinePlacement.centerX-centerX,"px"),
                    UnitValue(Number(payload.target.selection.top)+affinePlacement.centerY-centerY,"px"));
            } else {
                insertedLayer.translate(
                    UnitValue(Number(payload.target.selection.left) + placementOffsetX - layerLeft, "px"),
                    UnitValue(Number(payload.target.selection.top) + placementOffsetY - layerTop, "px")
                );
            }
        }
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

    GFP_SERVER_START_OK = false;
    GFP_SERVER_START_ERROR = "";
    GFP_SERVER_START_RESPONSE = null;
    GFP_SERVER_START_CANCELLED = false;
    GFP_LAST_SERVER_LAUNCHER = "";
    var host = String(GFP_API_HOST).toLowerCase();
    var saved = gfpLoadClientState();
    // A remote address must never start a server on the Photoshop computer.
    if (host == "127.0.0.1" || host == "localhost" || host == "::1") {
        var sameEndpoint = !saved.server_host ||
            (String(saved.server_host).toLowerCase() == host && Number(saved.server_port) == Number(GFP_API_PORT_SEND));
        var launcher = gfpFindServerLauncher(sameEndpoint ? saved : null);
        if (launcher) {
            GFP_LAST_SERVER_LAUNCHER = launcher.fsName;
            try {
                if (!launcher.execute()) {
                    GFP_SERVER_START_ERROR = "Не удалось запустить: " + launcher.fsName;
                    return null;
                }
            } catch (launchError) {
                GFP_SERVER_START_ERROR = gfpErrorText(launchError);
                return null;
            }
        }
    }
    try {
        app.doForcedProgress("Инициализация модели распознавания лиц", "gfpPollServerStartup();");
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
        if (!gfpUpdateNativeProgress(progress, 1000, (GFP_LAST_SERVER_LAUNCHER ? "Запуск Python-сервера..." : "Ожидание Python-сервера (запустите run_server.bat вручную)..."))) {
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
        preview_size: 184,
        cache_ttl_hours: 48,
        match_threshold: 0.28,
        compute_mode: "auto",
        scan_threads: 2,
        preview_threads: 2,
        analysis_quality: "balanced",
        group_boundary_search: false,
        face_scale_match: false,
        align_clothing: false,
        allow_rotation: false,
        collect_statistics: false,
        preview_sort: "filename",
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
    cfg.preview_size = Number(cfg.preview_size || 184);
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
    cfg.align_clothing = gfpBooleanValue(cfg.align_clothing, false);
    cfg.allow_rotation = gfpBooleanValue(cfg.allow_rotation, false);
    cfg.collect_statistics = gfpBooleanValue(cfg.collect_statistics, false);
    cfg.preview_sort = gfpTrimString(cfg.preview_sort || "filename").toLowerCase();
    if (cfg.preview_sort != "filename" && cfg.preview_sort != "similarity" && cfg.preview_sort != "attractiveness") {
        cfg.preview_sort = "filename";
    }
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
    var liveAvailable = false;
    try {
        var live = gfpApiRequestTo(oldHost, oldPort, { command: "get_settings" }, 3000);
        if (live && live.type == "answer" && live.message && live.message.settings) {
            liveAvailable = true;
            gfpRememberServerLauncherFromResponse(live);
            if (live.message.version && String(live.message.version) != GFP_VERSION) {
                throw new Error("Запущен Python-сервер версии " + String(live.message.version) + ", а JSX имеет версию " + GFP_VERSION + ". Перезапустите run_server.bat перед изменением настроек.");
            }
            var serverSettings = gfpNormalizeConfig(live.message.settings);
            // Statistics collection is a Photoshop-side opt-in shown only in
            // this Settings dialog. Preserve the local value while importing
            // the other live server settings; Save synchronizes it back.
            serverSettings.collect_statistics = localCurrent.collect_statistics === true;
            // face_scale_match is an operational Photoshop-side option shown in
            // the chooser, not a server setting. Preserve the client value.
            serverSettings.face_scale_match = localCurrent.face_scale_match === true;
            serverSettings.align_clothing = localCurrent.align_clothing === true;
            serverSettings.allow_rotation = localCurrent.allow_rotation === true;
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
    w.spacing = 6;
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
    serverPanel.margins = 8;
    serverPanel.spacing = 5;
    var edServerHost = addLabeledEdit(serverPanel, "Адрес сервера", String(current.server_host), 220);
    var edPort = addLabeledEdit(serverPanel, "Порт сервера", String(current.server_port), 100);
    var rememberedLauncher = gfpLoadClientState();
    edServerHost.helpTip = "Локально: 127.0.0.1. По сети — IP или имя компьютера сервера. Фотографии должны быть доступны серверу по тому же пути.\n" +
        (rememberedLauncher.server_launcher_path ?
            "Автозапуск: " + String(rememberedLauncher.server_launcher_path) :
            "Один раз запустите run_server.bat и JSX, чтобы сохранить путь автозапуска.");
    edPort.helpTip = "После изменения адреса или порта перезапустите сервер.";

    var performancePanel = w.add("panel", undefined, "Производительность распознавания");
    performancePanel.orientation = "column";
    performancePanel.alignChildren = ["fill", "top"];
    performancePanel.margins = 8;
    performancePanel.spacing = 5;

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

    dlQuality.helpTip = "Быстрый режим ускоряет детекцию, но может пропускать очень маленькие лица.";
    slThreads.helpTip = "Число одновременно анализируемых кадров. Пакетные вызовы распознавателя выполняются по одному.";
    slPreviewThreads.helpTip = "Число потоков подготовки PNG из сохранённых миниатюр лиц, от 1 до 8.";

    if (liveEngine && liveEngine.provider) {
        var engineStatus = performancePanel.add("statictext", undefined,
            "Сейчас: " + String(liveEngine.provider) + ", detector " + String(liveEngine.det_size || "?") + " px");
        engineStatus.preferredSize = [470, 20];
    }

    var cachePanel = w.add("panel", undefined, "Поиск");
    cachePanel.orientation = "column";
    cachePanel.alignChildren = ["fill", "top"];
    cachePanel.margins = 8;
    cachePanel.spacing = 5;
    var chGroupBoundarySearch = cachePanel.add("checkbox", undefined, "Поиск границ группы");
    chGroupBoundarySearch.value = current.group_boundary_search === true;
    chGroupBoundarySearch.helpTip = "Включено: анализ начинается от открытого кадра и останавливается после уверенной смены состава группы. Выключено: все поддерживаемые файлы папки считаются одной группой.";
    chGroupBoundarySearch.helpTip += " Если в папке только одна группа, отключение немного ускоряет первичный анализ.";
    var thresholdRow = cachePanel.add("group");
    thresholdRow.orientation = "row";
    thresholdRow.alignChildren = ["fill", "center"];
    var thresholdText = thresholdRow.add("statictext", undefined, "Порог совпадения лица");
    thresholdText.preferredSize = [230, 20];
    var slThreshold = thresholdRow.add("slider", undefined, Math.round(Number(current.match_threshold) * 100), 10, 60);
    slThreshold.preferredSize = [180, 20];
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


    var edCacheTtl = addLabeledEdit(performancePanel, "Срок жизни кэша анализа, часов", String(current.cache_ttl_hours), 80);

    var insertPanel = w.add("panel", undefined, "Рекомендации");
    insertPanel.orientation = "column";
    insertPanel.alignChildren = ["fill", "top"];
    insertPanel.margins = 8;
    insertPanel.spacing = 5;
    var recommendationRow = insertPanel.add("group");
    recommendationRow.orientation = "row";
    recommendationRow.alignChildren = ["left", "center"];
    var recommendationLabel = recommendationRow.add("statictext", undefined, "Рекомендация дубля");
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
    dlRecommendation.helpTip = "«ЛУЧШИЙ» — рекомендованный дубль. Публичная FBP оценивает удачность портрета, личная модель — ваши накопленные предпочтения.";
    var recommendationStatusText = "Публичная FBP: нужен install.bat. Личная модель: положите personal_preference.onnx в папку personal_model рядом с Python-сервером.";
    if (liveRecommendationBackends) {
        var publicState = liveRecommendationBackends.public || {};
        var personalState = liveRecommendationBackends.personal || {};
        recommendationStatusText = "Публичная FBP: " + (publicState.loaded ? "загружена" : (publicState.installed ? "установлена; загрузится при первом поиске" : "не установлена")) +
            "; личная модель: " + (personalState.loaded ? "загружена" : (personalState.installed ? "установлена; загрузится при первом поиске" : "не найдена"));
    }
    dlRecommendation.helpTip += "\n" + recommendationStatusText;

    var placementPanel = w.add("panel", undefined, "Совмещение при вставке");
    placementPanel.orientation = "column"; placementPanel.alignChildren = ["left", "top"]; placementPanel.margins = 8; placementPanel.spacing = 4;
    var chClothing = placementPanel.add("checkbox", undefined, "Уточнять по шее и одежде");
    chClothing.value = current.align_clothing === true;
    chClothing.helpTip = "Сопоставляет детали воротника и плеч выбранного дубля. При неуверенном совпадении используется лицо. Читает два кадра перед вставкой.";
    var chRotation = placementPanel.add("checkbox", undefined, "Разрешить небольшой поворот");
    chRotation.value = current.allow_rotation === true;
    chRotation.helpTip = "До 8° по одежде при уверенном совпадении, иначе до 5° по линии глаз. Если не хватает краёв исходного кадра, используется совмещение без поворота.";

    var chCollectStatistics = w.add("checkbox", undefined, "Собирать статистику для обучения");
    chCollectStatistics.value = current.collect_statistics === true;
    chCollectStatistics.helpTip = "После успешной вставки сохраняется базовая пара: выбранное лицо > текущее лицо. Если вы заменили автоматически предложенный кадр, обучатель дополнительно использует: выбранное лицо > отвергнутая рекомендация. Данные находятся в training_data рядом с Python-сервером.";

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
            preview_size: current.preview_size,
            cache_ttl_hours: Number(edCacheTtl.text),
            match_threshold: Number(slThreshold.value) / 100.0,
            compute_mode: selectedComputeMode,
            scan_threads: Number(slThreads.value),
            preview_threads: Number(slPreviewThreads.value),
            analysis_quality: selectedAnalysisQuality,
            group_boundary_search: chGroupBoundarySearch.value === true,
            face_scale_match: current.face_scale_match === true,
            align_clothing: chClothing.value === true,
            allow_rotation: chRotation.value === true,
            collect_statistics: chCollectStatistics.value === true,
            preview_sort: current.preview_sort,
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
    var serverAvailable = liveAvailable === true;
    var configForServer = gfpNormalizeConfig(resultConfig);
    // These are Photoshop-side options. Never send shadow copies into the
    // Python server config: their values travel only with the operation that
    // uses them.
    try { delete configForServer.face_scale_match; delete configForServer.align_clothing; delete configForServer.allow_rotation; } catch (_) {}
    try { delete configForServer.collect_statistics; } catch (_) {}
    // get_settings already proved that the current server is reachable. Avoid
    // an immediate second ping on every Settings save. Only re-probe if the
    // server was unavailable when this dialog opened (it may have started later).
    if (!serverAvailable) {
        try {
            var test = gfpApiRequestTo(oldHost, oldPort, { command: "ping" }, 2000);
            serverAvailable = !!(test && test.type == "answer");
        } catch (testError) {
            serverAvailable = false;
        }
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
                            rollbackConfig.face_scale_match = localCurrent.face_scale_match === true;
                            rollbackConfig.align_clothing = localCurrent.align_clothing === true;
                            rollbackConfig.allow_rotation = localCurrent.allow_rotation === true;
                            // collect_statistics is a Photoshop-side option and is
                            // absent from server settings. Preserve it explicitly
                            // during rollback, just like face_scale_match.
                            rollbackConfig.collect_statistics = localCurrent.collect_statistics === true;
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
        localAuthoritative.face_scale_match = resultConfig.face_scale_match === true;
        localAuthoritative.align_clothing = resultConfig.align_clothing === true;
        localAuthoritative.allow_rotation = resultConfig.allow_rotation === true;
        localAuthoritative.collect_statistics = resultConfig.collect_statistics === true;
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
    offlineConfig.align_clothing = resultConfig.align_clothing === true;
    offlineConfig.allow_rotation = resultConfig.allow_rotation === true;
    gfpSaveConfig(offlineConfig);
    gfpApplyConfig(offlineConfig);
    alert("Python-сервер сейчас недоступен. Сохранены адрес/порт подключения Photoshop, параметры совмещения и галочка сбора статистики.\n\nОстальные параметры не изменены: откройте настройки после восстановления соединения и сохраните их на работающем сервере.", GFP_NAME, true);
    return true;
}

function gfpSameConfigValues(a, b) {
    var left = gfpNormalizeConfig(a);
    var right = gfpNormalizeConfig(b);
    var keys = ["server_host", "server_port", "preview_size", "cache_ttl_hours", "match_threshold", "compute_mode", "scan_threads", "preview_threads", "analysis_quality", "group_boundary_search", "recommendation_model", "preview_sort"];
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
            gfpCancelServerJob(GFP_PENDING_SETTINGS_JOB_ID, GFP_SETTINGS_APPLY_HOST, GFP_SETTINGS_APPLY_PORT);
            return false;
        }
        var response = gfpApiRequestTo(GFP_SETTINGS_APPLY_HOST, GFP_SETTINGS_APPLY_PORT,
            { command: "job_status", job_id: GFP_PENDING_SETTINGS_JOB_ID }, 1500);
        if (!response) {
            consecutiveNetworkFailures++;
            if (consecutiveNetworkFailures >= 2) {
                GFP_PENDING_SETTINGS_ERROR = "Python-сервер дважды подряд не ответил при применении настроек.";
                gfpCancelServerJob(GFP_PENDING_SETTINGS_JOB_ID, GFP_SETTINGS_APPLY_HOST, GFP_SETTINGS_APPLY_PORT);
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
        if (status.status == "done") {
            // The server transaction has already committed. Esc at this exact
            // instant cannot truthfully undo it, so keep the authoritative
            // result and synchronize the client instead of reporting a false
            // cancellation. One poll still causes only one progress update.
            GFP_PENDING_SETTINGS_RESULT = status.result;
            gfpUpdateNativeProgress(1000, 1000, "Настройки применены.");
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
        var progress = Math.max(0, Math.min(1, Number(status.progress) || 0));
        if (!gfpUpdateNativeProgress(Math.round(progress * 1000), 1000, String(status.text || "Применение настроек..."))) {
            GFP_PENDING_SETTINGS_CANCELLED = true;
            gfpCancelServerJob(GFP_PENDING_SETTINGS_JOB_ID, GFP_SETTINGS_APPLY_HOST, GFP_SETTINGS_APPLY_PORT);
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
