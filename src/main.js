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

    // Match the canvas resolution to its displayed size.
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    canvas.width = width;
    canvas.height = height;

    ctx.clearRect(0, 0, width, height);

    ctx.beginPath();

    const middle = height / 2;
    const step = Math.max(1, Math.floor(samples.length / width));

    for (let x = 0; x < width; x++) {
        const index = x * step;

        if (index >= samples.length) break;

        const y = middle - samples[index] * middle;

        if (x === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
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