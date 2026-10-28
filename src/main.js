import { convolve, normalise } from "./convolution.js";
import {
    audioContext,
    loadAudioFile,
    playAudioBuffer
} from "./audio.js";

let inputBuffer = null;
let irBuffer = null;
let outputBuffer = null;

async function loadFile(file, role) {
    if (!file) return;

    try {
        const buffer = await loadAudioFile(file);

        if (role === "input") {
            inputBuffer = buffer;
        } else {
            irBuffer = buffer;
        }

        updateOutput();
    } catch (error) {
        console.error("Could not load audio:", error);
        alert("Could not load this audio file.");
    }
}

function updateOutput() {
    if (!inputBuffer || !irBuffer) return;

    // Initial version: process the first channel of each file.
    const input = inputBuffer.getChannelData(0);
    const impulse = irBuffer.getChannelData(0);

    const result = convolve(input, impulse);

    const safeResult = normalise(result);

    outputBuffer = audioContext.createBuffer(
        1,
        safeResult.length,
        inputBuffer.sampleRate
    );

    outputBuffer.copyToChannel(safeResult, 0);

        drawWaveform("input-waveform", input);
        drawWaveform("ir-waveform", impulse);
        drawWaveform("output-waveform", result);
}

function drawWaveform(canvasId, samples) {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext("2d");

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    // Use the full-resolution canvas for sharper rendering.
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, width, height);

    const padding = 10;
    const middle = height / 2;
    
    let peak = 0;

    for (const sample of samples) {
        peak = Math.max(peak, Math.abs(sample));
    }

    const amplitudeScale =
        peak > 0 ? (height / 2 - padding) / peak : 1;


    // Draw the zero-amplitude centre line.
    ctx.beginPath();
    ctx.strokeStyle = "#cccccc";
    ctx.lineWidth = 1;
    ctx.moveTo(0, middle);
    ctx.lineTo(width, middle);
    ctx.stroke();

    if (!samples || samples.length === 0) return;

    // Display the whole signal across the canvas.
    const samplesPerPixel = samples.length / width;

    ctx.beginPath();
    ctx.strokeStyle = "#2878d0";
    ctx.lineWidth = 1;

    for (let x = 0; x < width; x++) {
        const start = Math.floor(x * samplesPerPixel);
        const end = Math.min(
            samples.length,
            Math.max(start + 1, Math.floor((x + 1) * samplesPerPixel))
        );

        // Find the minimum and maximum in this pixel's sample range.
        let min = Infinity;
        let max = -Infinity;

        for (let i = start; i < end; i++) {
            min = Math.min(min, samples[i]);
            max = Math.max(max, samples[i]);
        }

        if (min === Infinity) continue;

        const yTop = middle - max * amplitudeScale;
        const yBottom = middle - min * amplitudeScale;

        ctx.moveTo(x, yTop);
        ctx.lineTo(x, yBottom);
    }

    ctx.stroke();
}

document.getElementById("input-file").addEventListener("change", event => {
    loadFile(event.target.files[0], "input");
});

document.getElementById("ir-file").addEventListener("change", event => {
    loadFile(event.target.files[0], "ir");
});

document.getElementById("play-input").addEventListener("click", async () => {
    if (!inputBuffer) return;

    await audioContext.resume();
    playAudioBuffer(inputBuffer);
});

document.getElementById("play-ir").addEventListener("click", async () => {
    if (!irBuffer) return;

    await audioContext.resume();
    playAudioBuffer(irBuffer);
});

document.getElementById("play-output").addEventListener("click", async () => {
    if (!outputBuffer) return;

    await audioContext.resume();
    playAudioBuffer(outputBuffer);
});
