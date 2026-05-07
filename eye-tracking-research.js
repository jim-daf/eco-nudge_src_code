/**
 * Eye-Tracking Research Module
 * 
 * Provides:
 * - 9-point gaze calibration with validation
 * - Raw gaze data collection (x, y, timestamp, pupil diameter)
 * - Fixation detection (I-DT algorithm)
 * - Research metrics: TTFF, fixation duration, fixation count, saccades
 * - Areas of Interest (AOI) analysis
 * - Real-time heatmap overlay
 * - CSV raw data export
 * - Session video recording (screen + webcam)
 * - Research dashboard UI
 */
const EyeTrackingResearch = (() => {
    // ===== Server Configuration =====
    // Empty string = same origin (works for both local dev and production)
    // For local dev: run server with 'node server/server.js' and open http://localhost:3000
    const SERVER_URL = '';

    // ===== Configuration =====
    const CONFIG = {
        // Fixation detection (I-DT: Identification by Dispersion Threshold)
        fixationDispersionThreshold: 50,   // pixels — max spread to count as fixation
        fixationDurationThreshold: 100,    // ms — minimum duration for a fixation
        // Sampling
        gazeBufferSize: 100000,            // max raw samples stored in memory
        // Heatmap
        heatmapRadius: 30,
        heatmapMaxOpacity: 0.7,
        // Calibration
        calibrationPointDwell: 2000,       // ms per calibration point
        calibrationPoints: 9,             // 5, 9, 13, or 16
        calibrationClicksPerPoint: 5,     // clicks required per point
        calibrationRounds: 1,             // how many passes through all points
        calibrationDwellTime: 800,        // ms user must look at dot before click counts
        validationThreshold: 100,          // px — max acceptable validation error
        // Gaze smoothing
        gazeSmoothingAlpha: 0.3,           // EMA factor (0=max smooth, 1=no smooth)
        gazeOutlierThreshold: 300,         // px — jump beyond this from average is rejected
    };

    // ===== State =====
    let state = {
        isTracking: false,
        isCalibrated: false,
        isRecording: false,
        sessionId: null,
        sessionStartTime: null,
        participantId: '',

        // Raw gaze data
        gazeData: [],
        // Fixations (computed)
        fixations: [],
        // Saccades (computed)
        saccades: [],
        // Current fixation buffer
        currentFixationBuffer: [],

        // AOIs
        aois: [],

        // Calibration
        calibrationAccuracy: null,
        calibrationPoints: [],

        // Video recording
        mediaRecorder: null,
        webcamRecorder: null,
        recordedChunks: [],
        webcamRecordedChunks: [],
        webcamStream: null,
        screenStream: null,

        // Heatmap
        heatmapCanvas: null,
        heatmapCtx: null,
        heatmapVisible: false,

        // Gaze dot
        gazeDotVisible: true,
        // Smoothing state
        smoothX: null,
        smoothY: null,

        // Local artifact cache — every generated file (CSV/JSON/PNG/webm) is
        // stashed here BEFORE upload, so the user can save them locally even
        // if the Azure upload fails. Cleared at the start of each tracking run.
        localArtifacts: [],
    };

    // ===== Local Artifact Cache =====
    function cacheArtifact(filename, blob) {
        if (!filename || !blob) return;
        // Replace existing entry with same filename (e.g. re-export)
        const idx = state.localArtifacts.findIndex(a => a.filename === filename);
        const entry = { filename, blob, size: blob.size, addedAt: Date.now() };
        if (idx >= 0) state.localArtifacts[idx] = entry;
        else state.localArtifacts.push(entry);
        updateLocalArtifactCount();
    }

    function saveBlobLocally(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoke after a short delay to let the download start
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function downloadAllArtifactsLocally() {
        if (state.localArtifacts.length === 0) {
            showNotification('No data cached yet. Track a session first.', 'warning');
            return;
        }
        showNotification(`Saving ${state.localArtifacts.length} file(s) locally...`, 'info');
        for (const a of state.localArtifacts) {
            saveBlobLocally(a.blob, a.filename);
            // Small delay between downloads so the browser doesn't block them
            await new Promise(r => setTimeout(r, 200));
        }
        showNotification(`Saved ${state.localArtifacts.length} file(s) to your downloads folder.`, 'success');
    }

    function updateLocalArtifactCount() {
        const el = document.getElementById('etLocalArtifactCount');
        if (el) el.textContent = state.localArtifacts.length;
    }

    // ===== Initialization =====
    function init() {
        state.sessionId = generateSessionId();
        createResearchUI();
        createHeatmapCanvas();
        createGazeDot();
        setupAOIs();
        console.log('[EyeTracking] Research module initialized. Session:', state.sessionId);
    }

    function generateSessionId() {
        const now = new Date();
        return 'ET_' + now.toISOString().replace(/[-:T.]/g, '').slice(0, 14) +
            '_' + Math.random().toString(36).slice(2, 6);
    }

    // ===== Helper =====
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ===== Calibration =====
    function startCalibration() {
        state.isCalibrated = false;
        state.calibrationPoints = [];
        state.calibrationAccuracy = null;

        // Start webgazer before calibration
        if (typeof webgazer === 'undefined') {
            showNotification('WebGazer.js not loaded!', 'error');
            return;
        }

        const totalSteps = CONFIG.calibrationPoints * CONFIG.calibrationRounds;
        const overlay = document.createElement('div');
        overlay.id = 'calibrationOverlay';
        overlay.className = 'et-calibration-overlay';
        overlay.innerHTML = `
            <div class="et-calibration-content">
                <h2>Gaze Calibration</h2>
                <p id="calInstruction">
                    Wait for the dot to turn <b style="color:#22c55e">green</b> (dwell), then click it ${CONFIG.calibrationClicksPerPoint} times.<br>
                    ${CONFIG.calibrationRounds > 1 ? `<small>${CONFIG.calibrationRounds} rounds \u00d7 ${CONFIG.calibrationPoints} points = ${totalSteps} total steps</small>` : ''}
                </p>
                <p class="et-cal-progress">Step <span id="calPointNum">0</span> / <span id="calTotalPoints">${totalSteps}</span></p>
                <div id="calDot" class="et-cal-dot" style="display:none;"></div>
                <button id="calStartBtn" class="et-btn et-btn-primary">Begin Calibration</button>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('calStartBtn').addEventListener('click', () => {
            document.getElementById('calStartBtn').style.display = 'none';
            document.querySelector('.et-calibration-content h2').style.display = 'none';
            document.querySelector('.et-calibration-content p').style.display = 'none';
            initWebGazerThenCalibrate(overlay);
        });
    }

    function getCalibrationPositions() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const margin = 60;
        const numPoints = CONFIG.calibrationPoints;

        // Extra edge points for top (navbar ~30px) and bottom (~h-30px) accuracy
        const edgeExtra = [
            { x: w * 0.5, y: 30 },
            { x: w * 0.5, y: h - 30 },
        ];

        if (numPoints <= 5) {
            return [
                ...edgeExtra,
                { x: margin, y: margin },
                { x: w - margin, y: margin },
                { x: w / 2, y: h / 2 },
                { x: margin, y: h - margin },
                { x: w - margin, y: h - margin },
            ];
        }
        if (numPoints <= 9) {
            return [
                ...edgeExtra,
                { x: margin, y: margin },           { x: w / 2, y: margin },           { x: w - margin, y: margin },
                { x: margin, y: h / 2 },            { x: w / 2, y: h / 2 },            { x: w - margin, y: h / 2 },
                { x: margin, y: h - margin },        { x: w / 2, y: h - margin },        { x: w - margin, y: h - margin },
            ];
        }
        if (numPoints <= 13) {
            return [
                ...edgeExtra,
                { x: margin, y: margin },           { x: w / 2, y: margin },           { x: w - margin, y: margin },
                { x: w * 0.25, y: h * 0.15 },                                           { x: w * 0.75, y: h * 0.15 },
                { x: margin, y: h / 2 },            { x: w / 2, y: h / 2 },            { x: w - margin, y: h / 2 },
                { x: w * 0.25, y: h * 0.75 },                                           { x: w * 0.75, y: h * 0.75 },
                { x: w * 0.25, y: h * 0.85 },                                           { x: w * 0.75, y: h * 0.85 },
                { x: margin, y: h - margin },        { x: w / 2, y: h - margin },        { x: w - margin, y: h - margin },
            ];
        }
        // 16-point 4×4 + edge = 18
        const cols = [margin, w * 0.33, w * 0.67, w - margin];
        const rows = [margin, h * 0.33, h * 0.67, h - margin];
        const pts = [...edgeExtra];
        for (const y of rows) {
            for (const x of cols) {
                pts.push({ x: Math.round(x), y: Math.round(y) });
            }
        }
        return pts;
    }

    async function initWebGazerThenCalibrate(overlay) {
        const instruction = document.getElementById('calInstruction');
        const progressEl = document.querySelector('.et-cal-progress');
        if (progressEl) progressEl.style.display = 'none';

        if (instruction) {
            instruction.style.display = 'block';
            instruction.textContent = 'Starting camera & loading face model...';
        }

        // Fix: Point MediaPipe FaceMesh to CDN (local ./mediapipe/face_mesh/ files don't exist)
        webgazer.params.faceMeshSolutionPath = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/';

        // Accuracy: Request higher camera resolution for better face landmark detection
        // Using 'ideal' not 'exact' so browsers gracefully fall back if unsupported
        webgazer.params.camConstraints = {
            video: {
                width: { min: 320, ideal: 1280, max: 1920 },
                height: { min: 240, ideal: 720, max: 1080 },
                facingMode: 'user'
            }
        };

        // Keep storingPoints off — it stores mouse move positions which corrupt the gaze model
        webgazer.params.storingPoints = false;

        // Step 1: Start WebGazer
        try {
            await webgazer.clearData();
        } catch (e) { /* ignore */ }

        try {
            await webgazer
                .setRegression('ridge')
                .setGazeListener(() => {})
                .begin();
            console.log('[EyeTracking] WebGazer begin() succeeded');
        } catch (e) {
            console.warn('WebGazer begin() error (may already be running):', e);
        }

        webgazer.showPredictionPoints(false);
        webgazer.showVideoPreview(false);

        // Step 2: Wait until face tracker detects a face
        // Note: getCurrentPrediction() needs training data (returns null before calibration),
        // so we check getTracker().getPositions() which returns face landmarks directly.
        if (instruction) {
            instruction.textContent = 'Waiting for face detection... Position your face in front of the camera.';
        }

        let faceReady = false;
        const maxWait = 30000; // 30s timeout
        const start = Date.now();

        while (!faceReady && (Date.now() - start) < maxWait) {
            try {
                const tracker = webgazer.getTracker();
                const positions = tracker ? tracker.getPositions() : null;
                if (positions && positions.length > 0) {
                    faceReady = true;
                    console.log('Face detected — tracker has', positions.length, 'landmarks.');
                }
            } catch (e) { /* still loading */ }
            if (!faceReady) await sleep(300);
        }

        if (!faceReady) {
            if (instruction) {
                instruction.textContent = '⚠️ Could not detect face. Check camera permissions and lighting, then try again.';
            }
            const retryBtn = document.createElement('button');
            retryBtn.className = 'et-btn et-btn-primary';
            retryBtn.textContent = 'Retry';
            retryBtn.style.marginTop = '20px';
            retryBtn.onclick = () => { overlay.remove(); startCalibration(); };
            instruction.parentElement.appendChild(retryBtn);
            return;
        }

        // Step 3: Clear data again now that face model is ready, so clicks register properly
        try {
            await webgazer.clearData();
        } catch (e) { /* ignore */ }

        if (instruction) {
            instruction.textContent = '✅ Face detected! Starting calibration...';
        }
        if (progressEl) progressEl.style.display = 'block';
        await sleep(1000);

        beginCalibrationSequence(overlay);
    }

    function beginCalibrationSequence(overlay) {
        const basePositions = getCalibrationPositions();
        const dot = document.getElementById('calDot');
        const pointNum = document.getElementById('calPointNum');
        const instruction = document.getElementById('calInstruction');
        if (instruction) instruction.style.display = 'none';
        dot.style.display = 'block';

        const clicksPerPoint = CONFIG.calibrationClicksPerPoint;
        const rounds = CONFIG.calibrationRounds;
        const dwellTime = CONFIG.calibrationDwellTime;

        // Build the full sequence: all positions × number of rounds (shuffled per round)
        const allPoints = [];
        for (let r = 0; r < rounds; r++) {
            const shuffled = [...basePositions];
            // Fisher-Yates shuffle for round > 0 so second pass uses different order
            if (r > 0) {
                for (let i = shuffled.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                }
            }
            shuffled.forEach((pos, idx) => allPoints.push({ ...pos, round: r + 1, origIndex: idx }));
        }

        const totalSteps = allPoints.length;
        const totalPointsEl = document.getElementById('calTotalPoints');
        if (totalPointsEl) totalPointsEl.textContent = totalSteps;

        let stepIndex = 0;

        function showNextPoint() {
            if (stepIndex >= allPoints.length) {
                finishCalibration(overlay);
                return;
            }
            const pos = allPoints[stepIndex];
            dot.style.left = pos.x + 'px';
            dot.style.top = pos.y + 'px';
            pointNum.textContent = stepIndex + 1;

            // Reset dot to full size with shrink animation (dwell indicator)
            dot.className = 'et-cal-dot et-cal-dot-pulse';
            dot.style.setProperty('--dwell-time', dwellTime + 'ms');

            let clickCount = 0;
            let dwellReady = false;

            // Start dwell timer — dot shrinks, click only counts after dwell completes
            dot.classList.add('et-cal-dot-dwell');
            const dwellTimer = setTimeout(() => {
                dwellReady = true;
                dot.classList.remove('et-cal-dot-dwell');
                dot.classList.add('et-cal-dot-ready');
            }, dwellTime);

            dot.onclick = () => {
                if (!dwellReady) return; // ignore clicks before dwell completes

                clickCount++;
                webgazer.recordScreenPosition(pos.x, pos.y, 'click');

                if (clickCount < clicksPerPoint) {
                    // Flash feedback
                    dot.className = 'et-cal-dot et-cal-dot-clicked';
                    setTimeout(() => {
                        dot.className = 'et-cal-dot et-cal-dot-ready';
                    }, 120);
                } else {
                    // Done with this point
                    state.calibrationPoints.push({
                        index: stepIndex,
                        round: pos.round,
                        x: pos.x,
                        y: pos.y,
                        clicks: clicksPerPoint,
                        timestamp: Date.now()
                    });
                    dot.className = 'et-cal-dot et-cal-dot-clicked';
                    stepIndex++;
                    setTimeout(showNextPoint, 350);
                }
            };
        }
        showNextPoint();
    }

    async function finishCalibration(overlay) {
        // Run a quick validation pass
        const dot = document.getElementById('calDot');
        dot.style.display = 'none';
        const instruction = document.getElementById('calInstruction');
        if (instruction) {
            instruction.style.display = 'block';
            instruction.textContent = 'Validating accuracy... Look at the green dot.';
        }

        const valPositions = [
            // Top edge (navbar zone)
            { x: window.innerWidth * 0.25, y: 30 },
            { x: window.innerWidth * 0.5,  y: 30 },
            { x: window.innerWidth * 0.75, y: 30 },
            // Upper quarter
            { x: window.innerWidth * 0.25, y: window.innerHeight * 0.15 },
            { x: window.innerWidth * 0.75, y: window.innerHeight * 0.15 },
            // Middle
            { x: window.innerWidth * 0.5,  y: window.innerHeight * 0.5 },
            // Lower quarter
            { x: window.innerWidth * 0.25, y: window.innerHeight * 0.85 },
            { x: window.innerWidth * 0.75, y: window.innerHeight * 0.85 },
            // Bottom edge
            { x: window.innerWidth * 0.25, y: window.innerHeight - 30 },
            { x: window.innerWidth * 0.5,  y: window.innerHeight - 30 },
            { x: window.innerWidth * 0.75, y: window.innerHeight - 30 },
        ];

        const valDot = document.createElement('div');
        valDot.className = 'et-val-dot';
        overlay.appendChild(valDot);

        const errors = [];
        let totalPredictions = 0;

        for (const pos of valPositions) {
            valDot.style.left = pos.x + 'px';
            valDot.style.top = pos.y + 'px';
            valDot.style.display = 'block';

            await sleep(800); // settle time
            const predictions = [];
            const pollEnd = Date.now() + 1500;

            while (Date.now() < pollEnd) {
                try {
                    const pred = webgazer.getCurrentPrediction();
                    const result = (pred && typeof pred.then === 'function') ? await pred : pred;
                    if (result && result.x != null && result.y != null
                        && isFinite(result.x) && isFinite(result.y)) {
                        predictions.push({ x: result.x, y: result.y });
                    }
                } catch (e) { /* skip */ }
                await sleep(50);
            }

            totalPredictions += predictions.length;
            console.log(`Validation point (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}): ${predictions.length} predictions`);

            if (predictions.length > 0) {
                const avgX = predictions.reduce((s, p) => s + p.x, 0) / predictions.length;
                const avgY = predictions.reduce((s, p) => s + p.y, 0) / predictions.length;
                const error = Math.sqrt((avgX - pos.x) ** 2 + (avgY - pos.y) ** 2);
                errors.push(error);
            }
        }

        valDot.style.display = 'none';
        console.log(`Validation complete: ${errors.length}/${valPositions.length} points, ${totalPredictions} total predictions`);
        finishValidation(overlay, errors);
    }

    function finishValidation(overlay, errors) {
        let avgError, resultHTML;

        if (errors.length > 0) {
            avgError = errors.reduce((a, b) => a + b, 0) / errors.length;
            state.calibrationAccuracy = avgError;
            resultHTML = `
                <div class="et-cal-result ${avgError < CONFIG.validationThreshold ? 'et-cal-good' : 'et-cal-poor'}">
                    <p>Average accuracy: <strong>${avgError.toFixed(1)} px</strong></p>
                    <p>${avgError < CONFIG.validationThreshold ? '✅ Good accuracy — ready to track!' : '⚠️ Consider recalibrating for better results.'}</p>
                </div>`;
        } else {
            avgError = null;
            state.calibrationAccuracy = null;
            resultHTML = `
                <div class="et-cal-result et-cal-poor">
                    <p>Could not measure accuracy (no gaze predictions received).</p>
                    <p>⚠️ Ensure your face is visible to the camera. You can still proceed or recalibrate.</p>
                </div>`;
        }
        state.isCalibrated = true;

        overlay.innerHTML = `
            <div class="et-calibration-content">
                <h2>Calibration Complete</h2>
                ${resultHTML}
                <div class="et-cal-actions">
                    <button id="calAcceptBtn" class="et-btn et-btn-primary">Accept & Start Tracking</button>
                    <button id="calRedoBtn" class="et-btn et-btn-secondary">Recalibrate</button>
                </div>
            </div>
        `;

        document.getElementById('calAcceptBtn').addEventListener('click', () => {
            overlay.remove();
            updateDashboardStatus();
            showNotification('Calibration accepted. Ready to track!', 'success');
        });
        document.getElementById('calRedoBtn').addEventListener('click', () => {
            overlay.remove();
            startCalibration();
        });
    }

    // ===== Pupil Diameter Estimation =====
    // Estimates pupil diameter (in webcam pixels) from a WebGazer eye-patch ImageData
    // by detecting the dark blob (pupil) in the patch and computing its equivalent-circle
    // diameter. Returns the mean of the two eyes, or null if patches aren't available.
    // Smoothed with an exponential moving average to reduce frame-to-frame noise.
    let _pupilEMA = null;
    const _PUPIL_EMA_ALPHA = 0.35;          // smoothing factor (0=heavy smooth, 1=raw)
    const _PUPIL_DARK_PERCENTILE = 0.12;    // bottom 12% darkest pixels treated as pupil
    const _PUPIL_MIN_PIXELS = 6;            // ignore noise blobs smaller than this

    function estimatePupilDiameter(eyeFeatures) {
        if (!eyeFeatures) return null;
        const left = _measurePupilInPatch(eyeFeatures.left);
        const right = _measurePupilInPatch(eyeFeatures.right);
        let raw;
        if (left != null && right != null) raw = (left + right) / 2;
        else if (left != null) raw = left;
        else if (right != null) raw = right;
        else return null;

        // EMA smoothing
        _pupilEMA = (_pupilEMA == null)
            ? raw
            : _PUPIL_EMA_ALPHA * raw + (1 - _PUPIL_EMA_ALPHA) * _pupilEMA;
        return parseFloat(_pupilEMA.toFixed(2));
    }

    function _measurePupilInPatch(eye) {
        if (!eye || !eye.patch || !eye.patch.data) return null;
        const w = eye.width || eye.patch.width;
        const h = eye.height || eye.patch.height;
        const data = eye.patch.data;
        if (!w || !h || data.length < 4) return null;

        // Convert to luminance and find a dark threshold via histogram percentile.
        const total = w * h;
        const lum = new Uint8ClampedArray(total);
        const hist = new Uint32Array(256);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
            // Rec. 601 luma
            const y = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
            lum[p] = y;
            hist[y]++;
        }
        const cutoff = Math.max(_PUPIL_MIN_PIXELS, Math.floor(total * _PUPIL_DARK_PERCENTILE));
        let acc = 0, threshold = 0;
        for (let v = 0; v < 256; v++) {
            acc += hist[v];
            if (acc >= cutoff) { threshold = v; break; }
        }

        // Count "dark" pixels and accumulate centroid for sanity check.
        let darkCount = 0, sx = 0, sy = 0;
        for (let yy = 0; yy < h; yy++) {
            const row = yy * w;
            for (let xx = 0; xx < w; xx++) {
                if (lum[row + xx] <= threshold) {
                    darkCount++;
                    sx += xx;
                    sy += yy;
                }
            }
        }
        if (darkCount < _PUPIL_MIN_PIXELS) return null;

        // Equivalent-circle diameter from the dark-pixel area: A = π r² → d = 2√(A/π)
        const diameter = 2 * Math.sqrt(darkCount / Math.PI);

        // Reject implausible measurements (pupil shouldn't span more than the eye patch).
        const maxPlausible = Math.min(w, h);
        if (diameter <= 0 || diameter > maxPlausible) return null;

        return diameter;
    }

    // ===== Gaze Tracking =====
    function startTracking() {
        if (!state.isCalibrated) {
            showNotification('Please calibrate first!', 'warning');
            return;
        }

        state.isTracking = true;
        state.sessionStartTime = Date.now();
        state.gazeData = [];
        state.fixations = [];
        state.saccades = [];
        state.currentFixationBuffer = [];
        // Reset local artifact cache for the new session
        state.localArtifacts = [];
        updateLocalArtifactCount();
        // Reset smoothing state for fresh tracking
        state.smoothX = null;
        state.smoothY = null;
        // Reset pupil-diameter EMA so prior session values don't bias this one
        _pupilEMA = null;

        let _gazeDebugCount = 0;
        webgazer.setGazeListener((data, elapsedTime) => {
            // Debug: log regardless of state
            if (_gazeDebugCount < 10) {
                console.log('[GazeDebug]', _gazeDebugCount,
                    'isTracking:', state.isTracking,
                    'data:', data ? {x: data.x, y: data.y, typeofX: typeof data.x} : 'NULL',
                    'dotVisible:', state.gazeDotVisible,
                    'dotExists:', !!document.getElementById('gazeDot'));
                _gazeDebugCount++;
            }
            if (!data || !state.isTracking) return;
            if (data.x == null || data.y == null || !isFinite(data.x) || !isFinite(data.y)) return;
            // Compute pupil diameter from WebGazer eye patches (px, in webcam coords).
            // WebGazer's prediction includes data.eyeFeatures = {left, right} with ImageData patches.
            const pupilD = estimatePupilDiameter(data.eyeFeatures);
            const sample = {
                timestamp: Date.now(),
                elapsedMs: elapsedTime,
                x: Math.round(data.x),
                y: Math.round(data.y),
                pupilD: pupilD, // estimated pupil diameter in pixels (mean of both eyes)
                viewWidth: window.innerWidth,
                viewHeight: window.innerHeight,
                scrollX: window.scrollX,
                scrollY: window.scrollY,
                currentView: getCurrentView(),
            };

            if (state.gazeData.length < CONFIG.gazeBufferSize) {
                state.gazeData.push(sample);
            }

            // Live fixation detection
            processFixation(sample);

            // Update gaze dot
            if (state.gazeDotVisible) {
                moveGazeDot(data.x, data.y);
            }

            // Live heatmap accumulation
            if (state.heatmapVisible) {
                addHeatmapPoint(data.x, data.y);
            }
        });

        webgazer.showPredictionPoints(false);
        updateDashboardStatus();
        showNotification('Eye tracking started!', 'success');
    }

    function stopTracking() {
        state.isTracking = false;
        // Finalize any pending fixation
        if (state.currentFixationBuffer.length > 0) {
            finalizeFixation(state.currentFixationBuffer);
            state.currentFixationBuffer = [];
        }
        computeSaccades();
        computeAOIMetrics();
        updateDashboardStatus();
        updateMetricsDisplay();
        showNotification('Tracking stopped. Uploading all data...', 'info');
        uploadAllData();
    }

    async function uploadAllData() {
        const uploads = [];

        // CSVs
        if (state.gazeData.length > 0) {
            uploads.push(() => exportRawCSV());
            uploads.push(() => exportFixationsCSV());
            uploads.push(() => exportSessionSummaryCSV());
        }
        if (state.saccades.length > 0) {
            uploads.push(() => exportSaccadesCSV());
        }
        if (state.aoiMetrics) {
            uploads.push(() => exportAOIMetricsCSV());
        }

        // Full session JSON
        uploads.push(() => exportFullJSON());

        // Heatmap
        if (state.gazeData.length > 0) {
            uploads.push(() => downloadHeatmapImage());
        }

        for (const fn of uploads) {
            try { await fn(); } catch (e) {
                console.error('[EyeTracking] Auto-upload error:', e);
            }
        }
    }

    function getCurrentView() {
        const views = document.querySelectorAll('.view.active');
        if (views.length > 0) return views[0].id.replace('view-', '');
        return 'unknown';
    }

    // ===== Fixation Detection (I-DT Algorithm) =====
    function processFixation(sample) {
        state.currentFixationBuffer.push(sample);

        // Calculate dispersion of buffer
        const xs = state.currentFixationBuffer.map(s => s.x);
        const ys = state.currentFixationBuffer.map(s => s.y);
        const dispersion = (Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys));

        if (dispersion > CONFIG.fixationDispersionThreshold) {
            // Dispersion threshold exceeded
            if (state.currentFixationBuffer.length > 1) {
                // Check if the buffer (minus last point) qualifies as fixation
                const fixBuf = state.currentFixationBuffer.slice(0, -1);
                const duration = fixBuf[fixBuf.length - 1].timestamp - fixBuf[0].timestamp;
                if (duration >= CONFIG.fixationDurationThreshold) {
                    finalizeFixation(fixBuf);
                }
            }
            // Start new buffer from last point
            state.currentFixationBuffer = [sample];
        }
    }

    function finalizeFixation(buffer) {
        if (buffer.length === 0) return;
        const xs = buffer.map(s => s.x);
        const ys = buffer.map(s => s.y);
        const fixation = {
            id: state.fixations.length + 1,
            startTime: buffer[0].timestamp,
            endTime: buffer[buffer.length - 1].timestamp,
            duration: buffer[buffer.length - 1].timestamp - buffer[0].timestamp,
            centroidX: parseFloat((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)),
            centroidY: parseFloat((ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(1)),
            sampleCount: buffer.length,
            dispersion: (Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys)),
            view: buffer[0].currentView,
            avgPupilD: buffer.filter(s => s.pupilD).length > 0
                ? buffer.filter(s => s.pupilD).reduce((acc, s) => acc + s.pupilD, 0) / buffer.filter(s => s.pupilD).length
                : null,
        };
        state.fixations.push(fixation);
    }

    // ===== Saccade Detection =====
    function computeSaccades() {
        state.saccades = [];
        for (let i = 1; i < state.fixations.length; i++) {
            const prev = state.fixations[i - 1];
            const curr = state.fixations[i];
            const distance = Math.sqrt((curr.centroidX - prev.centroidX) ** 2 + (curr.centroidY - prev.centroidY) ** 2);
            const duration = curr.startTime - prev.endTime;
            const dirRad = Math.atan2(curr.centroidY - prev.centroidY, curr.centroidX - prev.centroidX);
            const dirDeg = ((dirRad * 180 / Math.PI) % 360 + 360) % 360; // normalize 0-360
            state.saccades.push({
                id: i,
                fromFixation: prev.id,
                toFixation: curr.id,
                startTime: prev.endTime,
                endTime: curr.startTime,
                duration: duration,
                distance: parseFloat(distance.toFixed(1)),
                velocity: duration > 0 ? parseFloat((distance / duration * 1000).toFixed(1)) : 0, // px/sec
                direction: parseFloat(dirDeg.toFixed(1)),
            });
        }
    }

    // ===== Areas of Interest (AOI) =====
    function setupAOIs() {
        // Define AOIs based on major UI sections
        state.aois = [
            { id: 'nav', label: 'Top Navigation', selector: '.top-nav' },
            { id: 'recipe-grid', label: 'Recipe Grid', selector: '.recipe-grid' },
            { id: 'recipe-input', label: 'Custom Recipe Input', selector: '.custom-recipe-card' },
            { id: 'carbon-score', label: 'Carbon Score Card', selector: '.carbon-score-card' },
            { id: 'ingredient-list', label: 'Ingredient List', selector: '.ingredient-list' },
            { id: 'suggestions', label: 'Eco Suggestions Panel', selector: '.negotiation-panel' },
            { id: 'chat-area', label: 'Chat Area', selector: '.chat-container' },
            { id: 'impact-stats', label: 'Impact Statistics', selector: '.impact-stats-grid' },
            { id: 'settings', label: 'Settings', selector: '#view-settings' },
        ];
    }

    function getAOIBounds(aoi) {
        const el = document.querySelector(aoi.selector);
        if (!el || el.offsetParent === null) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    }

    function isPointInAOI(x, y, bounds) {
        if (!bounds) return false;
        return x >= bounds.x && x <= bounds.x + bounds.w && y >= bounds.y && y <= bounds.y + bounds.h;
    }

    function computeAOIMetrics() {
        // Compute per-AOI metrics from fixations
        const aoiMetrics = {};
        state.aois.forEach(aoi => {
            aoiMetrics[aoi.id] = {
                label: aoi.label,
                fixationCount: 0,
                totalDwellTime: 0,
                ttff: null, // Time to first fixation
                fixations: [],
            };
        });

        const sessionStart = state.sessionStartTime || (state.gazeData.length > 0 ? state.gazeData[0].timestamp : 0);

        state.fixations.forEach(fix => {
            state.aois.forEach(aoi => {
                const bounds = getAOIBounds(aoi);
                if (bounds && isPointInAOI(fix.centroidX, fix.centroidY, bounds)) {
                    const m = aoiMetrics[aoi.id];
                    m.fixationCount++;
                    m.totalDwellTime += fix.duration;
                    m.fixations.push(fix);
                    if (m.ttff === null) {
                        m.ttff = fix.startTime - sessionStart;
                    }
                }
            });
        });

        state.aoiMetrics = aoiMetrics;
        return aoiMetrics;
    }

    // ===== Heatmap =====
    function createHeatmapCanvas() {
        const canvas = document.createElement('canvas');
        canvas.id = 'gazeHeatmap';
        canvas.className = 'et-heatmap-canvas';
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        canvas.style.display = 'none';
        document.body.appendChild(canvas);
        state.heatmapCanvas = canvas;
        state.heatmapCtx = canvas.getContext('2d');

        window.addEventListener('resize', () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        });
    }

    function addHeatmapPoint(x, y) {
        const ctx = state.heatmapCtx;
        if (!ctx) return;
        const radius = CONFIG.heatmapRadius;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(255, 0, 0, 0.05)');
        gradient.addColorStop(1, 'rgba(255, 0, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    }

    function renderHeatmapFromData() {
        const canvas = state.heatmapCanvas;
        const ctx = state.heatmapCtx;
        if (!ctx) return;

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        // Create intensity map
        const intensityCanvas = document.createElement('canvas');
        intensityCanvas.width = canvas.width;
        intensityCanvas.height = canvas.height;
        const ictx = intensityCanvas.getContext('2d');

        state.gazeData.forEach(point => {
            const radius = CONFIG.heatmapRadius;
            const gradient = ictx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
            gradient.addColorStop(0, 'rgba(0, 0, 0, 0.03)');
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ictx.fillStyle = gradient;
            ictx.beginPath();
            ictx.arc(point.x, point.y, radius, 0, Math.PI * 2);
            ictx.fill();
        });

        // Colorize the intensity map
        const imageData = ictx.getImageData(0, 0, intensityCanvas.width, intensityCanvas.height);
        const pixels = imageData.data;
        for (let i = 0; i < pixels.length; i += 4) {
            const intensity = pixels[i + 3]; // alpha channel = intensity
            if (intensity > 0) {
                const color = intensityToColor(intensity / 255);
                pixels[i] = color.r;
                pixels[i + 1] = color.g;
                pixels[i + 2] = color.b;
                pixels[i + 3] = Math.min(255, intensity * 2) * CONFIG.heatmapMaxOpacity;
            }
        }
        ctx.putImageData(imageData, 0, 0);
    }

    function intensityToColor(value) {
        // Blue -> Cyan -> Green -> Yellow -> Red
        let r, g, b;
        if (value < 0.25) {
            r = 0; g = Math.round(255 * (value / 0.25)); b = 255;
        } else if (value < 0.5) {
            r = 0; g = 255; b = Math.round(255 * (1 - (value - 0.25) / 0.25));
        } else if (value < 0.75) {
            r = Math.round(255 * ((value - 0.5) / 0.25)); g = 255; b = 0;
        } else {
            r = 255; g = Math.round(255 * (1 - (value - 0.75) / 0.25)); b = 0;
        }
        return { r, g, b };
    }

    function toggleHeatmap() {
        state.heatmapVisible = !state.heatmapVisible;
        const canvas = state.heatmapCanvas;
        if (state.heatmapVisible) {
            if (!state.isTracking && state.gazeData.length > 0) {
                renderHeatmapFromData();
            }
            canvas.style.display = 'block';
        } else {
            canvas.style.display = 'none';
        }
        updateDashboardStatus();
    }

    function downloadHeatmapImage() {
        if (state.gazeData.length === 0) {
            showNotification('No gaze data to render.', 'warning');
            return Promise.resolve();
        }

        // Re-render full heatmap, then capture with page screenshot
        renderHeatmapFromData();
        state.heatmapCanvas.style.display = 'block';

        // Convert canvas to blob and upload
        return new Promise((resolve) => {
            state.heatmapCanvas.toBlob(async (blob) => {
                if (!blob) {
                    showNotification('Failed to generate heatmap image.', 'error');
                    resolve();
                    return;
                }
                const filename = `heatmap_${state.sessionId}.png`;
                // Cache locally so it survives upload failures
                cacheArtifact(filename, blob);
                try {
                    showNotification(`Uploading ${filename}...`, 'info');
                    const formData = new FormData();
                    formData.append('heatmap', blob, filename);
                    const res = await fetch(`${SERVER_URL}/api/sessions/${state.sessionId}/heatmap`, {
                        method: 'POST',
                        body: formData,
                    });
                    if (!res.ok) throw new Error(`Server responded ${res.status}`);
                    showNotification(`Uploaded: ${filename}`, 'success');
                } catch (e) {
                    console.error('[EyeTracking] Heatmap upload failed:', e);
                    showNotification(`Heatmap upload failed — saved locally. Use "Download All Locally" to retrieve.`, 'error');
                }
                resolve();
            }, 'image/png');
        });
    }

    // ===== Gaze Dot =====
    function createGazeDot() {
        const dot = document.createElement('div');
        dot.id = 'gazeDot';
        dot.className = 'et-gaze-dot';
        document.body.appendChild(dot);
    }

    function moveGazeDot(x, y) {
        const dot = document.getElementById('gazeDot');
        if (!dot) return;
        if (!isFinite(x) || !isFinite(y)) return;

        // Outlier rejection: skip huge jumps from current smoothed position
        if (state.smoothX !== null) {
            const dx = x - state.smoothX;
            const dy = y - state.smoothY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > CONFIG.gazeOutlierThreshold) {
                // Allow the smoothed position to drift slightly toward outliers
                // so the filter doesn't get permanently stuck
                state.smoothX += dx * 0.05;
                state.smoothY += dy * 0.05;
                dot.style.left = Math.round(state.smoothX) + 'px';
                dot.style.top = Math.round(state.smoothY) + 'px';
                dot.style.display = state.gazeDotVisible ? 'block' : 'none';
                return;
            }
        }

        // Exponential Moving Average (EMA) smoothing
        const alpha = CONFIG.gazeSmoothingAlpha;
        if (state.smoothX === null) {
            state.smoothX = x;
            state.smoothY = y;
        } else {
            state.smoothX = alpha * x + (1 - alpha) * state.smoothX;
            state.smoothY = alpha * y + (1 - alpha) * state.smoothY;
        }

        dot.style.left = Math.round(state.smoothX) + 'px';
        dot.style.top = Math.round(state.smoothY) + 'px';
        dot.style.display = state.gazeDotVisible ? 'block' : 'none';
    }

    function toggleGazeDot() {
        state.gazeDotVisible = !state.gazeDotVisible;
        const dot = document.getElementById('gazeDot');
        if (dot) dot.style.display = state.gazeDotVisible ? 'block' : 'none';
        updateDashboardStatus();
    }

    // ===== Quick Recenter (mid-session drift correction) =====
    function quickRecenter() {
        if (!state.isCalibrated) {
            showNotification('Please calibrate first!', 'warning');
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'et-calibration-overlay';
        overlay.innerHTML = `
            <div class="et-calibration-content">
                <p style="font-size:1.2em; margin-bottom: 20px;">Look at the center dot and click it 5 times to recenter.</p>
                <div id="recenterDot" class="et-cal-dot et-cal-dot-ready" style="display:block; position:absolute;"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        const cx = Math.round(window.innerWidth / 2);
        const cy = Math.round(window.innerHeight / 2);
        const dot = document.getElementById('recenterDot');
        dot.style.left = cx + 'px';
        dot.style.top = cy + 'px';

        let clicks = 0;
        dot.onclick = () => {
            clicks++;
            webgazer.recordScreenPosition(cx, cy, 'click');
            dot.className = 'et-cal-dot et-cal-dot-clicked';
            setTimeout(() => { dot.className = 'et-cal-dot et-cal-dot-ready'; }, 120);

            if (clicks >= 5) {
                // Reset smoothing state so dot jumps to corrected position
                state.smoothX = null;
                state.smoothY = null;
                overlay.remove();
                showNotification('Gaze recentered!', 'success');
            }
        };
    }

    // ===== Video Recording =====
    async function startRecording() {
        try {
            // 1. Capture screen video
            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { mediaSource: 'screen', cursor: 'always' },
                audio: false,
            });

            // 2. Capture webcam (face) + microphone (voice)
            let webcamMicStream = null;
            try {
                webcamMicStream = await navigator.mediaDevices.getUserMedia({
                    video: { width: 320, height: 240, facingMode: 'user' },
                    audio: true,
                });
                state.webcamStream = webcamMicStream;
            } catch (e) {
                console.warn('[EyeTracking] Webcam/mic not available:', e.message);
            }

            // 3. Build combined stream: screen video + microphone audio
            const combinedTracks = [...screenStream.getVideoTracks()];
            if (webcamMicStream) {
                const audioTracks = webcamMicStream.getAudioTracks();
                audioTracks.forEach(t => combinedTracks.push(t));
            }
            const combinedStream = new MediaStream(combinedTracks);
            state.screenStream = screenStream;

            // 4. Screen + audio recorder
            state.recordedChunks = [];
            const screenRecorder = new MediaRecorder(combinedStream, {
                mimeType: getSupportedMimeType(),
            });
            screenRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    state.recordedChunks.push(event.data);
                }
            };
            screenRecorder.onstop = () => {
                screenStream.getTracks().forEach(t => t.stop());
                downloadRecording(state.recordedChunks, `screen_recording_${state.sessionId}.webm`);
            };

            // 5. Webcam face + voice recorder (separate file)
            if (webcamMicStream) {
                state.webcamRecordedChunks = [];
                const webcamRecorder = new MediaRecorder(webcamMicStream, {
                    mimeType: getSupportedMimeType(),
                });
                webcamRecorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        state.webcamRecordedChunks.push(event.data);
                    }
                };
                webcamRecorder.onstop = () => {
                    downloadRecording(state.webcamRecordedChunks, `face_voice_${state.sessionId}.webm`);
                    // Clean up webcam stream after download
                    if (state.webcamStream) {
                        state.webcamStream.getTracks().forEach(t => t.stop());
                        state.webcamStream = null;
                    }
                    removeWebcamPreview();
                };
                webcamRecorder.start(1000);
                state.webcamRecorder = webcamRecorder;
            }

            // Stop recording if screen share is ended by user
            screenStream.getVideoTracks()[0].addEventListener('ended', () => {
                if (state.isRecording) stopRecording();
            });

            screenRecorder.start(1000);
            state.mediaRecorder = screenRecorder;
            state.isRecording = true;
            updateDashboardStatus();
            showNotification('Recording started (screen + face + voice)!', 'success');
        } catch (err) {
            console.error('[EyeTracking] Recording error:', err);
            showNotification('Failed to start recording. Please allow screen sharing.', 'error');
        }
    }

    function showWebcamPreview(stream) {
        removeWebcamPreview();
        const container = document.createElement('div');
        container.id = 'etWebcamPreview';
        container.className = 'et-webcam-preview';
        container.innerHTML = `
            <div class="et-webcam-header">
                <span class="et-webcam-rec-dot"></span> FACE+VOICE
                <button class="et-webcam-close" title="Hide preview">&times;</button>
            </div>
            <video autoplay playsinline muted></video>
        `;
        document.body.appendChild(container);

        const video = container.querySelector('video');
        video.srcObject = stream;

        // Make preview draggable
        let isDragging = false, offsetX, offsetY;
        const header = container.querySelector('.et-webcam-header');
        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            offsetX = e.clientX - container.offsetLeft;
            offsetY = e.clientY - container.offsetTop;
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            container.style.left = (e.clientX - offsetX) + 'px';
            container.style.top = (e.clientY - offsetY) + 'px';
            container.style.right = 'auto';
            container.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => { isDragging = false; });

        container.querySelector('.et-webcam-close').addEventListener('click', () => {
            container.style.display = 'none';
        });
    }

    function removeWebcamPreview() {
        const existing = document.getElementById('etWebcamPreview');
        if (existing) existing.remove();
    }

    function getSupportedMimeType() {
        const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) return type;
        }
        return 'video/webm';
    }

    function stopRecording() {
        if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
            state.mediaRecorder.stop();
        }
        if (state.webcamRecorder && state.webcamRecorder.state !== 'inactive') {
            state.webcamRecorder.stop();
        }
        state.isRecording = false;
        updateDashboardStatus();
        showNotification('Recording stopped. Uploading files to server...', 'info');
    }

    function downloadRecording(chunks, filename) {
        if (!chunks || chunks.length === 0) return;
        const blob = new Blob(chunks, { type: 'video/webm' });
        uploadRecording(blob, filename);
    }

    async function uploadRecording(blob, filename) {
        // Cache the recording locally first so it survives upload failures
        cacheArtifact(filename, blob);
        try {
            showNotification(`Uploading ${filename}...`, 'info');
            const formData = new FormData();
            formData.append('recording', blob, filename);
            const res = await fetch(`${SERVER_URL}/api/sessions/${state.sessionId}/recording`, {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) throw new Error(`Server responded ${res.status}`);
            const data = await res.json();
            showNotification(`Uploaded: ${data.filename} (${(data.size / 1024 / 1024).toFixed(1)} MB)`, 'success');
        } catch (e) {
            console.error('[EyeTracking] Upload failed:', e);
            showNotification(`Upload failed for ${filename} — saved locally. Use "Download All Locally" to retrieve.`, 'error');
        }
    }

    // ===== CSV Export =====
    async function exportRawCSV() {
        if (state.gazeData.length === 0) {
            showNotification('No gaze data to export.', 'warning');
            return;
        }
        const headers = [
            'session_id', 'participant_id',
            'timestamp', 'elapsed_ms', 'gaze_x', 'gaze_y', 'pupil_diameter',
            'view_width', 'view_height', 'scroll_x', 'scroll_y', 'current_view'
        ];
        const rows = state.gazeData.map(d => [
            state.sessionId, state.participantId || '',
            d.timestamp, d.elapsedMs, d.x, d.y, d.pupilD ?? '',
            d.viewWidth, d.viewHeight, d.scrollX, d.scrollY, d.currentView
        ]);
        await downloadCSV(headers, rows, `raw_gaze_data_${state.sessionId}.csv`);
    }

    async function exportFixationsCSV() {
        if (state.fixations.length === 0) {
            showNotification('No fixation data. Track first, then stop.', 'warning');
            return;
        }
        const headers = [
            'session_id', 'participant_id',
            'fixation_id', 'start_time', 'end_time', 'duration_ms',
            'centroid_x', 'centroid_y', 'sample_count', 'dispersion',
            'view', 'avg_pupil_diameter'
        ];
        const rows = state.fixations.map(f => [
            state.sessionId, state.participantId || '',
            f.id, f.startTime, f.endTime, f.duration,
            f.centroidX.toFixed(1), f.centroidY.toFixed(1), f.sampleCount, f.dispersion.toFixed(1),
            f.view, f.avgPupilD ? f.avgPupilD.toFixed(2) : ''
        ]);
        await downloadCSV(headers, rows, `fixations_${state.sessionId}.csv`);
    }

    async function exportSaccadesCSV() {
        if (state.saccades.length === 0) {
            showNotification('No saccade data available.', 'warning');
            return;
        }
        const headers = [
            'session_id', 'participant_id',
            'saccade_id', 'from_fixation', 'to_fixation', 'start_time', 'end_time',
            'duration_ms', 'distance_px', 'velocity_px_per_sec', 'direction_deg'
        ];
        const rows = state.saccades.map(s => [
            state.sessionId, state.participantId || '',
            s.id, s.fromFixation, s.toFixation, s.startTime, s.endTime,
            s.duration, s.distance, s.velocity, s.direction
        ]);
        await downloadCSV(headers, rows, `saccades_${state.sessionId}.csv`);
    }

    async function exportAOIMetricsCSV() {
        if (!state.aoiMetrics) {
            computeAOIMetrics();
        }
        const metrics = state.aoiMetrics;
        if (!metrics) {
            showNotification('No AOI metrics. Track first.', 'warning');
            return;
        }
        const headers = [
            'session_id', 'participant_id',
            'aoi_id', 'aoi_label', 'fixation_count', 'total_dwell_time_ms',
            'avg_fixation_duration_ms', 'time_to_first_fixation_ms',
            'first_fixation_id'
        ];
        const rows = Object.entries(metrics).map(([id, m]) => [
            state.sessionId, state.participantId || '',
            id, m.label, m.fixationCount, m.totalDwellTime,
            m.fixationCount > 0 ? (m.totalDwellTime / m.fixationCount).toFixed(1) : '',
            m.ttff !== null ? m.ttff : '',
            m.fixations.length > 0 ? m.fixations[0].id : ''
        ]);
        await downloadCSV(headers, rows, `aoi_metrics_${state.sessionId}.csv`);
    }

    async function exportSessionSummaryCSV() {
        const totalDuration = state.gazeData.length > 0
            ? state.gazeData[state.gazeData.length - 1].timestamp - state.gazeData[0].timestamp
            : 0;
        const avgFixDuration = state.fixations.length > 0
            ? state.fixations.reduce((s, f) => s + f.duration, 0) / state.fixations.length
            : 0;
        const avgSaccadeLen = state.saccades.length > 0
            ? state.saccades.reduce((s, c) => s + c.distance, 0) / state.saccades.length
            : 0;
        const avgPupil = state.gazeData.filter(d => d.pupilD).length > 0
            ? state.gazeData.filter(d => d.pupilD).reduce((s, d) => s + d.pupilD, 0) / state.gazeData.filter(d => d.pupilD).length
            : null;

        const headers = ['metric', 'value'];
        const sessionEnd = state.gazeData.length > 0 ? state.gazeData[state.gazeData.length - 1].timestamp : null;
        const rows = [
            ['session_id', state.sessionId],
            ['participant_id', state.participantId || 'N/A'],
            ['session_start', state.sessionStartTime ? new Date(state.sessionStartTime).toISOString() : ''],
            ['session_end', sessionEnd ? new Date(sessionEnd).toISOString() : ''],
            ['total_duration_ms', totalDuration],
            ['total_samples', state.gazeData.length],
            ['sampling_rate_hz', totalDuration > 0 ? (state.gazeData.length / (totalDuration / 1000)).toFixed(1) : ''],
            ['total_fixations', state.fixations.length],
            ['avg_fixation_duration_ms', avgFixDuration.toFixed(1)],
            ['total_saccades', state.saccades.length],
            ['avg_saccade_distance_px', avgSaccadeLen.toFixed(1)],
            ['avg_pupil_diameter', avgPupil ? avgPupil.toFixed(2) : 'N/A'],
            ['calibration_accuracy_px', state.calibrationAccuracy ? state.calibrationAccuracy.toFixed(1) : 'N/A'],
            ['calibration_points', state.calibrationPoints.length],
            ['screen_width', window.innerWidth],
            ['screen_height', window.innerHeight],
        ];
        await downloadCSV(headers, rows, `session_summary_${state.sessionId}.csv`);
    }

    async function downloadCSV(headers, rows, filename) {
        let csv = headers.join(',') + '\n';
        rows.forEach(row => {
            csv += row.map(cell => {
                const str = String(cell);
                // Escape commas and quotes
                if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                    return '"' + str.replace(/"/g, '""') + '"';
                }
                return str;
            }).join(',') + '\n';
        });
        await uploadCSV(csv, filename);
    }

    async function uploadCSV(csvContent, filename) {
        // Cache locally first so the user can recover this even if upload fails
        cacheArtifact(filename, new Blob([csvContent], { type: 'text/csv;charset=utf-8' }));
        try {
            showNotification(`Uploading ${filename}...`, 'info');
            const res = await fetch(`${SERVER_URL}/api/sessions/${state.sessionId}/csv`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, content: csvContent }),
            });
            if (!res.ok) throw new Error(`Server responded ${res.status}`);
            showNotification(`Uploaded: ${filename}`, 'success');
        } catch (e) {
            console.error('[EyeTracking] CSV upload failed:', e);
            showNotification(`Upload failed for ${filename} — saved locally. Use "Download All Locally" to retrieve.`, 'error');
        }
    }

    // ===== Export All Data as JSON =====
    async function exportFullJSON() {
        const data = {
            sessionId: state.sessionId,
            participantId: state.participantId,
            sessionStart: state.sessionStartTime,
            sessionEnd: state.gazeData.length > 0 ? state.gazeData[state.gazeData.length - 1].timestamp : null,
            calibrationAccuracy: state.calibrationAccuracy,
            calibrationPoints: state.calibrationPoints,
            screenWidth: window.innerWidth,
            screenHeight: window.innerHeight,
            rawGazeData: state.gazeData,
            fixations: state.fixations,
            saccades: state.saccades,
            aoiMetrics: state.aoiMetrics,
        };
        const filename = `full_session_${state.sessionId}.json`;
        // Cache locally first so it survives upload failures
        cacheArtifact(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        try {
            showNotification(`Uploading ${filename}...`, 'info');
            const res = await fetch(`${SERVER_URL}/api/sessions/${state.sessionId}/json`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, data }),
            });
            if (!res.ok) throw new Error(`Server responded ${res.status}`);
            showNotification(`Uploaded: ${filename}`, 'success');
        } catch (e) {
            console.error('[EyeTracking] JSON upload failed:', e);
            showNotification(`Upload failed for ${filename} — saved locally. Use "Download All Locally" to retrieve.`, 'error');
        }
    }

    // ===== Research Dashboard UI =====
    function createResearchUI() {
        const panel = document.createElement('div');
        panel.id = 'etResearchPanel';
        panel.className = 'et-panel';
        panel.innerHTML = `
            <div class="et-panel-header" id="etPanelHeader">
                <span class="et-panel-title">Eye-Tracking Research</span>
                <span class="et-panel-drag-hint" title="Drag to move">⠿</span>
                <button class="et-panel-toggle" id="etPanelToggle">▼</button>
            </div>
            <div class="et-panel-body" id="etPanelBody">
                <!-- Research Condition -->
                <div class="et-section">
                    <h4 class="et-section-title">Research Condition (IV)</h4>
                    <div class="et-condition-toggle">
                        <span class="et-condition-label" id="etCondLabelReactive">Reactive</span>
                        <label class="et-switch">
                            <input type="checkbox" id="etConditionToggle" checked>
                            <span class="et-switch-slider"></span>
                        </label>
                        <span class="et-condition-label et-condition-active" id="etCondLabelProactive">Proactive</span>
                    </div>
                    <div class="et-condition-desc" id="etConditionDesc">Proactive: App pushes eco-info (auto-expand, alerts, proactive chat)</div>
                </div>

                <!-- Participant -->
                <div class="et-section">
                    <label class="et-label">Participant ID</label>
                    <input type="text" id="etParticipantId" class="et-input" placeholder="P001">
                    <label class="et-label">Session: <span id="etSessionId" class="et-muted">${state.sessionId}</span></label>
                </div>

                <!-- Status Indicators -->
                <div class="et-status-grid">
                    <div class="et-status-item">
                        <span class="et-status-dot" id="etCalStatus"></span>
                        <span>Calibrated</span>
                    </div>
                    <div class="et-status-item">
                        <span class="et-status-dot" id="etTrackStatus"></span>
                        <span>Tracking</span>
                    </div>
                    <div class="et-status-item">
                        <span class="et-status-dot" id="etRecordStatus"></span>
                        <span>Recording</span>
                    </div>
                </div>

                <!-- Calibration Settings -->
                <div class="et-section">
                    <h4 class="et-section-title">Calibration Settings</h4>
                    <div class="et-settings-row">
                        <label class="et-label">Grid Points</label>
                        <select id="etCalPoints" class="et-select">
                            <option value="5">5 (fast)</option>
                            <option value="9" selected>9 (standard)</option>
                            <option value="13">13 (recommended)</option>
                            <option value="16">16 (high density)</option>
                        </select>
                    </div>
                    <div class="et-settings-row">
                        <label class="et-label">Clicks per Point</label>
                        <select id="etCalClicks" class="et-select">
                            <option value="3">3 (fast)</option>
                            <option value="5" selected>5 (standard)</option>
                            <option value="8">8 (high accuracy)</option>
                        </select>
                    </div>
                    <div class="et-settings-row">
                        <label class="et-label">Rounds</label>
                        <select id="etCalRounds" class="et-select">
                            <option value="1" selected>1 (fast)</option>
                            <option value="2">2 (recommended)</option>
                            <option value="3">3 (thorough)</option>
                        </select>
                    </div>
                    <div class="et-settings-row">
                        <label class="et-label">Dwell Time</label>
                        <select id="etCalDwell" class="et-select">
                            <option value="400">400ms (fast)</option>
                            <option value="800" selected>800ms (standard)</option>
                            <option value="1200">1200ms (precise)</option>
                        </select>
                    </div>
                </div>

                <!-- Controls -->
                <div class="et-section">
                    <h4 class="et-section-title">Controls</h4>
                    <button class="et-btn et-btn-primary et-btn-full" id="etCalibrateBtn">🎯 Calibrate</button>
                    <button class="et-btn et-btn-secondary et-btn-full" id="etRecenterBtn">🔄 Quick Recenter</button>
                    <div class="et-btn-row">
                        <button class="et-btn et-btn-success" id="etStartBtn" disabled>▶ Start</button>
                        <button class="et-btn et-btn-danger" id="etStopBtn" disabled>⏹ Stop</button>
                    </div>
                    <div class="et-btn-row">
                        <button class="et-btn et-btn-secondary" id="etRecordBtn">⏺ Record (Screen+Face+Voice)</button>
                        <button class="et-btn et-btn-secondary" id="etStopRecordBtn" disabled>⏹ Stop Rec</button>
                    </div>
                </div>

                <!-- Display Toggles -->
                <div class="et-section">
                    <h4 class="et-section-title">Display</h4>
                    <div class="et-toggle-row">
                        <label class="et-toggle-label">
                            <input type="checkbox" id="etShowHeatmap"> Show Heatmap
                        </label>
                        <label class="et-toggle-label">
                            <input type="checkbox" id="etShowGazeDot" checked> Show Gaze Dot
                        </label>
                    </div>
                </div>

                <!-- Live Metrics -->
                <div class="et-section">
                    <h4 class="et-section-title">Live Metrics</h4>
                    <div class="et-metrics-grid">
                        <div class="et-metric">
                            <div class="et-metric-value" id="etMetricSamples">0</div>
                            <div class="et-metric-label">Samples</div>
                        </div>
                        <div class="et-metric">
                            <div class="et-metric-value" id="etMetricFixations">0</div>
                            <div class="et-metric-label">Fixations</div>
                        </div>
                        <div class="et-metric">
                            <div class="et-metric-value" id="etMetricAvgFixDur">0</div>
                            <div class="et-metric-label">Avg Fix (ms)</div>
                        </div>
                        <div class="et-metric">
                            <div class="et-metric-value" id="etMetricSaccades">0</div>
                            <div class="et-metric-label">Saccades</div>
                        </div>
                        <div class="et-metric">
                            <div class="et-metric-value" id="etMetricPupil">—</div>
                            <div class="et-metric-label">Pupil D</div>
                        </div>
                        <div class="et-metric">
                            <div class="et-metric-value" id="etMetricCalAcc">—</div>
                            <div class="et-metric-label">Cal Acc (px)</div>
                        </div>
                    </div>
                </div>

                <!-- Export -->
                <div class="et-section">
                    <h4 class="et-section-title">Upload Data to Server</h4>
                    <button class="et-btn et-btn-export et-btn-full" id="etExportRawCSV">📊 Upload Raw Gaze CSV</button>
                    <button class="et-btn et-btn-export et-btn-full" id="etExportFixCSV">📊 Upload Fixations CSV</button>
                    <button class="et-btn et-btn-export et-btn-full" id="etExportSacCSV">📊 Upload Saccades CSV</button>
                    <button class="et-btn et-btn-export et-btn-full" id="etExportAOICSV">📊 Upload AOI Metrics CSV</button>
                    <button class="et-btn et-btn-export et-btn-full" id="etExportSummaryCSV">📊 Upload Session Summary CSV</button>
                    <button class="et-btn et-btn-export et-btn-full" id="etExportJSON">📦 Upload Full Session JSON</button>
                    <button class="et-btn et-btn-export et-btn-full" id="etExportHeatmap">🖼️ Upload Heatmap PNG</button>
                </div>

                <!-- Local Backup -->
                <div class="et-section">
                    <h4 class="et-section-title">Local Backup (if upload fails)</h4>
                    <p class="et-muted" style="font-size:11px;margin:4px 0 8px 0;">
                        Cached files: <strong id="etLocalArtifactCount">0</strong>.
                        Every CSV / JSON / heatmap / recording is automatically saved in memory the moment it's generated, so you can download them locally even if the Azure upload fails.
                    </p>
                    <button class="et-btn et-btn-primary et-btn-full" id="etDownloadAllLocal">💾 Download All Locally</button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        // Wire up events
        document.getElementById('etPanelToggle').addEventListener('click', togglePanel);
        document.getElementById('etPanelHeader').addEventListener('click', togglePanel);
        document.getElementById('etCalibrateBtn').addEventListener('click', () => {
            state.participantId = document.getElementById('etParticipantId').value.trim();
            // Apply calibration settings from dropdowns
            CONFIG.calibrationPoints = parseInt(document.getElementById('etCalPoints').value, 10);
            CONFIG.calibrationClicksPerPoint = parseInt(document.getElementById('etCalClicks').value, 10);
            CONFIG.calibrationRounds = parseInt(document.getElementById('etCalRounds').value, 10);
            CONFIG.calibrationDwellTime = parseInt(document.getElementById('etCalDwell').value, 10);
            startCalibration();
        });
        document.getElementById('etStartBtn').addEventListener('click', () => {
            state.participantId = document.getElementById('etParticipantId').value.trim();
            startTracking();
        });
        document.getElementById('etStopBtn').addEventListener('click', stopTracking);
        document.getElementById('etRecenterBtn').addEventListener('click', quickRecenter);
        document.getElementById('etRecordBtn').addEventListener('click', startRecording);
        document.getElementById('etStopRecordBtn').addEventListener('click', stopRecording);
        document.getElementById('etShowHeatmap').addEventListener('change', toggleHeatmap);
        document.getElementById('etShowGazeDot').addEventListener('change', toggleGazeDot);
        document.getElementById('etExportRawCSV').addEventListener('click', exportRawCSV);
        document.getElementById('etExportFixCSV').addEventListener('click', exportFixationsCSV);
        document.getElementById('etExportSacCSV').addEventListener('click', exportSaccadesCSV);
        document.getElementById('etExportAOICSV').addEventListener('click', exportAOIMetricsCSV);
        document.getElementById('etExportSummaryCSV').addEventListener('click', exportSessionSummaryCSV);
        document.getElementById('etExportJSON').addEventListener('click', exportFullJSON);
        document.getElementById('etExportHeatmap').addEventListener('click', downloadHeatmapImage);
        document.getElementById('etDownloadAllLocal').addEventListener('click', downloadAllArtifactsLocally);

        // Condition toggle (proactive/reactive)
        const condToggle = document.getElementById('etConditionToggle');
        // Sync initial state from App if available
        if (typeof App !== 'undefined' && App.getState) {
            const appState = App.getState();
            condToggle.checked = appState.nudgeMode === 'proactive';
        }
        updateConditionToggleUI(condToggle.checked);
        condToggle.addEventListener('change', () => {
            const isProactive = condToggle.checked;
            updateConditionToggleUI(isProactive);
            // Update the main app's nudge mode
            if (typeof App !== 'undefined' && App.setNudgeMode) {
                App.setNudgeMode(isProactive ? 'proactive' : 'reactive');
            }
        });

        // Make panel draggable
        makePanelDraggable(panel);

        // Live metrics update timer
        setInterval(updateMetricsDisplay, 1000);
    }

    function updateConditionToggleUI(isProactive) {
        const labelReactive = document.getElementById('etCondLabelReactive');
        const labelProactive = document.getElementById('etCondLabelProactive');
        const desc = document.getElementById('etConditionDesc');
        if (labelReactive) labelReactive.classList.toggle('et-condition-active', !isProactive);
        if (labelProactive) labelProactive.classList.toggle('et-condition-active', isProactive);
        if (desc) {
            desc.textContent = isProactive
                ? 'Proactive: App pushes eco-info (auto-expand, alerts, proactive chat)'
                : 'Reactive: User must seek eco-info (collapsed panel, no alerts, passive)';
        }
    }

    function makePanelDraggable(panel) {
        const header = panel.querySelector('.et-panel-header');
        let isDragging = false;
        let dragStartX, dragStartY, panelStartX, panelStartY;

        header.addEventListener('mousedown', (e) => {
            // Don't drag if clicking the toggle button
            if (e.target.closest('.et-panel-toggle')) return;
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            panelStartX = rect.left;
            panelStartY = rect.top;

            // Switch from right-positioned to left-positioned for dragging
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            panel.style.right = 'auto';

            panel.classList.add('et-panel-dragging');
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            let newX = panelStartX + dx;
            let newY = panelStartY + dy;

            // Clamp within viewport
            const maxX = window.innerWidth - panel.offsetWidth;
            const maxY = window.innerHeight - 40; // keep header visible
            newX = Math.max(0, Math.min(newX, maxX));
            newY = Math.max(0, Math.min(newY, maxY));

            panel.style.left = newX + 'px';
            panel.style.top = newY + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                panel.classList.remove('et-panel-dragging');
            }
        });
    }

    function togglePanel() {
        const body = document.getElementById('etPanelBody');
        const toggle = document.getElementById('etPanelToggle');
        if (body.style.display === 'none') {
            body.style.display = 'block';
            toggle.textContent = '▼';
        } else {
            body.style.display = 'none';
            toggle.textContent = '▶';
        }
    }

    function updateDashboardStatus() {
        // Status dots
        setStatusDot('etCalStatus', state.isCalibrated);
        setStatusDot('etTrackStatus', state.isTracking);
        setStatusDot('etRecordStatus', state.isRecording);

        // Button states
        const startBtn = document.getElementById('etStartBtn');
        const stopBtn = document.getElementById('etStopBtn');
        const recordBtn = document.getElementById('etRecordBtn');
        const stopRecordBtn = document.getElementById('etStopRecordBtn');

        if (startBtn) startBtn.disabled = !state.isCalibrated || state.isTracking;
        if (stopBtn) stopBtn.disabled = !state.isTracking;
        if (recordBtn) recordBtn.disabled = state.isRecording;
        if (stopRecordBtn) stopRecordBtn.disabled = !state.isRecording;
    }

    function setStatusDot(id, active) {
        const dot = document.getElementById(id);
        if (dot) {
            dot.className = 'et-status-dot ' + (active ? 'et-status-active' : 'et-status-inactive');
        }
    }

    function updateMetricsDisplay() {
        const samples = document.getElementById('etMetricSamples');
        const fixations = document.getElementById('etMetricFixations');
        const avgFixDur = document.getElementById('etMetricAvgFixDur');
        const saccades = document.getElementById('etMetricSaccades');
        const pupil = document.getElementById('etMetricPupil');
        const calAcc = document.getElementById('etMetricCalAcc');

        if (samples) samples.textContent = state.gazeData.length;
        if (fixations) fixations.textContent = state.fixations.length;
        if (avgFixDur) {
            const avg = state.fixations.length > 0
                ? state.fixations.reduce((s, f) => s + f.duration, 0) / state.fixations.length
                : 0;
            avgFixDur.textContent = avg.toFixed(0);
        }
        if (saccades) saccades.textContent = state.saccades.length;
        if (pupil) {
            const recentPupil = state.gazeData.slice(-50).filter(d => d.pupilD);
            pupil.textContent = recentPupil.length > 0
                ? (recentPupil.reduce((s, d) => s + d.pupilD, 0) / recentPupil.length).toFixed(2)
                : '—';
        }
        if (calAcc) {
            calAcc.textContent = state.calibrationAccuracy ? state.calibrationAccuracy.toFixed(1) : '—';
        }
    }

    // ===== Notification =====
    function showNotification(message, type) {
        const container = document.getElementById('toastContainer') || document.body;
        const toast = document.createElement('div');
        toast.className = `et-toast et-toast-${type || 'info'}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => { toast.classList.add('et-toast-show'); }, 10);
        setTimeout(() => {
            toast.classList.remove('et-toast-show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ===== Public API =====
    return {
        init,
        startCalibration,
        startTracking,
        stopTracking,
        startRecording,
        stopRecording,
        toggleHeatmap,
        toggleGazeDot,
        quickRecenter,
        exportRawCSV,
        exportFixationsCSV,
        exportSaccadesCSV,
        exportAOIMetricsCSV,
        exportSessionSummaryCSV,
        exportFullJSON,
        downloadHeatmapImage,
        getState: () => state,
    };
})();

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    EyeTrackingResearch.init();
});
