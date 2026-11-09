// src/main.js

import { convolve, normalise } from "./partitionedConvolution.js";

import {
    audioContext,
    loadAudioFile,
    downloadWav
} from "./audio.js?v=2";

import {
    setWaveform,
    clearWaveform,
    setLinkedViews,
    playWaveform,
    stopAllWaveforms,
    zoomIn,
    zoomOut,
    resetZoom
} from "./waveforms.js";

let inputBuffer = null;
let irBuffer = null;
let outputBuffer = null;
const saveButtons = {
    input: document.getElementById("save-input"),
    ir: document.getElementById("save-ir"),
    output: document.getElementById("save-output")
};

// Load and display an audio file.
async function loadFile(file, role) {
    if (!file) return;

    let stage = "read/decode";

    try {
        const buffer = await loadAudioFile(file);

        if (role === "input") {
            inputBuffer = buffer;
        } else {
            irBuffer = buffer;
        }
        saveButtons[role].disabled = false;

        // Display the newly loaded waveform immediately.
        stage = "waveform rendering";
        await setWaveform(role, buffer, file);

        // Remove any output calculated from the previous files.
        outputBuffer = null;
        saveButtons.output.disabled = true;
        clearWaveform("output");

        // Recalculate once both files have been loaded.
        if (inputBuffer && irBuffer) {
            await updateOutput();
        }

    } catch (error) {
        console.error(`Audio ${stage} failed for ${file.name}:`, error);
        const detail = error instanceof Error ? error.message : String(error);
        alert(`Could not ${stage === "read/decode" ? "decode" : "display"} "${file.name}".\n${detail}`);
    }
}

// Calculate the convolution and display the result.
async function updateOutput() {
    if (!inputBuffer || !irBuffer) return;

    const input = inputBuffer.getChannelData(0);
    const impulse = irBuffer.getChannelData(0);
    const peakIndex = findImpulsePeakIndex(impulse);

    // Give the browser time to render the input and IR waveforms.
    await new Promise(resolve => {
        requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
        });
    });

    const result = convolve(input, impulse);
    const safeResult = normalise(result);

    // Create the output audio buffer.
    outputBuffer = audioContext.createBuffer(
        1,
        safeResult.length,
        inputBuffer.sampleRate
    );

    outputBuffer.copyToChannel(safeResult, 0);
    saveButtons.output.disabled = false;

    // Align the input with the IR's peak while keeping total padding equal
    // to the IR's convolution span (IR length minus one sample).
    const leftPadding = peakIndex;
    const rightPadding = impulse.length - 1 - peakIndex;
    const paddedInput = audioContext.createBuffer(
        1,
        input.length + leftPadding + rightPadding,
        inputBuffer.sampleRate
    );

    paddedInput.getChannelData(0).set(input, leftPadding);

    // Use the padded buffer as the input view's media source too, so its
    // playhead and click-to-seek match the displayed time alignment.
    await setWaveform("input", paddedInput);

    // Display the output waveform.
    await setWaveform("output", outputBuffer);
}

function findImpulsePeakIndex(samples) {
    let peakIndex = 0;
    let peakMagnitude = 0;

    for (let index = 0; index < samples.length; index += 1) {
        const magnitude = Math.abs(samples[index]);

        if (magnitude > peakMagnitude) {
            peakMagnitude = magnitude;
            peakIndex = index;
        }
    }

    return peakIndex;
}

// File selection.
document.getElementById("input-file").addEventListener("change", event => {
    loadFile(event.target.files[0], "input");
});

document.getElementById("ir-file").addEventListener("change", event => {
    loadFile(event.target.files[0], "ir");
});

// Playback.
document.getElementById("play-input").addEventListener("click", async () => {
    if (!inputBuffer) return;

    await playWaveform("input");
});

document.getElementById("play-ir").addEventListener("click", async () => {
    if (!irBuffer) return;

    await playWaveform("ir");
});


document.getElementById("play-output").addEventListener("click", async () => {
    if (!outputBuffer) return;

    await playWaveform("output");
});

const savedAudio = {
    input: () => inputBuffer,
    ir: () => irBuffer,
    output: () => outputBuffer
};

for (const [role, getBuffer] of Object.entries(savedAudio)) {
    saveButtons[role].addEventListener("click", () => {
        const buffer = getBuffer();
        if (!buffer) return;

        const filename = {
            input: "input-audio.wav",
            ir: "impulse-response.wav",
            output: "convolution-output.wav"
        }[role];

        downloadWav(buffer, filename);
    });

    document.getElementById(`stop-${role}`).addEventListener("click", stopAllWaveforms);
}

// Per-waveform zoom controls.
for (const role of ["ir", "input", "output"]) {
    document.getElementById(`${role}-zoom-in`).addEventListener("click", () => zoomIn(role));
    document.getElementById(`${role}-zoom-out`).addEventListener("click", () => zoomOut(role));
    document.getElementById(`${role}-reset-zoom`).addEventListener("click", () => resetZoom(role));
}

// Input/output synchronisation.
document.getElementById("link-views").addEventListener("change", event => {
    setLinkedViews(event.target.checked);
});
