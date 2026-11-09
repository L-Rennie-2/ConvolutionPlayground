import { createWavBlob } from "./audio.js?v=2";

// The page loads Peaks.js' browser bundle before the application module.
const Peaks = window.peaks;

const instances = {
    input: null,
    ir: null,
    output: null
};

const durations = {
    input: 0,
    ir: 0,
    output: 0
};

const mediaUrls = {
    input: null,
    ir: null,
    output: null
};

let linkedViews = true;
let syncing = false;

const MIN_ZOOM_SCALE = 1;
const ZOOM_FACTOR = 1.5;
const INITIAL_VISIBLE_SECONDS = 5;

let linkedHandlers = [];
const shiftDragGuards = new WeakSet();

function getView(role) {
    return instances[role]?.views.getView("zoomview") ?? null;
}

// Remove event listeners before replacing waveform instances.
function disconnectLinkedViews() {
    for (const [instance, event, handler] of linkedHandlers) {
        instance.off(event, handler);
    }

    linkedHandlers = [];
}

function addLinkedHandler(instance, event, handler) {
    instance.on(event, handler);
    linkedHandlers.push([instance, event, handler]);
}

// Wait until the browser has laid out the view before Peaks measures it.
async function waitForContainerSize(container) {
    let lastWidth = 0;
    let lastHeight = 0;

    for (let attempt = 0; attempt < 120; attempt += 1) {
        const { width, height } = container.getBoundingClientRect();
        lastWidth = width;
        lastHeight = height;

        if (width > 0 && height > 0) return;

        await new Promise(requestAnimationFrame);
    }

    throw new Error(
        `Waveform container #${container.id} is ${lastWidth}px wide and ${lastHeight}px high. ` +
        "Make sure it and its parent elements are visible and have dimensions."
    );
}

// Peaks.js has no Shift-drag setting; block that gesture on the output view
// before its canvas handlers receive the mouse-down event.
function disableShiftDrag(container) {
    if (shiftDragGuards.has(container)) return;

    const blockShiftMouseDown = event => {
        if (!event.shiftKey) return;

        event.preventDefault();
        event.stopImmediatePropagation();
    };

    container.addEventListener("pointerdown", blockShiftMouseDown, true);
    container.addEventListener("mousedown", blockShiftMouseDown, true);
    shiftDragGuards.add(container);
}

// Create a Peaks.js instance from an AudioBuffer.
async function createPeaks(audioBuffer, containerId, role, mediaSource) {
    const container = document.getElementById(containerId);

    if (!container) {
        throw new Error(`Waveform container #${containerId} was not found.`);
    }

    await waitForContainerSize(container);

    if (containerId === "output-waveform") {
        disableShiftDrag(container);
    }

    return new Promise((resolve, reject) => {

        // Peaks.js requires a media element, even when using
        // an AudioBuffer for waveform generation. Give it a playable source
        // so its player, playhead, and click-to-seek all control the same audio.
        const mediaElement = document.createElement("audio");
        mediaElement.preload = "auto";
        mediaUrls[role] = URL.createObjectURL(mediaSource ?? createWavBlob(audioBuffer));
        mediaElement.src = mediaUrls[role];
        mediaElement.load();

        Peaks.init({
            // A lower base scale preserves enough detail for close zooming.
            zoomLevels: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096],

            zoomview: {
                container: container,
                waveformColor: "#2563eb",
                // Keep the whole waveform drawn in one consistent color.
                playedWaveformColor: null,
                playheadColor: "#f97316",
                showAxisLabels: true,
                enableEditing: containerId !== "output-waveform"
            },

            scrollbar: {
                container: document.getElementById(
                    containerId.replace("waveform", "scrollbar")
                ),
                color: "#64748b",
                minWidth: 20
            },

            mediaElement: mediaElement,

            webAudio: {
                audioBuffer: audioBuffer,
                multiChannel: false
            },

            // Peaks.js creates and retains each resampled zoom level only
            // when that level is first requested.
            waveformCache: false

        }, (error, peaks) => {
            if (error) {
                URL.revokeObjectURL(mediaUrls[role]);
                mediaUrls[role] = null;
                reject(error);
                return;
            }

            // Configure the zoomable view using documented methods.
            const view = peaks.views.getView("zoomview");

            view.setWheelMode("scroll");
            view.enableAutoScroll(false);

            // Start with a useful close-up; short files remain fully visible.
            view.setZoom({
                seconds: Math.min(audioBuffer.duration, INITIAL_VISIBLE_SECONDS)
            });
            view.setStartTime(0);

            resolve(peaks);
        });
    });
}

// Create or replace one waveform.
export async function setWaveform(role, audioBuffer, mediaSource) {
    const containerIds = {
        input: "input-waveform",
        ir: "ir-waveform",
        output: "output-waveform"
    };

    if (!containerIds[role]) {
        throw new Error(`Unknown waveform role: ${role}`);
    }

    if (role === "input" || role === "output") {
        disconnectLinkedViews();
    }

    // Destroy the previous instance if one exists.
    if (instances[role]) {
        instances[role].player.pause();
        instances[role].destroy();
        instances[role] = null;
    }
    if (mediaUrls[role]) {
        URL.revokeObjectURL(mediaUrls[role]);
        mediaUrls[role] = null;
    }

    durations[role] = audioBuffer.duration;

    instances[role] = await createPeaks(
        audioBuffer,
        containerIds[role],
        role,
        mediaSource
    );

    // Reconnect input/output synchronisation when both exist.
    if (role === "input" || role === "output") {
        connectLinkedViews();
    }

    return instances[role];
}

// Remove a waveform and its instance.
export function clearWaveform(role) {
    if (role === "input" || role === "output") {
        disconnectLinkedViews();
    }

    if (instances[role]) {
        instances[role].player.pause();
        instances[role].destroy();
        instances[role] = null;
    }
    if (mediaUrls[role]) {
        URL.revokeObjectURL(mediaUrls[role]);
        mediaUrls[role] = null;
    }

    durations[role] = 0;

    if (role === "input" || role === "output") {
        connectLinkedViews();
    }
}

// Synchronise input and output zoom and scrolling.
function connectLinkedViews() {
    const input = instances.input;
    const output = instances.output;

    if (!input || !output) return;

    // Synchronise zoom level.
    addLinkedHandler(input, "zoom.update", event => {
        if (!linkedViews || syncing) return;

        syncing = true;

        const outputView = getView("output");

        outputView.setZoom({
            scale: event.currentZoom
        });

        syncing = false;
    });

    addLinkedHandler(output, "zoom.update", event => {
        if (!linkedViews || syncing) return;

        syncing = true;

        const inputView = getView("input");

        inputView.setZoom({
            scale: event.currentZoom
        });

        syncing = false;
    });

    // Synchronise horizontal scroll position.
    addLinkedHandler(input, "zoomview.update", event => {
        if (!linkedViews || syncing) return;

        syncing = true;

        getView("output").setStartTime(event.startTime);

        syncing = false;
    });

    addLinkedHandler(output, "zoomview.update", event => {
        if (!linkedViews || syncing) return;

        syncing = true;

        getView("input").setStartTime(event.startTime);

        syncing = false;
    });
}

// Enable or disable linked views.
export function setLinkedViews(enabled) {
    linkedViews = enabled;

    // When linking is enabled, align the output to the input.
    if (linkedViews && instances.input && instances.output) {
        const inputView = getView("input");
        const outputView = getView("output");

        syncing = true;

        const inputZoom = inputView.getEndTime() - inputView.getStartTime();

        outputView.setZoom({
            seconds: inputZoom
        });

        outputView.setStartTime(inputView.getStartTime());

        syncing = false;
    }
}

export function playWaveform(role) {
    return instances[role]?.player.play();
}

export function stopAllWaveforms() {
    for (const instance of Object.values(instances)) {
        if (!instance) continue;

        instance.player.pause();
        instance.player.seek(0);
    }
}

// Apply a zoom change while keeping the centre of the view.
function changeZoom(role, direction) {
    const view = getView(role);

    if (!view) return;

    const start = view.getStartTime();
    const end = view.getEndTime();

    const totalDuration = durations[role];
    const waveformData = instances[role].getWaveformData();
    const sampleRate = waveformData.sample_rate;
    const viewWidth = view.getWidth();

    if (!sampleRate || !viewWidth || !totalDuration || end <= start) return;

    // Peaks.js uses integer samples-per-pixel scales. Step that value
    // directly so zooming out from scale 1 advances to scale 2 instead of
    // flooring 1.5 back to 1.
    const currentScale = (end - start) * sampleRate / viewWidth;
    const maxScale = Math.ceil(totalDuration * sampleRate / viewWidth);
    let newScale;

    if (direction === "in") {
        if (currentScale <= MIN_ZOOM_SCALE) return;
        newScale = Math.max(
            MIN_ZOOM_SCALE,
            Math.floor(currentScale / ZOOM_FACTOR)
        );
    } else {
        if (currentScale >= maxScale) return;
        newScale = Math.min(
            maxScale,
            Math.max(currentScale + 1, Math.ceil(currentScale * ZOOM_FACTOR))
        );
    }

    const centre = (start + end) / 2;
    const newVisibleSeconds = newScale * viewWidth / sampleRate;

    view.setZoom({
        scale: newScale
    });

    view.setStartTime(
        Math.max(0, centre - newVisibleSeconds / 2)
    );
}

export function zoomIn(role) {
    changeZoom(role, "in");
}

export function zoomOut(role) {
    changeZoom(role, "out");
}

// Return one waveform to its initial visible duration.
export function resetZoom(role) {
    const view = getView(role);

    if (view) {
        view.setZoom({
            seconds: Math.min(durations[role], INITIAL_VISIBLE_SECONDS)
        });

        view.setStartTime(0);
    }
}
