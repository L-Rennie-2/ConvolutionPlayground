import { audioContext, createWavBlob, downloadWav } from "./audio.js?v=2";

const byId = id => document.getElementById(id);
let curve = new Float32Array(512);
let drawingCurve = false;
let lastCurvePoint = null;
let generatedBuffer = null;

function nextPowerOfTwo(value) {
    let size = 1;
    while (size < value) size *= 2;
    return size;
}

function fft(real, imag, inverse = false) {
    const length = real.length;
    let j = 0;

    for (let i = 1; i < length; i += 1) {
        let bit = length >> 1;
        while (j & bit) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
    }

    for (let size = 2; size <= length; size *= 2) {
        const angle = (inverse ? 2 : -2) * Math.PI / size;
        const stepReal = Math.cos(angle);
        const stepImag = Math.sin(angle);
        const half = size / 2;

        for (let start = 0; start < length; start += size) {
            let wr = 1;
            let wi = 0;
            for (let k = 0; k < half; k += 1) {
                const even = start + k;
                const odd = even + half;
                const tr = wr * real[odd] - wi * imag[odd];
                const ti = wr * imag[odd] + wi * real[odd];
                real[odd] = real[even] - tr;
                imag[odd] = imag[even] - ti;
                real[even] += tr;
                imag[even] += ti;

                const nextWr = wr * stepReal - wi * stepImag;
                wi = wr * stepImag + wi * stepReal;
                wr = nextWr;
            }
        }
    }

    if (inverse) {
        for (let i = 0; i < length; i += 1) {
            real[i] /= length;
            imag[i] /= length;
        }
    }
}

function responseToImpulse(length, sampleRate, responseAtFrequency, outputLength = length) {
    const real = new Float64Array(length);
    const imag = new Float64Array(length);
    const half = length / 2;

    for (let bin = 0; bin <= half; bin += 1) {
        const frequency = bin * sampleRate / length;
        const [re, im] = responseAtFrequency(frequency);
        real[bin] = re;
        imag[bin] = im;
        if (bin > 0 && bin < half) {
            real[length - bin] = re;
            imag[length - bin] = -im;
        }
    }

    fft(real, imag, true);
    // Rotate the circular zero-time response to make a causal, centered IR.
    const samples = new Float32Array(outputLength);
    const firstIndex = (length - Math.floor(outputLength / 2)) % length;
    for (let i = 0; i < outputLength; i += 1) {
        samples[i] = real[(firstIndex + i) % length];
    }
    return samples;
}

function gainAtFrequency(frequency, gains) {
    const minFrequency = 20;
    const maxFrequency = Math.min(20000, audioContext.sampleRate / 2);
    if (frequency <= minFrequency) return gains[0];
    if (frequency >= maxFrequency) return gains[gains.length - 1];
    const position = Math.log(frequency / minFrequency) /
        Math.log(maxFrequency / minFrequency) * (gains.length - 1);
    const lower = Math.floor(position);
    const fraction = position - lower;
    return gains[lower] * (1 - fraction) + gains[lower + 1] * fraction;
}

function drawEqGraph() {
    const canvas = byId("eq-graph");
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = rect.width;
    const height = rect.height;
    const left = 48;
    const right = 14;
    const top = 14;
    const bottom = 32;
    const graphWidth = width - left - right;
    const graphHeight = height - top - bottom;
    const minDb = -24;
    const maxDb = 24;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, width, height);
    ctx.font = "11px Arial";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "#334155";
    ctx.fillStyle = "#cbd5e1";

    for (const db of [-24, -12, 0, 12, 24]) {
        const y = top + (maxDb - db) / (maxDb - minDb) * graphHeight;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(width - right, y);
        ctx.stroke();
        ctx.fillText(`${db} dB`, 5, y);
    }

    const frequencies = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    for (const frequency of frequencies) {
        const x = left + Math.log(frequency / 20) / Math.log(1000) * graphWidth;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + graphHeight);
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(frequency >= 1000 ? `${frequency / 1000}k` : `${frequency}`, x, top + graphHeight + 6);
    }

    ctx.beginPath();
    for (let i = 0; i < curve.length; i += 1) {
        const x = left + i / (curve.length - 1) * graphWidth;
        const y = top + (maxDb - curve[i]) / (maxDb - minDb) * graphHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineWidth = 1;
}

function graphPoint(event) {
    const rect = byId("eq-graph").getBoundingClientRect();
    const left = 48;
    const right = 14;
    const top = 14;
    const bottom = 32;
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left - left) / (rect.width - left - right)));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top - top) / (rect.height - top - bottom)));
    return {
        index: Math.round(x * (curve.length - 1)),
        db: (1 - y) * 48 - 24
    };
}

function drawCurveBetween(first, second) {
    const low = Math.min(first.index, second.index);
    const high = Math.max(first.index, second.index);
    for (let i = low; i <= high; i += 1) {
        const span = second.index - first.index;
        const ratio = span === 0 ? 0 : (i - first.index) / span;
        curve[i] = first.db + (second.db - first.db) * ratio;
    }
    drawEqGraph();
}

const eqCanvas = byId("eq-graph");
eqCanvas.addEventListener("pointerdown", event => {
    drawingCurve = true;
    lastCurvePoint = graphPoint(event);
    drawCurveBetween(lastCurvePoint, lastCurvePoint);
    eqCanvas.setPointerCapture(event.pointerId);
});
eqCanvas.addEventListener("pointermove", event => {
    if (!drawingCurve) return;
    const next = graphPoint(event);
    drawCurveBetween(lastCurvePoint, next);
    lastCurvePoint = next;
});
eqCanvas.addEventListener("pointerup", () => { drawingCurve = false; lastCurvePoint = null; });
eqCanvas.addEventListener("pointercancel", () => { drawingCurve = false; lastCurvePoint = null; });
new ResizeObserver(drawEqGraph).observe(eqCanvas);
drawEqGraph();

byId("render-graphic").addEventListener("click", () => {
    const sampleRate = audioContext.sampleRate;
    const outputLength = Math.round(Number(byId("graphic-length").value) * sampleRate);
    const fftLength = nextPowerOfTwo(outputLength);
    const impulse = responseToImpulse(fftLength, sampleRate, frequency => {
        const gain = gainAtFrequency(frequency, curve);
        return [Math.pow(10, gain / 20), 0];
    }, outputLength);

    generatedBuffer = audioContext.createBuffer(1, impulse.length, sampleRate);
    generatedBuffer.copyToChannel(impulse, 0);
    const preview = byId("graphic-preview");
    const previousUrl = preview.dataset.url;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    const url = URL.createObjectURL(createWavBlob(generatedBuffer));
    preview.dataset.url = url;
    preview.src = url;
    preview.load();
    byId("save-graphic").disabled = false;
});

byId("save-graphic").addEventListener("click", () => {
    if (generatedBuffer) downloadWav(generatedBuffer, "graphic-eq-impulse-response.wav");
});
